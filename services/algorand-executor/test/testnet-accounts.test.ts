import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import algosdk from "algosdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SELLER_ORGANIZATION_IDS,
  generateAccountSet,
  publicAddresses,
  readAccountFile,
  toAlgosdkAccount,
  writeAccountFile,
} from "../src/testnet-accounts.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "anchor-testnet-accounts-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("disposable TestNet account material", () => {
  it("generates one distinct valid account per role", () => {
    const accounts = generateAccountSet();
    expect(accounts.network).toBe("testnet");
    expect(accounts.genesisId).toBe("testnet-v1.0");
    const addresses = publicAddresses(accounts);
    expect(Object.keys(addresses).sort()).toEqual(["ORG-SELL-001", "ORG-SELL-002", "ORG-SELL-003", "deployer", "originProviderTreasury"]);
    expect(new Set(Object.values(addresses)).size).toBe(5);
    for (const address of Object.values(addresses)) expect(algosdk.isValidAddress(address)).toBe(true);
    for (const organizationId of SELLER_ORGANIZATION_IDS) {
      expect(accounts.sellers[organizationId].address).toBe(addresses[organizationId]);
    }
  });

  it("never exposes signing material through the public projection", () => {
    const accounts = generateAccountSet();
    const serialized = JSON.stringify(publicAddresses(accounts));
    expect(serialized).not.toContain(accounts.deployer.privateKeyBase64);
    expect(serialized).not.toContain(accounts.originProviderTreasury.privateKeyBase64);
    expect(serialized).not.toMatch(/privateKey/iu);
  });

  it("writes owner-only key material and refuses to overwrite it", async () => {
    const path = join(directory, "nested", "testnet-accounts.json");
    const accounts = generateAccountSet();
    await writeAccountFile(path, accounts);

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ network: "testnet" });

    await expect(writeAccountFile(path, generateAccountSet())).rejects.toThrow(/Refusing to overwrite/u);
  });

  it("refuses to read key material that is readable beyond its owner", async () => {
    const path = join(directory, "loose.json");
    await writeAccountFile(path, generateAccountSet());
    await expect(readAccountFile(path)).resolves.toMatchObject({ network: "testnet" });

    await chmod(path, 0o644);
    await expect(readAccountFile(path)).rejects.toThrow(/readable only by its owner/u);
  });

  it("rejects a key file whose private key does not match its address", async () => {
    const accounts = generateAccountSet();
    const foreign = algosdk.generateAccount();
    expect(() => toAlgosdkAccount(
      { address: accounts.deployer.address, privateKeyBase64: Buffer.from(foreign.sk).toString("base64") },
      "deployer",
    )).toThrow(/does not match its recorded address/u);

    expect(() => toAlgosdkAccount(
      { address: accounts.deployer.address, privateKeyBase64: Buffer.alloc(64).toString("base64") },
      "deployer",
    )).toThrow(/does not match its recorded address/u);
  });

  it("rejects a structurally invalid or duplicated key file", async () => {
    const path = join(directory, "invalid.json");
    const accounts = generateAccountSet();
    await writeFile(path, JSON.stringify({
      ...accounts,
      originProviderTreasury: accounts.deployer,
    }), { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(readAccountFile(path)).rejects.toThrow(/distinct address/u);

    const missing = join(directory, "missing-field.json");
    const { deployer: _deployer, ...withoutDeployer } = accounts;
    await writeFile(missing, JSON.stringify(withoutDeployer), { mode: 0o600 });
    await chmod(missing, 0o600);
    await expect(readAccountFile(missing)).rejects.toThrow();
  });
});
