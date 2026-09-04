/**
 * Keeps the already-deployed public TestNet application usable across repeated
 * hackathon demonstrations. Every new escrow/release record increases the
 * application's box minimum balance; this tops up only the pinned TestNet app
 * from the disposable origin-provider account when its free reserve is low.
 */

import { readFile } from "node:fs/promises";
import algosdk from "algosdk";
import { readAccountFile, toAlgosdkAccount } from "./testnet-accounts.js";
import { TESTNET_CONFIRMATION_ROUNDS } from "./testnet-constants.js";

const [accountsPath, manifestPath] = process.argv.slice(2);
if (!accountsPath || !manifestPath) {
  throw new Error("Usage: ensure-testnet-app-reserve <owner-only accounts JSON> <TestNet deployment manifest>");
}

const accounts = await readAccountFile(accountsPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  network?: string;
  applicationAddress?: string;
  providers?: Record<string, { originAddress?: string }>;
};
if (accounts.network !== "testnet" || accounts.genesisId !== "testnet-v1.0" || manifest.network !== "testnet") {
  throw new Error("Reserve replenishment is permitted only for the guarded Algorand TestNet deployment.");
}
const manifestOrigins = new Set(Object.values(manifest.providers ?? {}).map((provider) => provider.originAddress));
if (!manifest.applicationAddress || manifestOrigins.size !== 1 || !manifestOrigins.has(accounts.originProviderTreasury.address)) {
  throw new Error("The TestNet manifest does not match the owner-only origin treasury account.");
}

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const params = await algod.getTransactionParams().do();
if (params.genesisID !== "testnet-v1.0") throw new Error("The configured Algod endpoint is not TestNet.");

const application = await algod.accountInformation(manifest.applicationAddress).do();
const available = BigInt(application.amount) - BigInt(application.minBalance);
const targetReserve = 3_000_000n;
if (available >= targetReserve) {
  process.stdout.write(`application reserve ready: ${available} microAlgo available\n`);
  process.exit(0);
}

const treasury = toAlgosdkAccount(accounts.originProviderTreasury, "originProviderTreasury");
const treasuryInformation = await algod.accountInformation(treasury.addr).do();
const amount = targetReserve - available;
const treasuryAvailable = BigInt(treasuryInformation.amount) - BigInt(treasuryInformation.minBalance);
if (treasuryAvailable < amount + 10_000n) {
  throw new Error(`The disposable TestNet origin treasury needs ${amount} additional microAlgo for application box reserve.`);
}

const transaction = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: treasury.addr,
  receiver: manifest.applicationAddress,
  amount,
  suggestedParams: params,
});
const transactionId = transaction.txID();
await algod.sendRawTransaction(transaction.signTxn(treasury.sk)).do();
const confirmation = await algosdk.waitForConfirmation(algod, transactionId, TESTNET_CONFIRMATION_ROUNDS);
process.stdout.write(`application reserve replenished: ${amount} microAlgo; transaction ${transactionId}; round ${confirmation.confirmedRound}\n`);
