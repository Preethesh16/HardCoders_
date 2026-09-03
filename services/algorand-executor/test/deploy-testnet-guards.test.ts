import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateAccountSet, writeAccountFile } from "../src/testnet-accounts.js";

const run = promisify(execFile);
const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const deployTestnet = join(packageRoot, "src/deploy-testnet.ts");
const deployLocalnet = join(packageRoot, "src/deploy-localnet.ts");

/**
 * Runs a deployer entrypoint with a controlled environment and returns its
 * failure text. The guards under test all reject before any network call, so
 * these cases never touch a public network.
 */
async function expectFailure(script: string, environment: NodeJS.ProcessEnv): Promise<string> {
  try {
    await run(process.execPath, ["--import", "tsx", script], {
      cwd: packageRoot,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_OPTIONS: "--no-warnings",
        ...environment,
      },
    });
  } catch (error) {
    return `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
  }
  throw new Error("The deployer was expected to fail but exited successfully.");
}

let directory: string;
let accountsPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "optiwork-testnet-deploy-"));
  accountsPath = join(directory, "testnet-accounts.json");
  await writeAccountFile(accountsPath, generateAccountSet());
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const baseEnvironment = () => ({
  ALGORAND_TESTNET_ACCOUNTS_PATH: accountsPath,
  ALGORAND_TESTNET_MANIFEST_PATH: join(directory, "manifest.json"),
});

describe("TestNet deployer guards", () => {
  it("requires its own explicit confirmation token", async () => {
    expect(await expectFailure(deployTestnet, baseEnvironment())).toMatch(/ALGORAND_DEPLOY_CONFIRM/u);
    expect(await expectFailure(deployTestnet, {
      ...baseEnvironment(),
      ALGORAND_DEPLOY_CONFIRM: "DEPLOY_LOCALNET_ESCROW",
    })).toMatch(/ALGORAND_DEPLOY_CONFIRM/u);
  }, 20_000);

  it("keeps the LocalNet deployer from accepting the TestNet token", async () => {
    expect(await expectFailure(deployLocalnet, {
      ALGORAND_DEPLOY_CONFIRM: "DEPLOY_TESTNET_ESCROW",
    })).toMatch(/ALGORAND_DEPLOY_CONFIRM/u);
  });

  it("refuses non-HTTPS, loopback, or credential-bearing public endpoints", async () => {
    for (const url of [
      "http://testnet-api.algonode.cloud",
      "https://127.0.0.1:4001",
      "https://localhost:4001",
      "https://user:secret@testnet-api.algonode.cloud",
      "https://testnet-api.algonode.cloud?token=abc",
    ]) {
      const output = await expectFailure(deployTestnet, {
        ...baseEnvironment(),
        ALGORAND_DEPLOY_CONFIRM: "DEPLOY_TESTNET_ESCROW",
        ALGORAND_DEPLOY_ALGOD_URL: url,
      });
      expect(output, `expected ${url} to be refused`).toMatch(/only a public HTTPS Algod URL/u);
    }
  }, 20_000);

  it("refuses to deploy a duplicate application over an existing manifest", async () => {
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ applicationId: "742000123" }), "utf8");
    const output = await expectFailure(deployTestnet, {
      ...baseEnvironment(),
      ALGORAND_DEPLOY_CONFIRM: "DEPLOY_TESTNET_ESCROW",
    });
    expect(output).toMatch(/742000123/u);
    expect(output).toMatch(/Refusing to deploy a duplicate application/u);
  });

  it("refuses key material that is readable beyond its owner", async () => {
    const { chmod } = await import("node:fs/promises");
    await chmod(accountsPath, 0o644);
    expect(await expectFailure(deployTestnet, {
      ...baseEnvironment(),
      ALGORAND_DEPLOY_CONFIRM: "DEPLOY_TESTNET_ESCROW",
    })).toMatch(/readable only by its owner/u);
  });

  it("never places signing material in the published manifest shape", async () => {
    const source = await readFile(deployTestnet, "utf8");
    const manifestBlock = source.slice(source.indexOf("const manifest = {"), source.indexOf("await mkdir(dirname(manifestPath)"));
    expect(manifestBlock.length).toBeGreaterThan(0);
    expect(manifestBlock).not.toMatch(/privateKey|\.sk\b|mnemonic|secretKey/iu);
    expect(manifestBlock).toMatch(/publicAddresses/u);
    // The deployer must never print key material on either stream.
    expect(source).not.toMatch(/process\.(stdout|stderr)\.write\([^)]*privateKey/iu);
  });
});
