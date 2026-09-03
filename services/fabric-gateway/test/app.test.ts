import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { canonicalHash, opaqueBuyerOrganizationRef, sha256 } from '../src/canonical.js';
import type { GatewayConfig } from '../src/config.js';
import { projectWorkEvidence, RELEASE_PERMIT_TYPE } from '../src/permit.js';
import type { LedgerWorkEvidence } from '../src/types.js';

const hash = (character: string) => `sha256:${character.repeat(64)}`;

const config: GatewayConfig = {
  appMode: 'demo',
  fabricMode: 'memory',
  host: '127.0.0.1',
  port: 4200,
  logLevel: 'silent',
  channelName: 'optiwork-channel',
  chaincodeName: 'optiwork-evidence',
  fabricIdentities: [],
  permit: {
    issuer: 'optiwork-fabric-gateway',
    audience: 'optiwork-algorand-executor',
    keyId: 'test-permit-1',
    ttlSeconds: 60,
  },
  idempotency: {
    store: 'memory',
    autoMigrate: false,
    ttlMs: 900_000,
    maxEntries: 1_000,
  },
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function commandHeaders(role: string, key: string, subject = `${role}-subject`) {
  return {
    'idempotency-key': key,
    'x-correlation-id': `CORR-${key}`,
    'x-demo-subject': subject,
    'x-demo-organization': role === 'freelancer' ? 'ORG-FREELANCER-001' : 'ORG-COMPANY-001',
    'x-demo-role': role,
  };
}

function queryHeaders(role: string, subject = `${role}-subject`) {
  return {
    'x-demo-subject': subject,
    'x-demo-organization': role === 'freelancer' ? 'ORG-FREELANCER-001' : 'ORG-COMPANY-001',
    'x-demo-role': role,
  };
}

function submission(fileHash = hash('c'), version = 1) {
  return {
    evidenceId: 'EVID-PLIN-001',
    contractHash: hash('a'),
    milestoneHash: hash('b'),
    fileHash,
    buyerOrganizationRef: opaqueBuyerOrganizationRef('ORG-COMPANY-001'),
    version,
  };
}

function permitPayload(evidence: LedgerWorkEvidence, idempotencyKey: string) {
  const escrowBinding = {
    dealId: 'DEAL-PLIN-001',
    agreementHash: hash('9'),
    originProviderAddress: 'A'.repeat(58),
    destinationProviderAddress: 'B'.repeat(58),
    assetId: 1,
    amount: { amountMinor: '1000000', currency: 'USD', scale: 6 },
    network: 'localnet' as const,
    genesisHash: 'localnet-demo-genesis-hash',
    applicationId: '1',
  };
  const expiresAt = '2030-01-01T00:00:00.000Z';
  const releaseBinding = {
    escrowBindingHash: canonicalHash(escrowBinding),
    workEvidenceHash: canonicalHash(projectWorkEvidence(evidence)),
    fabricTxHash: sha256(evidence.fabricTxId),
    complianceResultHash: hash('e'),
    fxQuoteHash: hash('f'),
    generation: 1,
    idempotencyKey,
    expiresAt,
  };
  const body = {
    evidenceId: evidence.evidenceId,
    escrowBinding,
    milestoneId: 'MILESTONE-001',
    amountMinor: '1000000',
    intentId: 'INTENT-001',
    bindingHash: canonicalHash(escrowBinding),
    fenceGeneration: 1,
    leaseExpiresAt: expiresAt,
    authorizationCommitment: canonicalHash(releaseBinding),
    fabricClaimTransactionId: evidence.fabricTxId,
    releaseBinding,
  };
  return {
    command: {
      action: 'release' as const,
      method: 'POST' as const,
      path: '/escrows/DEAL-PLIN-001/releases',
      idempotencyKey,
      body,
    },
  };
}

describe('OptiWork evidence Gateway', () => {
  it('records opaque evidence, replays exactly, and rejects a changed idempotency fingerprint', async () => {
    const app = await buildApp({ config, logger: false });
    apps.push(app);
    const request = {
      method: 'POST' as const,
      url: '/v1/evidence',
      headers: commandHeaders('freelancer', 'SUBMIT-001', 'alice-private-subject'),
      payload: submission(),
    };
    const created = await app.inject(request);
    const replay = await app.inject(request);
    expect(created.statusCode).toBe(201);
    expect(replay.json()).toEqual(created.json());
    const serialized = JSON.stringify(created.json());
    expect(serialized).not.toContain('alice-private-subject');
    expect(serialized).not.toContain('ORG-FREELANCER-001');
    expect(serialized).toContain('seller:');

    const conflict = await app.inject({ ...request, payload: submission(hash('d')) });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('binds buyer approval to the current file and version and issues a verifiable permit', async () => {
    const app = await buildApp({ config, logger: false });
    apps.push(app);
    expect((await app.inject({
      method: 'POST', url: '/v1/evidence',
      headers: commandHeaders('freelancer', 'SUBMIT-002'), payload: submission(),
    })).statusCode).toBe(201);

    const unrelatedBuyer = await app.inject({
      method: 'POST', url: '/v1/evidence/EVID-PLIN-001/decisions',
      headers: { ...commandHeaders('company_member', 'DECIDE-WRONG-BUYER'), 'x-demo-organization': 'ORG-OTHER-001' },
      payload: { decision: 'APPROVED', expectedFileHash: hash('c'), expectedVersion: 1 },
    });
    expect(unrelatedBuyer.statusCode).toBe(403);

    const stale = await app.inject({
      method: 'POST', url: '/v1/evidence/EVID-PLIN-001/decisions',
      headers: commandHeaders('company_member', 'DECIDE-STALE'),
      payload: { decision: 'APPROVED', expectedFileHash: hash('c'), expectedVersion: 2 },
    });
    expect(stale.statusCode).toBe(409);

    const approved = await app.inject({
      method: 'POST', url: '/v1/evidence/EVID-PLIN-001/decisions',
      headers: commandHeaders('company_member', 'DECIDE-001'),
      payload: { decision: 'APPROVED', expectedFileHash: hash('c'), expectedVersion: 1 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.buyerDecision).toBe('APPROVED');

    const permitResponse = await app.inject({
      method: 'POST', url: '/v1/evidence/EVID-PLIN-001/release-permits',
      headers: commandHeaders('payments_service', 'PERMIT-001'),
      payload: permitPayload(approved.json().data as LedgerWorkEvidence, 'RELEASE-001'),
    });
    expect(permitResponse.statusCode).toBe(201);
    const envelope = permitResponse.json();
    const permit = envelope.data.permit as string;
    const jwksResponse = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const jwks = createLocalJWKSet(jwksResponse.json());
    const verified = await jwtVerify(permit, jwks, {
      issuer: config.permit.issuer,
      audience: config.permit.audience,
      algorithms: ['EdDSA'],
    });
    expect(decodeProtectedHeader(permit)).toMatchObject({ typ: RELEASE_PERMIT_TYPE, kid: 'test-permit-1' });
    expect(verified.payload.releaseAuthorization).toMatchObject({
      evidenceId: 'EVID-PLIN-001',
      releaseBinding: {
        complianceResultHash: hash('e'),
        fxQuoteHash: hash('f'),
        generation: 1,
      },
    });
    expect(verified.payload.schemaVersion).toBe('1.0');
    expect(verified.payload.sub).toBe('optiwork-payments');
  });

  it('prevents evidence IDOR reads by unrelated sellers and buyers', async () => {
    const app = await buildApp({ config, logger: false });
    apps.push(app);
    await app.inject({
      method: 'POST', url: '/v1/evidence',
      headers: commandHeaders('freelancer', 'SUBMIT-PRIVATE'), payload: submission(),
    });
    const unrelatedSeller = await app.inject({
      method: 'GET', url: '/v1/evidence/EVID-PLIN-001',
      headers: queryHeaders('freelancer', 'another-freelancer'),
    });
    const unrelatedBuyer = await app.inject({
      method: 'GET', url: '/v1/evidence/EVID-PLIN-001',
      headers: { ...queryHeaders('company_member'), 'x-demo-organization': 'ORG-OTHER-001' },
    });
    const auditor = await app.inject({
      method: 'GET', url: '/v1/evidence/EVID-PLIN-001', headers: queryHeaders('audit_service'),
    });
    expect(unrelatedSeller.statusCode).toBe(403);
    expect(unrelatedBuyer.statusCode).toBe(403);
    expect(auditor.statusCode).toBe(200);
  });

  it('allows a sequential revision and returns ordered bounded history', async () => {
    const app = await buildApp({ config, logger: false });
    apps.push(app);
    await app.inject({
      method: 'POST', url: '/v1/evidence', headers: commandHeaders('freelancer', 'REV-SUBMIT-1'),
      payload: submission(hash('1'), 1),
    });
    await app.inject({
      method: 'POST', url: '/v1/evidence/EVID-PLIN-001/decisions',
      headers: commandHeaders('company_member', 'REV-DECIDE-1'),
      payload: { decision: 'REVISION_REQUIRED', expectedFileHash: hash('1'), expectedVersion: 1 },
    });
    const revised = await app.inject({
      method: 'POST', url: '/v1/evidence', headers: commandHeaders('freelancer', 'REV-SUBMIT-2'),
      payload: submission(hash('2'), 2),
    });
    expect(revised.statusCode).toBe(201);
    expect(revised.json().data).toMatchObject({ version: 2, buyerDecision: 'PENDING' });
    const history = await app.inject({
      method: 'GET', url: '/v1/evidence/EVID-PLIN-001/history', headers: queryHeaders('audit_service'),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().data.data).toHaveLength(3);
    expect(history.json().data.data.map((entry: { value: { buyerDecision: string } }) => entry.value.buyerDecision))
      .toEqual(['PENDING', 'REVISION_REQUIRED', 'PENDING']);
  });

  it('rejects unauthorized evidence writers and unapproved permit requests', async () => {
    const app = await buildApp({ config, logger: false });
    apps.push(app);
    const wrongWriter = await app.inject({
      method: 'POST', url: '/v1/evidence', headers: commandHeaders('company_member', 'BAD-WRITER'),
      payload: submission(),
    });
    expect(wrongWriter.statusCode).toBe(403);
    const pending = await app.inject({
      method: 'POST', url: '/v1/evidence', headers: commandHeaders('freelancer', 'PENDING-SUBMIT'),
      payload: submission(),
    });
    const pendingPermit = await app.inject({
      method: 'POST', url: '/v1/evidence/EVID-PLIN-001/release-permits',
      headers: commandHeaders('payments_service', 'PENDING-PERMIT'),
      payload: permitPayload(pending.json().data as LedgerWorkEvidence, 'RELEASE-PENDING'),
    });
    expect(pendingPermit.statusCode).toBe(409);
  });
});
