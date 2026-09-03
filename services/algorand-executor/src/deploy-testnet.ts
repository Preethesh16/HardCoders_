/**
 * Explicit, one-shot public Algorand **TestNet** deployer.
 *
 * This is deliberately a separate entrypoint from `deploy-localnet.ts`. The
 * LocalNet deployer accepts only loopback HTTP and is never reused for a public
 * network; this deployer accepts only public HTTPS and pins the exact TestNet
 * genesis identity. Each requires its own distinct confirmation token, so
 * neither can be silently repurposed into the other.
 *
 * Target: public Algorand TestNet with dummy TestAlgos that have no monetary
 * value. MainNet is refused by pinned genesis hash and genesis ID.
 *
 * Run:
 *   ALGORAND_DEPLOY_CONFIRM=DEPLOY_TESTNET_ESCROW \
 *   node --env-file-if-exists=.env.testnet --import tsx src/deploy-testnet.ts
 *
 * Secrets: signing keys are read only from the owner-only account file. No
 * mnemonic or private key is printed, written to the manifest, or committed.
 */

import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import { AppFactory } from "@algorandfoundation/algokit-utils/types/app-factory";
import algosdk from "algosdk";
import { z } from "zod";

import {
  ALGORAND_TESTNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_ID,
  TESTNET_DISPENSER_URL,
  TESTNET_FUNDS_LABEL,
  assertTestnetIdentity,
} from "./networks.js";
import {
  DEFAULT_APP_FUNDING_MICROALGOS,
  DEFAULT_TESTNET_ACCOUNTS_PATH,
  DEFAULT_TESTNET_MANIFEST_PATH,
  DEMO_ASSET_DECIMALS,
  DEMO_ASSET_TOTAL,
  DEMO_ASSET_UNIT_NAME,
  MINIMUM_DEPLOYER_FUNDING_ALGOS,
  MINIMUM_DEPLOYER_FUNDING_MICROALGOS,
  PARTICIPANT_FUNDING_MICROALGOS,
  TESTNET_CONFIRMATION_ROUNDS,
  explorerAccountUrl,
  explorerApplicationUrl,
  explorerAssetUrl,
  explorerTransactionUrl,
} from "./testnet-constants.js";
import {
  SELLER_ORGANIZATION_IDS,
  publicAddresses,
  readAccountFile,
  toAlgosdkAccount,
} from "./testnet-accounts.js";

const environmentSchema = z.object({
  ALGORAND_DEPLOY_CONFIRM: z.literal("DEPLOY_TESTNET_ESCROW"),
  ALGORAND_DEPLOY_ALGOD_URL: z.string().url().default("https://testnet-api.algonode.cloud"),
  ALGORAND_DEPLOY_ALGOD_TOKEN: z.string().max(4_096).default(""),
  ALGORAND_TESTNET_ACCOUNTS_PATH: z.string().min(1).optional(),
  ALGORAND_TESTNET_MANIFEST_PATH: z.string().min(1).optional(),
  ALGORAND_DEPLOY_APP_FUNDING_MICROALGOS: z.preprocess(
    (value) => value === undefined || value === "" ? DEFAULT_APP_FUNDING_MICROALGOS : BigInt(String(value)),
    z.bigint().min(500_000n).max(20_000_000n),
  ),
}).strip();

/** Public TestNet endpoints must be HTTPS, credential-free, and never loopback. */
function assertPublicHttpsEndpoint(raw: string): URL {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || loopback) {
    throw new Error("The TestNet deployer accepts only a public HTTPS Algod URL without credentials, query, or fragment.");
  }
  return url;
}

function confirmedTransactionId(result: { txIds?: readonly string[]; txId?: string }, label: string): string {
  const id = result.txIds?.at(-1) ?? result.txId;
  if (typeof id !== "string" || !/^[A-Z2-7]{52}$/u.test(id)) {
    throw new Error(`${label} did not return a canonical confirmed transaction ID.`);
  }
  return id;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 24) {
  throw new Error("TestNet deployment requires Node.js 24 or newer.");
}

const environment = environmentSchema.parse(process.env);
const algodUrl = assertPublicHttpsEndpoint(environment.ALGORAND_DEPLOY_ALGOD_URL);

const accountsPath = resolve(
  environment.ALGORAND_TESTNET_ACCOUNTS_PATH?.trim()
    || new URL(`../${DEFAULT_TESTNET_ACCOUNTS_PATH}`, import.meta.url).pathname,
);
const manifestPath = resolve(
  environment.ALGORAND_TESTNET_MANIFEST_PATH?.trim()
    || new URL(`../${DEFAULT_TESTNET_MANIFEST_PATH}`, import.meta.url).pathname,
);

