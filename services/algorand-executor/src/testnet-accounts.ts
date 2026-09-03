/**
 * Disposable Algorand TestNet account material.
 *
 * These accounts exist only to demonstrate the escrow lifecycle with dummy
 * TestAlgos. They are generated locally, written to a single ignored file with
 * owner-only permissions, and never transmitted anywhere. No mnemonic or
 * private key is ever printed to stdout, written to a manifest, returned by an
 * HTTP route, or committed.
 */

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import algosdk from "algosdk";
import { z } from "zod";

/** Fabric organization IDs of the three governed seller organizations. */
export const SELLER_ORGANIZATION_IDS = Object.freeze([
  "ORG-SELL-001",
  "ORG-SELL-002",
  "ORG-SELL-003",
] as const);

export type SellerOrganizationId = (typeof SELLER_ORGANIZATION_IDS)[number];

const addressSchema = z.string().refine((value) => algosdk.isValidAddress(value), "Invalid Algorand address.");
const privateKeySchema = z.string().min(80).max(128).regex(/^[A-Za-z0-9+/]+={0,2}$/u);

const accountSchema = z.object({
  address: addressSchema,
  privateKeyBase64: privateKeySchema,
}).strict();

export const testnetAccountFileSchema = z.object({
  schemaVersion: z.literal("1.0"),
  network: z.literal("testnet"),
  genesisId: z.literal("testnet-v1.0"),
  createdAt: z.string().datetime({ offset: true }),
  warning: z.string().min(1),
  deployer: accountSchema,
  originProviderTreasury: accountSchema,
  sellers: z.object({
    "ORG-SELL-001": accountSchema,
    "ORG-SELL-002": accountSchema,
    "ORG-SELL-003": accountSchema,
  }).strict(),
}).strict();

export type TestnetAccountFile = z.infer<typeof testnetAccountFileSchema>;
export type TestnetAccount = z.infer<typeof accountSchema>;

const WARNING =
  "DISPOSABLE ALGORAND TESTNET KEYS — DUMMY FUNDS ONLY. Never reuse on MainNet, never commit, never transmit.";

function accountDocument(account: algosdk.Account): TestnetAccount {
  return {
    address: account.addr.toString(),
    privateKeyBase64: Buffer.from(account.sk).toString("base64"),
  };
}

/** Generates a complete, mutually distinct disposable TestNet account set. */
export function generateAccountSet(now: Date = new Date()): TestnetAccountFile {
  const deployer = algosdk.generateAccount();
  const originProviderTreasury = algosdk.generateAccount();
  const sellers = SELLER_ORGANIZATION_IDS.map((organizationId) => [organizationId, algosdk.generateAccount()] as const);

  const file: TestnetAccountFile = {
    schemaVersion: "1.0",
    network: "testnet",
    genesisId: "testnet-v1.0",
    createdAt: now.toISOString(),
    warning: WARNING,
    deployer: accountDocument(deployer),
    originProviderTreasury: accountDocument(originProviderTreasury),
    sellers: Object.fromEntries(
      sellers.map(([organizationId, account]) => [organizationId, accountDocument(account)]),
    ) as TestnetAccountFile["sellers"],
  };
  assertDistinctAddresses(file);
  return testnetAccountFileSchema.parse(file);
}

/**
 * Every role must be a separate account. The executor and buyer treasury
 * separation is already enforced by the runtime configuration; enforcing it at
 * generation time stops an operator from creating material that can never load.
 */
export function assertDistinctAddresses(file: TestnetAccountFile): void {
  const addresses = publicAddresses(file);
  if (new Set(Object.values(addresses)).size !== Object.keys(addresses).length) {
    throw new Error("Every generated TestNet account must have a distinct address.");
  }
}

/** The only projection of the account file that may be logged or published. */
export function publicAddresses(file: TestnetAccountFile): Record<string, string> {
  return {
    deployer: file.deployer.address,
    originProviderTreasury: file.originProviderTreasury.address,
    ...Object.fromEntries(
      SELLER_ORGANIZATION_IDS.map((organizationId) => [organizationId, file.sellers[organizationId].address]),
    ),
  };
}

/**
 * Writes the account file with owner-only permissions and refuses to overwrite
 * an existing file, so a rerun can never destroy keys that already hold funded
 * TestNet balances.
 */
export async function writeAccountFile(path: string, file: TestnetAccountFile): Promise<void> {
  testnetAccountFileSchema.parse(file);
  assertDistinctAddresses(file);
  let exists = true;
  try {
    await stat(path);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new Error(`${path} already exists. Refusing to overwrite existing TestNet key material; move it aside deliberately.`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

/**
 * Reads the account file and fails closed when it is readable by anyone other
 * than its owner, so key material cannot be used from a world-readable path.
 */
export async function readAccountFile(path: string): Promise<TestnetAccountFile> {
  const info = await stat(path);
  // eslint-disable-next-line no-bitwise
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${path} must be readable only by its owner (chmod 600).`);
  }
  const parsed = testnetAccountFileSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  assertDistinctAddresses(parsed);
  return parsed;
}

/** Rebuilds a signing account, verifying the key matches its recorded address. */
export function toAlgosdkAccount(account: TestnetAccount, name: string): algosdk.Account {
  const secretKey = Buffer.from(account.privateKeyBase64, "base64");
  if (secretKey.length !== 64) throw new Error(`${name} private key must decode to exactly 64 bytes.`);
  if (algosdk.encodeAddress(secretKey.subarray(32)).toString() !== account.address) {
    throw new Error(`${name} private key does not match its recorded address.`);
  }
  return { addr: algosdk.Address.fromString(account.address), sk: new Uint8Array(secretKey) };
}
