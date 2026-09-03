import { createHash } from 'node:crypto';

const gateway = new URL(process.env.OPTIWORK_LOCAL_FABRIC_GATEWAY_URL ?? 'http://127.0.0.1:4200');
const evidenceId = 'E2E-AUTHZ-001';
const ownerOrganization = 'ORG-E2E-BUYER';
const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const buyerOrganizationRef = `buyer:${createHash('sha256')
  .update(`optiwork.fabric.buyer-organization-ref.v1\0${ownerOrganization}`)
  .digest('hex')}`;

const actorHeaders = (subject, organization, role) => ({
  'x-demo-subject': subject,
  'x-demo-organization': organization,
  'x-demo-role': role,
});

const request = async (path, init = {}) => {
  const response = await fetch(new URL(path, gateway), {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  return { response, body: await response.json().catch(() => null) };
};

const submitted = await request('/v1/evidence', {
  method: 'POST',
  headers: {
    ...actorHeaders('USER-E2E-SELLER', 'ORG-E2E-SELLER', 'freelancer'),
    'idempotency-key': 'E2E-AUTHZ-SUBMIT-001',
  },
  body: JSON.stringify({
    evidenceId,
    contractHash: hash('authorization-contract'),
    milestoneHash: hash('authorization-milestone'),
    fileHash: hash('authorization-file'),
    buyerOrganizationRef,
    version: 1,
  }),
});
if (submitted.response.status !== 201) {
  throw new Error(`Security-fixture submission failed: ${submitted.response.status} ${JSON.stringify(submitted.body)}`);
}

const ownerRead = await request(`/v1/evidence/${evidenceId}`, {
  headers: actorHeaders('USER-E2E-BUYER', ownerOrganization, 'company_member'),
});
if (ownerRead.response.status !== 200) throw new Error('The owning buyer could not read its evidence.');

const attackerRead = await request(`/v1/evidence/${evidenceId}`, {
  headers: actorHeaders('USER-E2E-ATTACKER', 'ORG-E2E-ATTACKER', 'company_member'),
});
if (attackerRead.response.status !== 403) {
  throw new Error(`Cross-organization evidence read returned ${attackerRead.response.status}, expected 403.`);
}

const attackerDecision = await request(`/v1/evidence/${evidenceId}/decisions`, {
  method: 'POST',
  headers: {
    ...actorHeaders('USER-E2E-ATTACKER', 'ORG-E2E-ATTACKER', 'company_member'),
    'idempotency-key': 'E2E-AUTHZ-ATTACK-DECIDE-001',
  },
  body: JSON.stringify({
    decision: 'APPROVED',
    expectedFileHash: hash('authorization-file'),
    expectedVersion: 1,
  }),
});
if (attackerDecision.response.status !== 403) {
  throw new Error(`Cross-organization evidence decision returned ${attackerDecision.response.status}, expected 403.`);
}

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  evidenceId,
  ownerRead: ownerRead.response.status,
  attackerRead: attackerRead.response.status,
  attackerDecision: attackerDecision.response.status,
}, null, 2)}\n`);
