/**
 * One-shot generator for disposable Algorand TestNet accounts.
 *
 * Run:
 *   ALGORAND_TESTNET_ACCOUNTS_CONFIRM=GENERATE_TESTNET_ACCOUNTS \
 *   node --import tsx src/generate-testnet-accounts.ts
 *
 * Writes owner-only key material to an ignored path and prints **only** public
 * addresses plus the official zero-value dispenser instruction. It never prints
 * or returns a mnemonic or private key.
 */

import { resolve } from "node:path";

import { TESTNET_DISPENSER_URL, TESTNET_FUNDS_LABEL } from "./networks.js";
import {
  DEFAULT_TESTNET_ACCOUNTS_PATH,
  MINIMUM_DEPLOYER_FUNDING_ALGOS,
} from "./testnet-constants.js";
import { generateAccountSet, publicAddresses, writeAccountFile } from "./testnet-accounts.js";

if (process.env.ALGORAND_TESTNET_ACCOUNTS_CONFIRM !== "GENERATE_TESTNET_ACCOUNTS") {
  throw new Error("Set ALGORAND_TESTNET_ACCOUNTS_CONFIRM=GENERATE_TESTNET_ACCOUNTS to generate disposable TestNet accounts.");
}

const path = resolve(
  process.env.ALGORAND_TESTNET_ACCOUNTS_PATH?.trim()
    || new URL(`../${DEFAULT_TESTNET_ACCOUNTS_PATH}`, import.meta.url).pathname,
);

const accounts = generateAccountSet();
await writeAccountFile(path, accounts);

const addresses = publicAddresses(accounts);
process.stdout.write(`${JSON.stringify({
  label: TESTNET_FUNDS_LABEL,
  network: "testnet",
  genesisId: accounts.genesisId,
  createdAt: accounts.createdAt,
  keyMaterialPath: path,
  keyMaterialMode: "0600 (ignored by git; never commit)",
  publicAddresses: addresses,
  fundingRequired: {
    address: addresses.deployer,
    minimumAlgos: MINIMUM_DEPLOYER_FUNDING_ALGOS,
    dispenser: TESTNET_DISPENSER_URL,
    note: "Only the deployer needs dispenser funding. The deployer distributes dummy TestAlgos to the buyer treasury and the three seller accounts during deployment.",
  },
}, null, 2)}\n`);
