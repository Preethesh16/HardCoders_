import { readFile } from "node:fs/promises";

import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { AppFactory } from "@algorandfoundation/algokit-utils/types/app-factory";
import algosdk from "algosdk";
import { z } from "zod";

import { LOCALNET_DEMO_ASSET, assertNotDeniedNetwork } from "./networks.js";

const uint64 = z.preprocess(
  // Leave a missing value untouched so Zod reports the field as required
  // instead of throwing an opaque BigInt conversion error before validation.
  (value) => value === undefined || value === "" ? value : BigInt(String(value)),
  z.bigint().positive().max((1n << 64n) - 1n),
);

const deployEnvironmentSchema = z.object({
  ALGORAND_DEPLOY_CONFIRM: z.literal("DEPLOY_LOCALNET_ESCROW"),
  ALGORAND_DEPLOY_ALGOD_URL: z.string().url(),
  ALGORAND_DEPLOY_ALGOD_TOKEN: z.string().max(4_096).default(""),
  ALGORAND_DEPLOY_GENESIS_HASH: z.string().min(16).max(256),
  // Optional: reuse an existing LocalNet ASA. When omitted the deployer mints
  // the zero-value OptiUSD-DEMO settlement asset with USDC's six decimals.
  ALGORAND_DEPLOY_ASSET_ID: uint64.optional(),
  ALGORAND_DEPLOY_EXECUTOR_ADDRESS: z.string().refine(algosdk.isValidAddress, "Invalid executor address."),
  ALGORAND_DEPLOY_EXECUTOR_PRIVATE_KEY_BASE64: z.string().min(80).max(128).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  ALGORAND_DEPLOY_APP_FUNDING_MICROALGOS: z.preprocess(
    (value) => BigInt(String(value ?? "5000000")),
    z.bigint().min(1_000_000n).max(100_000_000n),
  ),
}).strip();

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "::1" || /^127(?:\.[0-9]{1,3}){3}$/u.test(url.hostname);
}

const environment = deployEnvironmentSchema.parse(process.env);
const algodUrl = new URL(environment.ALGORAND_DEPLOY_ALGOD_URL);
if (!/^https?:$/u.test(algodUrl.protocol)
  || algodUrl.username || algodUrl.password || algodUrl.search || algodUrl.hash
  || !isLoopback(algodUrl)) {
  throw new Error("The LocalNet deployer accepts only an explicit loopback HTTP(S) Algod URL without credentials, query, or fragment.");
}

const privateKey = Buffer.from(environment.ALGORAND_DEPLOY_EXECUTOR_PRIVATE_KEY_BASE64, "base64");
if (privateKey.length !== 64
  || algosdk.encodeAddress(privateKey.subarray(32)).toString() !== environment.ALGORAND_DEPLOY_EXECUTOR_ADDRESS) {
  throw new Error("The deployer private key must be 64 bytes and match ALGORAND_DEPLOY_EXECUTOR_ADDRESS.");
}

const account: algosdk.Account = {
  addr: algosdk.Address.fromString(environment.ALGORAND_DEPLOY_EXECUTOR_ADDRESS),
  sk: privateKey,
};
const signer = algosdk.makeBasicAccountTransactionSigner(account);
const algod = new algosdk.Algodv2(
  environment.ALGORAND_DEPLOY_ALGOD_TOKEN,
  algodUrl.origin,
  algodUrl.pathname === "/" ? "" : algodUrl.pathname,
);
const params = await algod.getTransactionParams().do();
if (Buffer.from(params.genesisHash ?? []).toString("base64") !== environment.ALGORAND_DEPLOY_GENESIS_HASH) {
  throw new Error("Algod genesis does not match ALGORAND_DEPLOY_GENESIS_HASH.");
}
// A real-value genesis is refused even here, where only loopback is reachable.
assertNotDeniedNetwork(environment.ALGORAND_DEPLOY_GENESIS_HASH, params.genesisID);