// Refuse to deploy a second application over an existing manifest. A rerun must
// rediscover the recorded deployment instead of silently creating a duplicate.
let manifestExists = true;
try {
  await stat(manifestPath);
} catch {
  manifestExists = false;
}
if (manifestExists) {
  const existing = JSON.parse(await readFile(manifestPath, "utf8")) as { applicationId?: string };
  throw new Error(
    `${manifestPath} already records TestNet application ${existing.applicationId ?? "(unknown)"}. `
    + "Refusing to deploy a duplicate application; move the manifest aside deliberately to redeploy.",
  );
}

const accounts = await readAccountFile(accountsPath);
const addresses = publicAddresses(accounts);
const deployer = toAlgosdkAccount(accounts.deployer, "deployer");
const originProviderTreasury = toAlgosdkAccount(accounts.originProviderTreasury, "originProviderTreasury");
const sellers = SELLER_ORGANIZATION_IDS.map(
  (organizationId) => [organizationId, toAlgosdkAccount(accounts.sellers[organizationId], organizationId)] as const,
);

const algod = new algosdk.Algodv2(
  environment.ALGORAND_DEPLOY_ALGOD_TOKEN,
  algodUrl.origin,
  algodUrl.pathname === "/" ? "" : algodUrl.pathname,
);

// Pin the exact public TestNet identity before any account is touched.
const params = await algod.getTransactionParams().do();
const observedGenesisHash = Buffer.from(params.genesisHash ?? []).toString("base64");
assertTestnetIdentity(observedGenesisHash, params.genesisID);

// Funding preflight. Deployment must not start partially and then strand funds.
const deployerInformation = await algod.accountInformation(deployer.addr).do();
const deployerBalance = BigInt(deployerInformation.amount);
if (deployerBalance < MINIMUM_DEPLOYER_FUNDING_MICROALGOS) {
  process.stderr.write(`${JSON.stringify({
    status: "BLOCKED_MANUAL",
    label: TESTNET_FUNDS_LABEL,
    reason: "The disposable TestNet deployer account holds insufficient dummy TestAlgos.",
    fundThisPublicAddress: deployer.addr.toString(),
    observedMicroAlgos: deployerBalance.toString(),
    requiredMicroAlgos: MINIMUM_DEPLOYER_FUNDING_MICROALGOS.toString(),
    requiredAlgos: MINIMUM_DEPLOYER_FUNDING_ALGOS,
    officialDispenser: TESTNET_DISPENSER_URL,
    note: "Request dummy TestAlgos from the official Algorand TestNet dispenser for the address above, then rerun this deployer. Never send real funds and never share a mnemonic.",
  }, null, 2)}\n`);
  process.exit(2);
}

const algorand = AlgorandClient.fromClients({ algod }).setDefaultValidityWindow(100);
for (const account of [deployer, originProviderTreasury, ...sellers.map(([, account]) => account)]) {
  algorand.setSigner(account.addr, algosdk.makeBasicAccountTransactionSigner(account));
}
const deployerSigner = algosdk.makeBasicAccountTransactionSigner(deployer);
const buyerSigner = algosdk.makeBasicAccountTransactionSigner(originProviderTreasury);

// Distribute dummy TestAlgos so only one address ever needs dispenser funding.
const distributionTransactionIds: Record<string, string> = {};
for (const [name, account] of [
  ["originProviderTreasury", originProviderTreasury] as const,
  ...sellers.map(([organizationId, account]) => [organizationId, account] as const),
]) {
  const existing = BigInt((await algod.accountInformation(account.addr).do()).amount);
  if (existing >= PARTICIPANT_FUNDING_MICROALGOS) continue;
  const payment = await algorand.send.payment({
    sender: deployer.addr,
    signer: deployerSigner,
    receiver: account.addr,
    amount: AlgoAmount.MicroAlgo(PARTICIPANT_FUNDING_MICROALGOS - existing),
    maxRoundsToWaitForConfirmation: TESTNET_CONFIRMATION_ROUNDS,
    suppressLog: true,
  });
  distributionTransactionIds[name] = confirmedTransactionId(payment, `${name} funding`);
}

// Zero-value demonstration settlement asset.
const assetCreate = await algorand.send.assetCreate({
  sender: originProviderTreasury.addr,
  signer: buyerSigner,
  total: DEMO_ASSET_TOTAL,
  decimals: DEMO_ASSET_DECIMALS,
  assetName: "Anchor Demo USD",
  unitName: DEMO_ASSET_UNIT_NAME,
  defaultFrozen: false,
  maxRoundsToWaitForConfirmation: TESTNET_CONFIRMATION_ROUNDS,
  suppressLog: true,
});
const assetId = assetCreate.assetId;
const assetCreateTransactionId = confirmedTransactionId(assetCreate, "demonstration asset creation");

