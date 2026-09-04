import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { RealAlgorandChain, type PrepareInput } from "../src/chain.js";
import type { ExecutorConfig } from "../src/config.js";
import { testConfig } from "./helpers.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fakeAlgod(handler: RequestListener): Promise<{ endpoint: string; requests: () => number; reset: () => void }> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test listener.");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests: () => requestCount,
    reset: () => { requestCount = 0; },
  };
}

function paramsHandler(config: ExecutorConfig, minFee: number): RequestListener {
  return (request, response) => {
    if (request.method !== "GET" || request.url !== "/v2/transactions/params") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: `unexpected request ${request.method} ${request.url}` }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      "consensus-version": "test-consensus",
      fee: minFee,
      "genesis-hash": config.ALGORAND_GENESIS_HASH,
      "genesis-id": "optiwork-security-test-v1",
      "last-round": 100,
      "min-fee": minFee,
    }));
  };
}

function createInput(config: ExecutorConfig, idempotencyKey: string, dealId: string): PrepareInput {
  return {
    action: "create",
    commandHash: `sha256:${(idempotencyKey === "CREATE-A" ? "a" : "b").repeat(64)}`,
    idempotencyKey,
    binding: {
      dealId,
      agreementHash: `sha256:${(idempotencyKey === "CREATE-A" ? "c" : "d").repeat(64)}`,
      originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
      destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
      assetId: Number(config.ALGORAND_ASSET_ID),
      amount: { amountMinor: "100", currency: "USD", scale: 2 },
      network: config.ALGORAND_NETWORK,
      genesisHash: config.ALGORAND_GENESIS_HASH,
      applicationId: config.ALGORAND_APPLICATION_ID.toString(),
    },
  };
}

function fundInput(config: ExecutorConfig): PrepareInput {
  return {
    ...createInput(config, "CREATE-A", "DEAL-A"),
    action: "fund",
    commandHash: `sha256:${"e".repeat(64)}`,
    idempotencyKey: "FUND-A",
  };
}

describe("signed command binding and fee policy", () => {
  it("rejects a valid signed blob prepared for another command before any Algod reconciliation call", async () => {
    const initial = testConfig();
    const server = await fakeAlgod(paramsHandler(initial, 1_000));
    const config = testConfig({
      ALGORAND_ALGOD_URL: server.endpoint,
      ALGORAND_SIGNER_ADDRESS: initial.ALGORAND_SIGNER_ADDRESS,
      ALGORAND_SIGNER_PRIVATE_KEY_BASE64: Buffer.from(initial.signerPrivateKey).toString("base64"),
      ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: initial.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
      ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: Buffer.from(initial.originProviderTreasuryPrivateKey).toString("base64"),
    });
    const chain = new RealAlgorandChain(config);
    const commandA = createInput(config, "CREATE-A", "DEAL-A");
    const commandB = createInput(config, "CREATE-B", "DEAL-B");
    const preparedB = await chain.prepare(commandB);
    server.reset();

    await expect(chain.submit(preparedB, commandA)).rejects.toThrow(/not bound to the expected authorized command/u);
    expect(server.requests()).toBe(0);
  });

  it("rejects a compromised Algod fee suggestion before signing or submitting", async () => {
    const initial = testConfig();
    const server = await fakeAlgod(paramsHandler(initial, 10_001));
    const config = testConfig({
      ALGORAND_ALGOD_URL: server.endpoint,
      ALGORAND_SIGNER_ADDRESS: initial.ALGORAND_SIGNER_ADDRESS,
      ALGORAND_SIGNER_PRIVATE_KEY_BASE64: Buffer.from(initial.signerPrivateKey).toString("base64"),
      ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: initial.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
      ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: Buffer.from(initial.originProviderTreasuryPrivateKey).toString("base64"),
      ALGORAND_MAX_TRANSACTION_FEE_MICROALGOS: "10000",
      ALGORAND_MAX_GROUP_FEE_MICROALGOS: "20000",
    });
    const chain = new RealAlgorandChain(config);

    await expect(chain.prepare(createInput(config, "CREATE-A", "DEAL-A")))
      .rejects.toThrow(/fee outside the configured microAlgo cap/u);
    expect(server.requests()).toBe(1);
  });

  it("rejects an underfunded origin treasury before constructing or signing a funding group", async () => {
    const initial = testConfig();
    const server = await fakeAlgod((request, response) => {
      if (request.method === "GET" && request.url?.includes("/v2/accounts/")
        && request.url.includes(`/assets/${initial.ALGORAND_ASSET_ID.toString()}`)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          "asset-holding": {
            amount: 99,
            "asset-id": Number(initial.ALGORAND_ASSET_ID),
            "is-frozen": false,
          },
          round: 100,
        }));
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: `unexpected request ${request.method} ${request.url}` }));
    });
    const config = testConfig({
      ALGORAND_ALGOD_URL: server.endpoint,
      ALGORAND_SIGNER_ADDRESS: initial.ALGORAND_SIGNER_ADDRESS,
      ALGORAND_SIGNER_PRIVATE_KEY_BASE64: Buffer.from(initial.signerPrivateKey).toString("base64"),
      ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: initial.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
      ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: Buffer.from(initial.originProviderTreasuryPrivateKey).toString("base64"),
    });
    const chain = new RealAlgorandChain(config);

    await expect(chain.prepare(fundInput(config)))
      .rejects.toThrow(/insufficient settlement assets: 99 available, 100 required.*not signed/u);
    expect(server.requests()).toBe(1);
  });
});
