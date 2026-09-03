import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { ExecutorService } from "../src/service.js";
import { MemoryExecutorStore } from "../src/store.js";
import { commandHash, type CommandContext, type PermitClaims, type ReleaseInput } from "../src/types.js";
import { approvingEvidenceReader, releaseInput, testConfig } from "./helpers.js";

describe("executor transport boundary", () => {
  it("exposes only health probes without bearer authentication", async () => {
    const config = testConfig();
    const service = new ExecutorService(
      config,
      new MemoryExecutorStore(),
      { verify: async () => { throw new Error("not used"); } },
      { verifyCurrent: async () => undefined },
      {
        prepare: async () => { throw new Error("not used"); },
        reconcile: async () => ({ status: "PENDING" as const, observedRound: "1" }),
        submit: async () => { throw new Error("not used"); },
        assertProjection: async () => undefined,
        getReleaseEvidence: async () => { throw new Error("not used"); },
        readiness: async () => true,
      },
      approvingEvidenceReader(),
    );
    const app = await buildApp(config, service);
    await expect(app.inject({ method: "GET", url: "/health/live" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "GET", url: "/health/ready" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "GET", url: "/escrows/DEAL-001" })).resolves.toMatchObject({ statusCode: 401 });
    const missingEscrow = await app.inject({
      method: "GET",
      url: "/escrows/DEAL-001",
      headers: { authorization: `Bearer ${config.EXECUTOR_BEARER_TOKEN}` },
    });
    expect(missingEscrow.statusCode).toBe(404);
    expect(missingEscrow.json()).toMatchObject({ error: { code: "RESOURCE_NOT_FOUND" } });
    await expect(app.inject({ method: "GET", url: "/commands/COMMAND-001" })).resolves.toMatchObject({ statusCode: 401 });
    await expect(app.inject({ method: "POST", url: "/commands/COMMAND-001/reconcile" })).resolves.toMatchObject({ statusCode: 401 });
    await app.close();
  });

  it("never treats the static bearer token as mutation authorization", async () => {
    const config = testConfig();
    const service = new ExecutorService(
      config,
      new MemoryExecutorStore(),
      { verify: async () => { throw new Error("must not be reached without a permit header"); } },
      { verifyCurrent: async () => undefined },
      {
        prepare: async () => { throw new Error("must not prepare"); },
        reconcile: async () => ({ status: "PENDING" as const, observedRound: "1" }),
        submit: async () => { throw new Error("must not submit"); },
        assertProjection: async () => undefined,
        getReleaseEvidence: async () => { throw new Error("must not read"); },
        readiness: async () => true,
      },
      approvingEvidenceReader(),
    );
    const app = await buildApp(config, service);
    const response = await app.inject({
      method: "POST",
      url: "/escrows",
      headers: {
        authorization: `Bearer ${config.EXECUTOR_BEARER_TOKEN}`,
        "idempotency-key": "STATIC-BEARER-ATTACK",
        "x-correlation-id": "STATIC-BEARER-ATTACK",
      },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    await app.close();
  });

  it("allows bearer-authenticated exact reconciliation without accepting a new Fabric permit", async () => {
    const config = testConfig();
    const store = new MemoryExecutorStore();
    const service = new ExecutorService(
      config,
      store,
      { verify: async () => { throw new Error("reconciliation must not verify a mutation permit"); } },
      { verifyCurrent: async () => { throw new Error("reconciliation must not reread mutable Fabric authorization"); } },
      {
        prepare: async () => { throw new Error("not used"); },
        reconcile: async () => ({ status: "PENDING" as const, observedRound: "1" }),
        submit: async () => { throw new Error("not used"); },
        assertProjection: async () => undefined,
        getReleaseEvidence: async () => { throw new Error("not used"); },
        readiness: async () => true,
      },
      approvingEvidenceReader(),
    );
    const app = await buildApp(config, service);
    const body: ReleaseInput = releaseInput({
      escrowBinding: {
        dealId: "DEAL-RECONCILE", agreementHash: `sha256:${"a".repeat(64)}`,
        originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
        destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
        assetId: Number(config.ALGORAND_ASSET_ID), amount: { amountMinor: "10", currency: "USD", scale: 2 },
        network: config.ALGORAND_NETWORK, genesisHash: config.ALGORAND_GENESIS_HASH,
        applicationId: config.ALGORAND_APPLICATION_ID.toString(),
      },
      milestoneId: "MS-RECONCILE", amountMinor: "10", intentId: "INTENT-RECONCILE",
      bindingHash: `sha256:${"b".repeat(64)}`, fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      fabricClaimTransactionId: "FABRIC-RECONCILE",
      idempotencyKey: "RECONCILE-PENDING",
    });
    const command: CommandContext = {
      action: "release", method: "POST", path: "/escrows/DEAL-RECONCILE/releases",
      idempotencyKey: "RECONCILE-PENDING", body,
    };
    const seconds = Math.floor(Date.now() / 1_000);
    const permit: PermitClaims = {
      iss: "test-fabric-gateway", aud: "test-algorand-executor", sub: "optiwork-payments",
      jti: "PERMIT-RECONCILE-PENDING", iat: seconds - 120, exp: seconds - 60,
      schemaVersion: "1.0", action: "release", method: "POST", path: command.path,
      idempotencyKey: command.idempotencyKey, commandHash: commandHash(command),
      fabricTransactionId: body.fabricClaimTransactionId,
      authoritativeReads: [{
        path: `/v1/evidence/${body.evidenceId}/projection`,
        dataHash: body.releaseBinding.workEvidenceHash,
      }],
      releaseAuthorization: body,
    };
    await store.beginCommand(body.escrowBinding.dealId, "release", command.idempotencyKey, commandHash(command), permit);
    const response = await app.inject({
      method: "POST",
      url: "/commands/RECONCILE-PENDING/reconcile",
      headers: { authorization: `Bearer ${config.EXECUTOR_BEARER_TOKEN}` },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        status: "CANCELLED",
        idempotencyKey: "RECONCILE-PENDING",
        action: "release",
        leaseExpiresAt: body.leaseExpiresAt,
        cancelledAt: expect.any(String),
      },
    });
    const replay = await app.inject({
      method: "POST",
      url: "/commands/RECONCILE-PENDING/reconcile",
      headers: { authorization: `Bearer ${config.EXECUTOR_BEARER_TOKEN}` },
      payload: body,
    });
    expect(replay.json()).toEqual(response.json());
    await app.close();
  });
});
