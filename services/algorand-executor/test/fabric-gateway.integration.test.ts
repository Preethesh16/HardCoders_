import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { HttpFabricPermitProvider } from '../../../apps/api/src/algorand/executor-client.js';
import { buildApp } from '../../fabric-gateway/src/app.js';
import type { ActorResolver } from '../../fabric-gateway/src/auth.js';
import { loadConfig as loadGatewayConfig } from '../../fabric-gateway/src/config.js';
import { MemoryEvidenceLedger } from '../../fabric-gateway/src/ledger/memory-ledger.js';
import { opaqueBuyerOrganizationRef } from '../../fabric-gateway/src/canonical.js';
import { projectWorkEvidence, ReleasePermitIssuer } from '../../fabric-gateway/src/permit.js';
import type { AuthenticatedActor, RequestMetadata } from '../../fabric-gateway/src/types.js';
import { HttpFabricEvidenceReader, workEvidenceHash } from '../src/security/fabric-evidence-reader.js';
import { HttpAuthoritativeFabricReader } from '../src/security/gateway-reader.js';
import { Ed25519FabricPermitVerifier } from '../src/security/permit.js';
import type { CommandContext } from '../src/types.js';
import { releaseInput, testConfig } from './helpers.js';

const applications: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (application) => application.close()));
});

const seller: AuthenticatedActor = {
  subject: 'freelancer-001', organizationId: 'seller-org', role: 'freelancer', roles: ['freelancer'],
  mspId: 'SellerOrgMSP', fabricIdentityId: 'seller-fabric-001',
};
const buyer: AuthenticatedActor = {
  subject: 'buyer-001', organizationId: 'buyer-org', role: 'company_member', roles: ['company_member'],
  mspId: 'BuyerOrgMSP', fabricIdentityId: 'buyer-fabric-001',
};
const payments: AuthenticatedActor = {
  subject: 'payments-001', organizationId: 'platform-org', role: 'payments_service', roles: ['payments_service'],
  mspId: 'BuyerOrgMSP', fabricIdentityId: 'payments-fabric-001',
};
const metadata = (idempotencyKey: string): RequestMetadata => ({
  idempotencyKey, ledgerIdempotencyKey: `ledger:${idempotencyKey}`, correlationId: idempotencyKey,
});

describe('Fabric Gateway to Algorand executor release boundary', () => {
  it('mints, verifies and re-reads one approved evidence projection end to end', async () => {
    const gatewayConfig = loadGatewayConfig({
      APP_MODE: 'demo', FABRIC_MODE: 'memory', LOG_LEVEL: 'silent',
      FABRIC_PERMIT_ISSUER: 'integration-fabric-gateway',
      FABRIC_PERMIT_AUDIENCE: 'integration-algorand-executor',
      FABRIC_PERMIT_KEY_ID: 'integration-permit-key', FABRIC_PERMIT_TTL_SECONDS: '30',
    });
    const issuer = await ReleasePermitIssuer.ephemeral(gatewayConfig.permit);
    const ledger = new MemoryEvidenceLedger();
    const submitted = await ledger.submit(seller, metadata('SUBMIT-001'), {
      evidenceId: 'EVID-PL-IN-001',
      contractHash: `sha256:${'a'.repeat(64)}`,
      milestoneHash: `sha256:${'b'.repeat(64)}`,
      fileHash: `sha256:${'c'.repeat(64)}`,
      buyerOrganizationRef: opaqueBuyerOrganizationRef(buyer.organizationId),
      version: 1,
    });
    const approved = await ledger.decide(buyer, metadata('DECIDE-001'), {
      evidenceId: submitted.evidenceId,
      decision: 'APPROVED',
      expectedFileHash: submitted.fileHash,
      expectedVersion: submitted.version,
    });
    const actorResolver: ActorResolver = { resolve: async () => payments };
    const app = await buildApp({
      config: gatewayConfig, ledger, actorResolver, permitIssuer: issuer, logger: false,
    });
    applications.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const gatewayUrl = `http://127.0.0.1:${address.port}`;
    const publicJwk = issuer.publicJwks().keys[0]!;
    const config = testConfig({
      FABRIC_GATEWAY_URL: gatewayUrl,
      FABRIC_GATEWAY_BEARER_TOKEN: 'integration-workload-token',
      FABRIC_PERMIT_ISSUER: gatewayConfig.permit.issuer,
      FABRIC_PERMIT_AUDIENCE: gatewayConfig.permit.audience,
      FABRIC_PERMIT_PUBLIC_JWK_JSON: JSON.stringify(publicJwk),
      FABRIC_PERMIT_MAX_AGE_SECONDS: '60',
    });
    const projection = projectWorkEvidence(approved);
    const idempotencyKey = 'RELEASE-INTEGRATION-001';
    const body = releaseInput({
      evidenceId: projection.evidenceId,
      escrowBinding: {
        dealId: 'DEAL-PL-IN-001',
        agreementHash: `sha256:${'d'.repeat(64)}`,
        originProviderAddress: config.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
        destinationProviderAddress: config.ALGORAND_SIGNER_ADDRESS,
        assetId: Number(config.ALGORAND_ASSET_ID),
        amount: { amountMinor: '1000000', currency: 'USD', scale: 6 },
        network: 'localnet',
        genesisHash: config.ALGORAND_GENESIS_HASH,
        applicationId: config.ALGORAND_APPLICATION_ID.toString(),
      },
      milestoneId: 'MILESTONE-001',
      amountMinor: '1000000',
      intentId: 'INTENT-001',
      bindingHash: `sha256:${'e'.repeat(64)}`,
      fenceGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
      fabricClaimTransactionId: projection.fabricTxId,
      idempotencyKey,
      workEvidenceHash: workEvidenceHash(projection),
    });
    // releaseInput normally derives this commitment; the Gateway additionally
    // verifies that bindingHash is the canonical escrow binding, so align it.
    const alignedBody = releaseInput({
      ...body,
      bindingHash: body.releaseBinding.escrowBindingHash,
      idempotencyKey,
      workEvidenceHash: body.releaseBinding.workEvidenceHash,
      complianceResultHash: body.releaseBinding.complianceResultHash,
      fxQuoteHash: body.releaseBinding.fxQuoteHash,
    });
    const command: CommandContext = {
      action: 'release', method: 'POST', path: '/escrows/DEAL-PL-IN-001/releases',
      idempotencyKey, body: alignedBody,
    };
    const provider = new HttpFabricPermitProvider({
      baseUrl: gatewayUrl, bearerToken: 'integration-workload-token',
    });
    const compactPermit = await provider.issue(command.action, command.path, command.idempotencyKey, command.body);

    const verifier = new Ed25519FabricPermitVerifier(config);
    const claims = await verifier.verify(compactPermit, command);
    const authoritative = new HttpAuthoritativeFabricReader(config);
    await authoritative.verifyCurrent(claims, command);
    const evidenceReader = new HttpFabricEvidenceReader(config, async () => 'integration-workload-token');
    const reread = await evidenceReader.readApprovedEvidence({
      evidenceId: alignedBody.evidenceId,
      dealId: alignedBody.escrowBinding.dealId,
      milestoneId: alignedBody.milestoneId,
      workEvidenceHash: alignedBody.releaseBinding.workEvidenceHash,
      fabricTxHash: alignedBody.releaseBinding.fabricTxHash,
    });

    expect(reread).toEqual(projection);
    expect(claims.authoritativeReads).toEqual([{
      path: `/v1/evidence/${projection.evidenceId}/projection`,
      dataHash: workEvidenceHash(projection),
    }]);
  });
});