const sellerOptInTransactionIds: Record<string, string> = {};
for (const [organizationId, seller] of sellers) {
  const optedIn = await algorand.send.assetOptIn({
    sender: seller.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(seller),
    assetId,
    maxRoundsToWaitForConfirmation: TESTNET_CONFIRMATION_ROUNDS,
    suppressLog: true,
  });
  sellerOptInTransactionIds[organizationId] = confirmedTransactionId(optedIn, `${organizationId} asset opt-in`);
}

const appSpec = await readFile(
  new URL("../contracts/artifacts/OptiWorkEscrow.arc56.json", import.meta.url),
  "utf8",
);
const factory = new AppFactory({
  algorand,
  appSpec,
  appName: "OptiWorkEscrowTestNet",
  defaultSender: deployer.addr,
  defaultSigner: deployerSigner,
});
const created = await factory.send.create({
  method: "createApplication",
  args: [assetId],
  sender: deployer.addr,
  signer: deployerSigner,
  maxRoundsToWaitForConfirmation: TESTNET_CONFIRMATION_ROUNDS,
  suppressLog: true,
});
const funded = await created.appClient.send.fundAppAccount({
  amount: AlgoAmount.MicroAlgo(environment.ALGORAND_DEPLOY_APP_FUNDING_MICROALGOS),
  sender: deployer.addr,
  signer: deployerSigner,
  maxRoundsToWaitForConfirmation: TESTNET_CONFIRMATION_ROUNDS,
  suppressLog: true,
});
const optedIn = await created.appClient.send.call({
  method: "optInAsset",
  args: [],
  sender: deployer.addr,
  signer: deployerSigner,
  assetReferences: [assetId],
  maxFee: AlgoAmount.MicroAlgo(2_000n),
  coverAppCallInnerTransactionFees: true,
  maxRoundsToWaitForConfirmation: TESTNET_CONFIRMATION_ROUNDS,
  suppressLog: true,
});

const applicationId = created.result.appId.toString();
const createTransactionId = confirmedTransactionId(created.result, "application creation");
const fundingTransactionId = confirmedTransactionId(funded, "application funding");
const optInTransactionId = confirmedTransactionId(optedIn, "application asset opt-in");

// Sanitized, publishable manifest. Public identifiers and addresses only.
const manifest = {
  schemaVersion: "1.0",
  label: TESTNET_FUNDS_LABEL,
  network: "testnet" as const,
  genesisId: ALGORAND_TESTNET_GENESIS_ID,
  genesisHash: ALGORAND_TESTNET_GENESIS_HASH,
  algodUrl: algodUrl.origin,
  deployedAt: new Date().toISOString(),
  applicationId,
  applicationAddress: created.result.appAddress.toString(),
  assetId: assetId.toString(),
  assetUnitName: DEMO_ASSET_UNIT_NAME,
  assetValueStatement: "Zero-value demonstration settlement asset. Not redeemable, not a security, no monetary value.",
  publicAddresses: addresses,
  applicationFundingMicroAlgos: environment.ALGORAND_DEPLOY_APP_FUNDING_MICROALGOS.toString(),
  transactions: {
    participantFunding: distributionTransactionIds,
    assetCreate: assetCreateTransactionId,
    sellerAssetOptIns: sellerOptInTransactionIds,
    applicationCreate: createTransactionId,
    applicationFunding: fundingTransactionId,
    applicationAssetOptIn: optInTransactionId,
  },
  confirmedRounds: {
    applicationCreate: created.result.confirmation?.confirmedRound?.toString() ?? null,
    applicationFunding: funded.confirmations?.at(-1)?.confirmedRound?.toString() ?? null,
    applicationAssetOptIn: optedIn.confirmations?.at(-1)?.confirmedRound?.toString() ?? null,
    assetCreate: assetCreate.confirmation?.confirmedRound?.toString() ?? null,
  },
  explorer: {
    application: explorerApplicationUrl(applicationId),
    asset: explorerAssetUrl(assetId.toString()),
    applicationAccount: explorerAccountUrl(created.result.appAddress.toString()),
    deployerAccount: explorerAccountUrl(accounts.deployer.address),
    applicationCreateTransaction: explorerTransactionUrl(createTransactionId),
    assetCreateTransaction: explorerTransactionUrl(assetCreateTransactionId),
  },
};

await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
