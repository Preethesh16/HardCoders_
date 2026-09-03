/**
 * Creates the complete zero-value settlement deployment used by OptiWork.
 *
 * The public manifest contains addresses and deployment identifiers only. The
 * separate owner-only secrets file is consumed by the executor and is ignored
 * by git. Running this against anything except loopback LocalNet is refused.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { AppFactory } from "@algorandfoundation/algokit-utils/types/app-factory";
import algosdk from "algosdk";

import { LOCALNET_DEMO_ASSET, assertNotDeniedNetwork } from "./networks.js";

const stateDirectory = resolve(process.env.OPTIWORK_LOCAL_STATE_DIR ?? "../../.optiwork/localnet");
const algodUrl = new URL(process.env.ALGORAND_DEPLOY_ALGOD_URL ?? "http://127.0.0.1:4001");
if (algodUrl.hostname !== "127.0.0.1" && algodUrl.hostname !== "localhost" && algodUrl.hostname !== "::1") {
  throw new Error("OptiWork LocalNet bootstrap accepts only a loopback Algod endpoint.");
}

const algorand = AlgorandClient.defaultLocalNet().setDefaultValidityWindow(100);
const algod = algorand.client.algod;
const params = await algod.getTransactionParams().do();
const genesisHash = Buffer.from(params.genesisHash ?? []).toString("base64");
assertNotDeniedNetwork(genesisHash, params.genesisID);

const accounts = {
  executor: algosdk.generateAccount(),
  inwardOrigin: algosdk.generateAccount(),
  inwardDestination: algosdk.generateAccount(),
  outwardOrigin: algosdk.generateAccount(),
  outwardDestination: algosdk.generateAccount(),
};
const signers = Object.fromEntries(Object.entries(accounts).map(([name, account]) => [
  name,
  algosdk.makeBasicAccountTransactionSigner(account),
])) as Record<keyof typeof accounts, algosdk.TransactionSigner>;
for (const [name, account] of Object.entries(accounts) as Array<[keyof typeof accounts, algosdk.Account]>) {
  algorand.setSigner(account.addr, signers[name]);
}

const dispenser = await algorand.account.localNetDispenser();
for (const account of Object.values(accounts)) {
  await algorand.send.payment({
    sender: dispenser.addr,
    signer: dispenser.signer,
    receiver: account.addr,
    amount: AlgoAmount.Algo(25),
    maxRoundsToWaitForConfirmation: 20,
    suppressLog: true,
  });
}

const asset = await algorand.send.assetCreate({
  sender: accounts.inwardOrigin.addr,
  signer: signers.inwardOrigin,
  total: LOCALNET_DEMO_ASSET.total,
  decimals: LOCALNET_DEMO_ASSET.decimals,
  assetName: LOCALNET_DEMO_ASSET.assetName,
  unitName: LOCALNET_DEMO_ASSET.unitName,
  defaultFrozen: false,
  maxRoundsToWaitForConfirmation: 20,
  suppressLog: true,
});
const assetId = asset.assetId;
for (const name of ["inwardDestination", "outwardOrigin", "outwardDestination"] as const) {
  await algorand.send.assetOptIn({
    sender: accounts[name].addr,
    signer: signers[name],
    assetId,
    maxRoundsToWaitForConfirmation: 20,
    suppressLog: true,
  });
}
const outwardAllocation = LOCALNET_DEMO_ASSET.total / 2n;
await algorand.send.assetTransfer({
  sender: accounts.inwardOrigin.addr,
  signer: signers.inwardOrigin,
  receiver: accounts.outwardOrigin.addr,
  assetId,
  amount: outwardAllocation,
  maxRoundsToWaitForConfirmation: 20,
  suppressLog: true,
});

const appSpec = await (await import("node:fs/promises")).readFile(
  new URL("../contracts/artifacts/OptiWorkEscrow.arc56.json", import.meta.url),
  "utf8",
);
const factory = new AppFactory({
  algorand,
  appSpec,
  appName: "OptiWorkEscrowLocalNet",
  defaultSender: accounts.executor.addr,
  defaultSigner: signers.executor,
});
const created = await factory.send.create({
  method: "createApplication",
  args: [assetId],
  sender: accounts.executor.addr,
  signer: signers.executor,
  maxRoundsToWaitForConfirmation: 20,
  suppressLog: true,
});
await created.appClient.send.fundAppAccount({
  amount: AlgoAmount.Algo(10),
  sender: accounts.executor.addr,
  signer: signers.executor,
  maxRoundsToWaitForConfirmation: 20,
  suppressLog: true,
});
await created.appClient.send.call({
  method: "optInAsset",
  args: [],
  sender: accounts.executor.addr,
  signer: signers.executor,
  assetReferences: [assetId],
  maxFee: AlgoAmount.MicroAlgo(2_000),
  coverAppCallInnerTransactionFees: true,
  maxRoundsToWaitForConfirmation: 20,
  suppressLog: true,
});

const manifest = {
  schemaVersion: "1.0",
  network: "localnet",
  genesisHash,
  applicationId: created.result.appId.toString(),
  applicationAddress: created.result.appAddress.toString(),
  assetId: Number(assetId),
  assetName: LOCALNET_DEMO_ASSET.assetName,
  assetDecimals: LOCALNET_DEMO_ASSET.decimals,
  executorAddress: accounts.executor.addr.toString(),
  providers: {
    "PL-IN-INWARD": {
      originAddress: accounts.inwardOrigin.addr.toString(),
      destinationAddress: accounts.inwardDestination.addr.toString(),
    },
    "IN-GB-OUTWARD": {
      originAddress: accounts.outwardOrigin.addr.toString(),
      destinationAddress: accounts.outwardDestination.addr.toString(),
    },
  },
  valueStatement: "Zero-value LocalNet demonstration asset. Not redeemable and has no monetary value.",
};
const accountDocument = Object.fromEntries(Object.entries(accounts).map(([name, account]) => [name, {
  address: account.addr.toString(),
  privateKeyBase64: Buffer.from(account.sk).toString("base64"),
}]));

await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await writeFile(resolve(stateDirectory, "algorand-deployment.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await writeFile(resolve(stateDirectory, "algorand-accounts.json"), `${JSON.stringify(accountDocument, null, 2)}\n`, { mode: 0o600 });
await chmod(resolve(stateDirectory, "algorand-deployment.json"), 0o600);
await chmod(resolve(stateDirectory, "algorand-accounts.json"), 0o600);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
