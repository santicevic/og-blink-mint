import { ACTIONS_CORS_HEADERS, ActionGetResponse, ActionPostRequest, ActionPostResponse, createPostResponse } from '@solana/actions'
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { createGenericFile, createNoopSigner, createSignerFromKeypair, publicKey, signerIdentity } from '@metaplex-foundation/umi'
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys'
import { create, fetchCollection, mplCore, getAssetV1GpaBuilder, Key, updateAuthority } from '@metaplex-foundation/mpl-core'
import fs from 'fs'
import path from 'path'
import { toWeb3JsPublicKey, toWeb3JsInstruction, toWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters'
import bs58 from 'bs58'
import { ENCRYPTED_NFTS } from '@/app/constants/encrypted'
import { createBurnCheckedInstruction, getAssociatedTokenAddress } from '@solana/spl-token'
import { decryptData } from '@/app/utils/encrypt'
import { NftItem } from '@/app/types/Nft'

const collectionAddress = publicKey('8kMLNM2TGXRu9drhceN3ZxqoDPYWgcjZJBr9HiCUfxzn')
const splMint = publicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')
const splBurnAmount = 1000000000

const umi = createUmi(process.env.RPC_URL!).use(mplCore()).use(irysUploader())
const signer = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(bs58.decode(process.env.SIGNER_PK!)))
umi.use(signerIdentity(signer, true))

export const GET = (req: Request) => {
  const payload: ActionGetResponse = {
    icon: new URL('/solbound.png', new URL(req.url).origin).toString(),
    label: 'MINT',
    description: 'Burn 200k $BONK to get a Solbound OG collection NFT',
    title: 'Mint a Solbound.dev OG'
  }

  return Response.json(payload, {
    headers: ACTIONS_CORS_HEADERS
  })
}

export const OPTIONS = GET

export const POST = async (req: Request) => {
  try {
    const mintedAssets = await getAssetV1GpaBuilder(umi)
      .whereField('key', Key.AssetV1)
      .whereField('updateAuthority', updateAuthority('Collection', [collectionAddress]))
      .getDeserialized()

    const nfts: NftItem[] = JSON.parse(decryptData(ENCRYPTED_NFTS))

    const nftToMint = nfts.find(
      (nft) =>
        !mintedAssets.some(({ publicKey }) => toWeb3JsPublicKey(publicKey).equals(Keypair.fromSecretKey(bs58.decode(nft.pk)).publicKey))
    )

    if (!nftToMint) {
      return Response.json('All NFTS have been minted', { status: 400, headers: ACTIONS_CORS_HEADERS })
    }

    const imagePath = path.join(process.cwd(), 'public', nftToMint.image)
    const png = fs.readFileSync(imagePath)

    const body: ActionPostRequest = await req.json()

    let account: PublicKey
    try {
      account = new PublicKey(body.account)
    } catch (error) {
      return new Response('Invalid account provided', {
        status: 400,
        headers: ACTIONS_CORS_HEADERS
      })
    }

    const img = createGenericFile(png, 'solbound.png', { contentType: 'image/png' })
    const assetSigner = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(bs58.decode(nftToMint.pk)))

    const [imageUri] = await umi.uploader.upload([img])

    const uri = await umi.uploader.uploadJson({
      name: nftToMint.name,
      description: 'Solbound OG Collection',
      image: imageUri
    })

    const collection = await fetchCollection(umi, collectionAddress)

    const payer = createNoopSigner(publicKey(account.toBase58()))

    const umiInstructions = await create(umi, {
      asset: assetSigner,
      collection,
      name: nftToMint.name,
      uri,
      payer,
      owner: publicKey(account.toBase58()),
      authority: signer,
      plugins: [
        {
          type: 'Attributes',
          attributeList: [{ key: 'Rarity', value: nftToMint.type }]
        }
      ]
    }).getInstructions()

    const splAta = await getAssociatedTokenAddress(toWeb3JsPublicKey(splMint), account)
    const instructions = umiInstructions.map(toWeb3JsInstruction)
    instructions.push(
      createBurnCheckedInstruction(splAta, toWeb3JsPublicKey(splMint), account, splBurnAmount, 9),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100 })
    )

    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: account,
        instructions,
        recentBlockhash: (await umi.rpc.getLatestBlockhash()).blockhash
      }).compileToV0Message()
    )

    transaction.sign([toWeb3JsKeypair(signer), toWeb3JsKeypair(assetSigner)])

    const payload: ActionPostResponse = {
      transaction: Buffer.from(transaction.serialize()).toString('base64')
    }

    return Response.json(payload, { headers: ACTIONS_CORS_HEADERS })
  } catch (error) {
    console.log(error)
    return Response.json('An error occurred', { status: 400, headers: ACTIONS_CORS_HEADERS })
  }
}
