import { describe, expect, it } from "vitest";

import {
  ALGORAND_TESTNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_ID,
  assertNetworkGenesis,
  assertNotDeniedNetwork,
  assertTestnetIdentity,
  DENIED_GENESIS,
  TESTNET_FUNDS_LABEL,
} from "../src/networks.js";

const MAINNET_GENESIS_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const BETANET_GENESIS_HASH = "mFgazF+2uRS1tMiL9dsj01hJGySEmPN28B/TjjvpVW0=";
const LOCALNET_LIKE_GENESIS_HASH = Buffer.alloc(32, 7).toString("base64");

describe("pinned public Algorand network identities", () => {
  it("pins the exact public TestNet genesis identity", () => {
    expect(ALGORAND_TESTNET_GENESIS_ID).toBe("testnet-v1.0");
    expect(ALGORAND_TESTNET_GENESIS_HASH).toBe("SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");
    expect(TESTNET_FUNDS_LABEL).toBe("ALGORAND TESTNET — DUMMY FUNDS");
    expect(() => assertTestnetIdentity(ALGORAND_TESTNET_GENESIS_HASH, ALGORAND_TESTNET_GENESIS_ID)).not.toThrow();
  });

  it("refuses MainNet and BetaNet by genesis hash on every network mode", () => {
    expect(Object.keys(DENIED_GENESIS)).toContain(MAINNET_GENESIS_HASH);
    for (const network of ["localnet", "testnet"] as const) {
      expect(() => assertNetworkGenesis(network, MAINNET_GENESIS_HASH)).toThrow(/mainnet-v1\.0/u);
      expect(() => assertNetworkGenesis(network, BETANET_GENESIS_HASH)).toThrow(/betanet-v1\.0/u);
    }
    expect(() => assertNotDeniedNetwork(MAINNET_GENESIS_HASH)).toThrow(/zero-value funds/u);
  });

  it("refuses a denied genesis ID even when the hash is unrecognised", () => {
    expect(() => assertNotDeniedNetwork(LOCALNET_LIKE_GENESIS_HASH, "mainnet-v1.0")).toThrow(/mainnet-v1\.0/u);
  });

  it("refuses a TestNet selection whose observed genesis is a different chain", () => {
    expect(() => assertTestnetIdentity(LOCALNET_LIKE_GENESIS_HASH)).toThrow(/not the pinned public Algorand TestNet genesis hash/u);
    expect(() => assertTestnetIdentity(ALGORAND_TESTNET_GENESIS_HASH, "testnet-fork-v9.9"))
      .toThrow(/is not testnet-v1\.0/u);
  });

  it("keeps LocalNet free to mint a fresh genesis on every reset", () => {
    expect(() => assertNetworkGenesis("localnet", LOCALNET_LIKE_GENESIS_HASH)).not.toThrow();
    expect(() => assertNetworkGenesis("localnet", Buffer.alloc(32, 200).toString("base64"))).not.toThrow();
  });
});
