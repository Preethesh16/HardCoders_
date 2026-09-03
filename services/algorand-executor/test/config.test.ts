import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { ALGORAND_TESTNET_GENESIS_HASH as TESTNET_GENESIS_HASH } from "../src/networks.js";
import { testConfig } from "./helpers.js";

const MAINNET_GENESIS_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

describe("executor configuration", () => {
  it("accepts normal unrelated process variables while validating executor keys", () => {
    const config = testConfig({ PATH: "/usr/bin", HOME: "/tmp/not-used-by-parser" });
    expect(config.ALGORAND_APPLICATION_ID).toBe(7001n);
    expect(config.fabricGatewayAuth).toMatchObject({ mode: "static" });
    expect(config).not.toHaveProperty("FABRIC_GATEWAY_BEARER_TOKEN");
    expect(config).not.toHaveProperty("PATH");
    expect(config).not.toHaveProperty("HOME");
  });

  it("accepts complete loopback OIDC client credentials and rejects mixed or partial auth", () => {
    const oidc = testConfig({
      FABRIC_GATEWAY_BEARER_TOKEN: "",
      FABRIC_GATEWAY_OIDC_TOKEN_URL: "http://127.0.0.1:18080/realms/anchor/protocol/openid-connect/token",
      FABRIC_GATEWAY_OIDC_CLIENT_ID: "anchor-algorand-executor",
      FABRIC_GATEWAY_OIDC_CLIENT_SECRET: "executor-client-secret-test-only-0000001",
    });
    expect(oidc.fabricGatewayAuth).toMatchObject({
      mode: "oidc",
      clientId: "anchor-algorand-executor",
      refreshSkewSeconds: 30,
    });
    expect(oidc).not.toHaveProperty("FABRIC_GATEWAY_OIDC_CLIENT_SECRET");

    expect(() => testConfig({
      FABRIC_GATEWAY_OIDC_TOKEN_URL: "http://127.0.0.1:18080/realms/anchor/protocol/openid-connect/token",
      FABRIC_GATEWAY_OIDC_CLIENT_ID: "anchor-algorand-executor",
      FABRIC_GATEWAY_OIDC_CLIENT_SECRET: "executor-client-secret-test-only-0000001",
    })).toThrow(/either FABRIC_GATEWAY_BEARER_TOKEN or Gateway OIDC/u);
    expect(() => testConfig({
      FABRIC_GATEWAY_BEARER_TOKEN: "",
      FABRIC_GATEWAY_OIDC_TOKEN_URL: "http://127.0.0.1:18080/realms/anchor/protocol/openid-connect/token",
    })).toThrow(/requires token URL, client ID, and client secret together/u);
  });

  it("requires expiring HTTPS OIDC credentials for TestNet", () => {
    expect(() => testConfig({
      ALGORAND_NETWORK: "testnet",
      ALGORAND_ALGOD_URL: "https://testnet-api.algonode.cloud",
      FABRIC_GATEWAY_URL: "https://gateway.anchor.example",
    })).toThrow(/OIDC client credentials/u);
  });

  it("allows only explicitly enabled loopback Gateway and OIDC for the public TestNet demo", () => {
    const loopbackDemo = {
      ALGORAND_NETWORK: "testnet",
      PUBLIC_TESTNET_DEMO: "true",
      ALGORAND_GENESIS_HASH: TESTNET_GENESIS_HASH,
      ALGORAND_ALGOD_URL: "https://testnet-api.algonode.cloud",
      FABRIC_GATEWAY_URL: "http://127.0.0.1:4200",
      FABRIC_GATEWAY_BEARER_TOKEN: "",
      FABRIC_GATEWAY_OIDC_TOKEN_URL: "http://127.0.0.1:18080/realms/anchor/protocol/openid-connect/token",
      FABRIC_GATEWAY_OIDC_CLIENT_ID: "anchor-algorand-executor",
      FABRIC_GATEWAY_OIDC_CLIENT_SECRET: "executor-client-secret-test-only-0000001",
    } as const;
    expect(testConfig(loopbackDemo)).toMatchObject({ ALGORAND_NETWORK: "testnet", PUBLIC_TESTNET_DEMO: true });
    expect(() => testConfig({ ...loopbackDemo, PUBLIC_TESTNET_DEMO: "false" }))
      .toThrow(/explicitly enabled loopback demo Gateway/u);
    expect(() => testConfig({ ...loopbackDemo, FABRIC_GATEWAY_URL: "http://gateway.anchor.example" }))
      .toThrow(/explicitly enabled loopback demo Gateway/u);
    expect(() => testConfig({
      ...loopbackDemo,
      FABRIC_GATEWAY_OIDC_TOKEN_URL: "http://identity.anchor.example/realms/anchor/protocol/openid-connect/token",
    })).toThrow(/explicitly enabled loopback demo OIDC/u);
  });

  it("pins the exact public TestNet genesis and refuses MainNet on any network", () => {
    const testnetOidc = {
      ALGORAND_NETWORK: "testnet",
      ALGORAND_ALGOD_URL: "https://testnet-api.algonode.cloud",
      FABRIC_GATEWAY_URL: "https://gateway.anchor.example",
      FABRIC_GATEWAY_BEARER_TOKEN: "",
      FABRIC_GATEWAY_OIDC_TOKEN_URL: "https://identity.anchor.example/realms/anchor/protocol/openid-connect/token",
      FABRIC_GATEWAY_OIDC_CLIENT_ID: "anchor-algorand-executor",
      FABRIC_GATEWAY_OIDC_CLIENT_SECRET: "executor-client-secret-test-only-0000001",
    } as const;

    const accepted = testConfig({ ...testnetOidc, ALGORAND_GENESIS_HASH: TESTNET_GENESIS_HASH });
    expect(accepted.ALGORAND_NETWORK).toBe("testnet");
    expect(accepted.ALGORAND_GENESIS_HASH).toBe(TESTNET_GENESIS_HASH);

    expect(() => testConfig({ ...testnetOidc, ALGORAND_GENESIS_HASH: Buffer.alloc(32, 7).toString("base64") }))
      .toThrow(/not the pinned public Algorand TestNet genesis hash/u);

    for (const network of ["localnet", "testnet"] as const) {
      expect(() => testConfig({
        ...(network === "testnet" ? testnetOidc : {}),
        ALGORAND_NETWORK: network,
        ALGORAND_GENESIS_HASH: MAINNET_GENESIS_HASH,
      })).toThrow(/mainnet-v1\.0/u);
    }
  });

  it("accepts an optional indexer URL and holds it to the network transport rule", () => {
    expect(testConfig({ ALGORAND_INDEXER_URL: "http://127.0.0.1:8980" }).ALGORAND_INDEXER_URL?.protocol).toBe("http:");
    expect(testConfig({}).ALGORAND_INDEXER_URL).toBeUndefined();
    expect(() => testConfig({ ALGORAND_INDEXER_URL: "http://indexer.anchor.example" }))
      .toThrow(/ALGORAND_INDEXER_URL permits HTTP only on loopback LocalNet/u);
    expect(() => testConfig({
      ALGORAND_NETWORK: "testnet",
      ALGORAND_GENESIS_HASH: TESTNET_GENESIS_HASH,
      ALGORAND_ALGOD_URL: "https://testnet-api.algonode.cloud",
      ALGORAND_INDEXER_URL: "http://testnet-idx.algonode.cloud",
      FABRIC_GATEWAY_URL: "https://gateway.anchor.example",
      FABRIC_GATEWAY_BEARER_TOKEN: "",
      FABRIC_GATEWAY_OIDC_TOKEN_URL: "https://identity.anchor.example/realms/anchor/protocol/openid-connect/token",
      FABRIC_GATEWAY_OIDC_CLIENT_ID: "anchor-algorand-executor",
      FABRIC_GATEWAY_OIDC_CLIENT_SECRET: "executor-client-secret-test-only-0000001",
    })).toThrow(/Testnet requires an HTTPS ALGORAND_INDEXER_URL/u);
  });

  it("requires verified TLS for remote PostgreSQL and rejects URL-level connection options", () => {
    for (const mode of [undefined, "disable", "require"] as const) {
      expect(() => testConfig({
        DATABASE_URL: "postgresql://executor:secret@db.anchor.example:5432/executor",
        ...(mode === undefined ? { DATABASE_SSL_MODE: undefined } : { DATABASE_SSL_MODE: mode }),
      })).toThrow(/non-loopback DATABASE_URL requires DATABASE_SSL_MODE=verify-full/u);
    }

    expect(testConfig({
      DATABASE_URL: "postgresql://executor:secret@db.anchor.example:5432/executor",
      DATABASE_SSL_MODE: "verify-full",
    }).DATABASE_SSL_MODE).toBe("verify-full");

    for (const suffix of ["?sslmode=disable", "?application_name=spoofed", "#sslmode=disable"]) {
      expect(() => testConfig({
        DATABASE_URL: `postgresql://executor:secret@127.0.0.1:5432/executor${suffix}`,
        DATABASE_SSL_MODE: "verify-full",
      })).toThrow(/must not contain query parameters or a fragment/u);
    }
  });

  it("requires distinct matching executor and buyer treasury keys", () => {
    const one = algosdk.generateAccount();
    expect(() => testConfig({
      ALGORAND_SIGNER_ADDRESS: one.addr.toString(),
      ALGORAND_SIGNER_PRIVATE_KEY_BASE64: Buffer.from(one.sk).toString("base64"),
      ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: one.addr.toString(),
      ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: Buffer.from(one.sk).toString("base64"),
    })).toThrow(/distinct/u);

    const another = algosdk.generateAccount();
    expect(() => loadConfig({
      ...process.env,
      ...configEnvironment(one, another),
      ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: Buffer.from(one.sk).toString("base64"),
    })).toThrow(/does not match/u);
  });
});