const appSpec = await readFile(
  new URL("../contracts/artifacts/OptiWorkEscrow.arc56.json", import.meta.url),
  "utf8",
);
const algorand = AlgorandClient.fromClients({ algod })
  .setSigner(environment.ALGORAND_DEPLOY_EXECUTOR_ADDRESS, signer)
  .setDefaultSigner(signer)
  .setDefaultValidityWindow(100);

// LocalNet mints a fresh chain on every reset, so the demo settlement asset is
// created per environment. Its six decimals match USDC, which keeps every
// fixed-point amount identical between LocalNet and TestNet.
let assetCreateTransactionId: string | null = null;
let assetId: bigint;
if (environment.ALGORAND_DEPLOY_ASSET_ID === undefined) {
  const createdAsset = await algorand.send.assetCreate({
    sender: account.addr,
    signer,
    total: LOCALNET_DEMO_ASSET.total,
    decimals: LOCALNET_DEMO_ASSET.decimals,
    assetName: LOCALNET_DEMO_ASSET.assetName,
    unitName: LOCALNET_DEMO_ASSET.unitName,
    defaultFrozen: false,
    maxRoundsToWaitForConfirmation: 20,
    suppressLog: true,
  });
  assetId = createdAsset.assetId;
  assetCreateTransactionId = createdAsset.txIds.at(-1) ?? null;
} else {
  const existing = await algod.getAssetByID(environment.ALGORAND_DEPLOY_ASSET_ID).do();
  if (existing.params?.decimals !== LOCALNET_DEMO_ASSET.decimals) {
    throw new Error(`LocalNet settlement asset ${environment.ALGORAND_DEPLOY_ASSET_ID} must have six decimals.`);
  }
  assetId = environment.ALGORAND_DEPLOY_ASSET_ID;
}
const factory = new AppFactory({
  algorand,
  appSpec,
  appName: "OptiWorkEscrow",
  defaultSender: account.addr,
  defaultSigner: signer,
});

const created = await factory.send.create({
  method: "createApplication",
  args: [assetId],
  sender: account.addr,
  signer,
  maxRoundsToWaitForConfirmation: 20,
  suppressLog: true,
});
const funded = await created.appClient.send.fundAppAccount({
  amount: AlgoAmount.MicroAlgo(environment.ALGORAND_DEPLOY_APP_FUNDING_MICROALGOS),
  sender: account.addr,
  signer,
  maxRoundsToWaitForConfirmation: 20,
  suppressLog: true,
});
const optedIn = await created.appClient.send.call({
  method: "optInAsset",
  args: [],
  sender: account.addr,
  signer,
  assetReferences: [assetId],
  maxFee: AlgoAmount.MicroAlgo(2_000n),
  coverAppCallInnerTransactionFees: true,
  maxRoundsToWaitForConfirmation: 20,
  suppressLog: true,
});

process.stdout.write(`${JSON.stringify({
  schemaVersion: "1.0",
  network: "localnet",
  genesisHash: environment.ALGORAND_DEPLOY_GENESIS_HASH,
  applicationId: created.result.appId.toString(),
  applicationAddress: created.result.appAddress.toString(),
  assetId: assetId.toString(),
  assetName: LOCALNET_DEMO_ASSET.assetName,
  assetUnitName: LOCALNET_DEMO_ASSET.unitName,
  assetDecimals: LOCALNET_DEMO_ASSET.decimals,
  assetValueStatement: "Zero-value LocalNet demonstration asset. Not redeemable, no monetary value.",
  assetCreateTransactionId,
  executorAddress: environment.ALGORAND_DEPLOY_EXECUTOR_ADDRESS,
  appFundingMicroAlgos: environment.ALGORAND_DEPLOY_APP_FUNDING_MICROALGOS.toString(),
  createTransactionId: created.result.txIds.at(-1),
  fundingTransactionId: funded.txIds.at(-1),
  optInTransactionId: optedIn.txIds.at(-1),
}, null, 2)}\n`);
