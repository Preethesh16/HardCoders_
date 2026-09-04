import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const api = new URL(process.env.OPTIWORK_TESTNET_API_URL ?? 'http://127.0.0.1:4000');
const algod = new URL(process.env.OPTIWORK_TESTNET_ALGOD_URL ?? 'https://testnet-api.algonode.cloud');
const fabricGateway = new URL(process.env.OPTIWORK_TESTNET_FABRIC_GATEWAY_URL ?? 'http://127.0.0.1:4200');
const root = resolve(new URL('..', import.meta.url).pathname);
const deployment = JSON.parse(await readFile(resolve(root, '.optiwork/testnet/algorand-deployment.json'), 'utf8'));
const principal = Buffer.from(JSON.stringify({
  subject: 'USER-PLATFORM-ADMIN',
  organizationId: 'ORG-OPTIWORK-ADMIN',
  roles: ['platform_admin', 'audit_service', 'compliance_service'],
  displayName: 'Platform administrator',
})).toString('base64url');

const request = async (path, init = {}) => {
  const response = await fetch(new URL(path, api), {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${principal}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const health = await request('/health/live');
assert(health.profile === 'demo', 'The local public-TestNet acceptance UI must retain guarded demo principals.');
assert(health.network === 'testnet', 'The API is not bound to Algorand TestNet.');
assert(health.adapters?.database === 'postgres', 'The journey did not use PostgreSQL.');
assert(health.adapters?.storage === 's3', 'The journey did not use MinIO/S3.');
assert(health.adapters?.fabric === 'gateway', 'The journey did not use the real Fabric Gateway.');
assert(health.adapters?.algorand === 'executor', 'The journey did not use the Algorand executor.');

const walkthrough = await request('/v1/demo/walkthrough', {
  method: 'POST',
  headers: { 'idempotency-key': `anchor-public-testnet-e2e-${Date.now()}` },
  body: JSON.stringify({}),
});
assert(Array.isArray(walkthrough.journeys) && walkthrough.journeys.length === 2, 'Both TestNet journeys did not execute.');

const state = await request('/v1/demo/state');
assert(state.network === 'testnet', 'The browser read model is not reporting TestNet.');
assert(state.payments.length === 2 && state.payments.every((payment) => payment.state === 'COMPLETED'),
  'A TestNet payment did not reach COMPLETED.');
assert(state.books.length === 2 && state.books.every((book) => book.balanced), 'A fiat book is unbalanced.');
assert(new Set(state.payments.map((payment) => payment.direction)).size === 2,
  'INWARD and OUTWARD accounting were not kept separate.');
assert(state.bindings.every((binding) => binding.network === 'testnet'
  && String(binding.applicationId) === String(deployment.applicationId)
  && Number(binding.assetId) === Number(deployment.assetId)
  && binding.genesisHash === deployment.genesisHash), 'A payment is not bound to the pinned public deployment.');

const algorandTransactions = [];
for (const journey of walkthrough.journeys) {
  assert(typeof journey.fabricTxId === 'string' && journey.fabricTxId.length >= 32,
    `${journey.journey} has no real Fabric transaction ID.`);
  assert(typeof journey.settlementTransactionId === 'string' && /^[A-Z2-7]{52}$/u.test(journey.settlementTransactionId),
    `${journey.journey} has no Algorand transaction ID.`);
  const response = await fetch(new URL(`/v2/transactions/pending/${journey.settlementTransactionId}`, algod));
  const pending = await response.json();
  assert(response.ok && Number(pending['confirmed-round']) > 0,
    `${journey.journey} release is not confirmed on public Algorand TestNet.`);
  assert(pending.txn?.txn?.note === undefined, `${journey.journey} writes a transaction note to Algorand.`);
  algorandTransactions.push({
    journey: journey.journey,
    transactionId: journey.settlementTransactionId,
    confirmedRound: String(pending['confirmed-round']),
    explorer: `https://lora.algokit.io/testnet/transaction/${journey.settlementTransactionId}`,
  });
}

const fabricProjections = [];
for (const submission of state.submissions) {
  const response = await fetch(new URL(`/v1/evidence/${encodeURIComponent(submission.evidenceId)}/projection`, fabricGateway), {
    headers: {
      'x-demo-subject': 'TESTNET-E2E-PRIVACY-AUDITOR',
      'x-demo-organization': 'ORG-OPTIWORK-ADMIN',
      'x-demo-role': 'payments_service',
    },
  });
  const body = await response.json();
  assert(response.ok && body.success === true, `Fabric projection ${submission.evidenceId} is unavailable.`);
  fabricProjections.push(body.data);
}

const prohibited = /(?:@|passport|resume|fullName|displayName|legalName|walletPrivate|mnemonic|privateKey|objectId|objectKey|signedUrl|deliverable\/|document\/|Nova Systemy|Warsaw engineering lead|Bengaluru contract engineer|Pune procurement manager|Leeds account manager)/iu;
const publicEvidence = JSON.stringify({
  bindings: state.bindings,
  submissions: state.submissions.map(({ objectId: _objectId, ...submission }) => submission),
  timelines: state.timelines,
  fabricProjections,
  algorandTransactions,
});
assert(!prohibited.test(publicEvidence), 'A prohibited personal or signing field appears in the public audit projection.');

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  network: state.network,
  adapters: health.adapters,
  application: `https://lora.algokit.io/testnet/application/${deployment.applicationId}`,
  asset: `https://lora.algokit.io/testnet/asset/${deployment.assetId}`,
  journeys: algorandTransactions,
  books: state.books,
  privacy: {
    fabricProjections: fabricProjections.length,
    algorandReleaseTransactions: algorandTransactions.length,
    transactionNotes: 0,
  },
}, null, 2)}\n`);