function configEnvironment(executor: algosdk.Account, buyer: algosdk.Account): NodeJS.ProcessEnv {
  return {
    EXECUTOR_BEARER_TOKEN: "executor-transport-token-test-only-0000000001",
    DATABASE_URL: "postgresql://executor:executor@127.0.0.1:5432/executor",
    FABRIC_GATEWAY_URL: "http://127.0.0.1:4200",
    FABRIC_GATEWAY_BEARER_TOKEN: "fabric-reader-token-test-only",
    FABRIC_PERMIT_ISSUER: "test-fabric-gateway",
    FABRIC_PERMIT_AUDIENCE: "test-algorand-executor",
    FABRIC_PERMIT_PUBLIC_JWK_JSON: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "A".repeat(43), kid: "test" }),
    ALGORAND_ALGOD_URL: "http://127.0.0.1:4001",
    ALGORAND_GENESIS_HASH: Buffer.alloc(32).toString("base64"),
    ALGORAND_APPLICATION_ID: "1",
    ALGORAND_ASSET_ID: "1",
    ALGORAND_SIGNER_ADDRESS: executor.addr.toString(),
    ALGORAND_SIGNER_PRIVATE_KEY_BASE64: Buffer.from(executor.sk).toString("base64"),
    ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: buyer.addr.toString(),
    ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: Buffer.from(buyer.sk).toString("base64"),
  };
}
