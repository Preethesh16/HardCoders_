import algosdk from "algosdk";

import { loadConfig, type ExecutorConfig } from "../src/config.js";
import type { CommandContext, PermitClaims } from "../src/types.js";

export function testConfig(overrides: NodeJS.ProcessEnv = {}): ExecutorConfig {
  const executor = algosdk.generateAccount();
  const buyer = algosdk.generateAccount();
  return loadConfig({
    NODE_ENV: "test",
    UNRELATED_PROCESS_VARIABLE: "must-be-ignored",
    HOST: "127.0.0.1",
    PORT: "4301",
    LOG_LEVEL: "silent",
    EXECUTOR_BEARER_TOKEN: "executor-transport-token-test-only-0000000001",
    DATABASE_URL: "postgresql://executor:executor@127.0.0.1:5432/executor",
    DATABASE_SSL_MODE: "disable",
    DATABASE_AUTO_MIGRATE: "false",
    FABRIC_GATEWAY_URL: "http://127.0.0.1:4200",
    FABRIC_GATEWAY_BEARER_TOKEN: "fabric-reader-token-test-only",
    FABRIC_GATEWAY_TIMEOUT_MS: "1000",
    FABRIC_PERMIT_ISSUER: "test-fabric-gateway",
    FABRIC_PERMIT_AUDIENCE: "test-algorand-executor",
    FABRIC_PERMIT_PUBLIC_JWK_JSON: JSON.stringify({
      kty: "OKP", crv: "Ed25519", x: "A".repeat(43), kid: "test-permit-key", alg: "EdDSA",
    }),
    FABRIC_PERMIT_MAX_AGE_SECONDS: "60",
    ALGORAND_RELEASE_SAFETY_MARGIN_SECONDS: "30",
    ALGORAND_NETWORK: "localnet",
    ALGORAND_ALGOD_URL: "http://127.0.0.1:4001",
    ALGORAND_ALGOD_TOKEN: "localnet-token",
    ALGORAND_REQUEST_TIMEOUT_MS: "1000",
    ALGORAND_CONFIRMATION_ROUNDS: "3",
    ALGORAND_GENESIS_HASH: Buffer.alloc(32, 7).toString("base64"),
    ALGORAND_APPLICATION_ID: "7001",
    ALGORAND_ASSET_ID: "1042",
    ALGORAND_SIGNER_ADDRESS: executor.addr.toString(),
    ALGORAND_SIGNER_PRIVATE_KEY_BASE64: Buffer.from(executor.sk).toString("base64"),
    ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: buyer.addr.toString(),
    ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: Buffer.from(buyer.sk).toString("base64"),
    ALGORAND_MAX_VALIDITY_ROUNDS: "20",
    ...overrides,
  });
}

export function baseClaims(command: CommandContext, nowSeconds: number): PermitClaims {
  const dealId = command.action === "create"
    ? (command.body as { dealId: string }).dealId
    : decodeURIComponent(command.path.split("/")[2] ?? "");
  return {
    iss: "test-fabric-gateway",
    aud: "test-algorand-executor",
    sub: "optiwork-payments",
    jti: `permit-${command.idempotencyKey}`,
    iat: nowSeconds,
    exp: nowSeconds + 20,
    schemaVersion: "1.0",
    action: command.action as Exclude<typeof command.action, "release">,
    method: "POST",
    path: command.path,
    idempotencyKey: command.idempotencyKey,
    commandHash: "sha256:" + "0".repeat(64),
    fabricTransactionId: `FABRIC-${command.idempotencyKey}`,
    authoritativeReads: [{
      path: `/ledger/deals/${encodeURIComponent(dealId)}/algorand-authorization`,
      dataHash: "sha256:" + "1".repeat(64),
    }],
  } as PermitClaims;
}
