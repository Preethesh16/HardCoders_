import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const api = new URL(process.env.OPTIWORK_LOCAL_API_URL ?? 'http://127.0.0.1:4000');
const algod = new URL(process.env.OPTIWORK_LOCAL_ALGOD_URL ?? 'http://127.0.0.1:4001');
const fabricGateway = new URL(process.env.OPTIWORK_LOCAL_FABRIC_GATEWAY_URL ?? 'http://127.0.0.1:4200');
const root = resolve(new URL('..', import.meta.url).pathname);
const deployment = JSON.parse(await readFile(resolve(root, '.optiwork/localnet/algorand-deployment.json'), 'utf8'));
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
assert(health.profile === 'demo', 'The local API must use the guarded demo workflow profile.');
assert(health.adapters?.database === 'postgres', 'The local journey did not use PostgreSQL.');
assert(health.adapters?.storage === 's3', 'The local journey did not use MinIO/S3.');
assert(health.adapters?.fabric === 'gateway', 'The local journey did not use the Fabric Gateway.');
assert(health.adapters?.algorand === 'executor', 'The local journey did not use the Algorand executor.');

const walkthrough = await request('/v1/demo/walkthrough', {
  method: 'POST',
  headers: { 'idempotency-key': 'optiwork-real-localnet-e2e-v1' },
  body: JSON.stringify({}),
});
assert(Array.isArray(walkthrough.journeys) && walkthrough.journeys.length === 2, 'Both journeys did not execute.');

const state = await request('/v1/demo/state');
assert(state.payments.length === 2, 'The business database does not contain exactly two demo payments.');
assert(state.payments.every((payment) => payment.state === 'COMPLETED'), 'A payment did not reach COMPLETED.');
assert(state.books.length === 2 && state.books.every((book) => book.balanced), 'A fiat book is unbalanced.');
assert(new Set(state.payments.map((payment) => payment.direction)).size === 2, 'INWARD and OUTWARD directions are not separate.');
assert(state.adapters.fabric === 'gateway' && state.adapters.algorand === 'executor' && state.adapters.storage === 's3',
  'The dashboard read model reports a simulated adapter.');

const providerAddresses = state.bindings.flatMap((binding) => [
  binding.originProviderAddress,
  binding.destinationProviderAddress,
]);
assert(providerAddresses.length === 4 && new Set(providerAddresses).size === 4,
  'The two corridors do not use four separate provider treasuries.');
assert(state.bindings.every((binding) => String(binding.applicationId) === String(deployment.applicationId)
  && Number(binding.assetId) === Number(deployment.assetId)
  && binding.genesisHash === deployment.genesisHash), 'A payment was not bound to the generated LocalNet deployment.');

const algorandTransactions = [];
for (const journey of walkthrough.journeys) {
  assert(typeof journey.fabricTxId === 'string' && journey.fabricTxId.length >= 32,
    `${journey.journey} has no real Fabric transaction ID.`);
  assert(typeof journey.settlementTransactionId === 'string' && /^[A-Z2-7]{52}$/u.test(journey.settlementTransactionId),
    `${journey.journey} has no Algorand transaction ID.`);
  const response = await fetch(new URL(`/v2/transactions/pending/${journey.settlementTransactionId}`, algod), {
    headers: { 'X-Algo-API-Token': 'a'.repeat(64) },
  });
  const pending = await response.json();
  assert(response.ok && Number(pending['confirmed-round']) > 0,
    `${journey.journey} release is not confirmed on Algorand LocalNet.`);
  assert(pending.txn?.txn?.note === undefined, `${journey.journey} writes a transaction note to Algorand.`);
  algorandTransactions.push(pending);
}

const fabricProjections = [];
for (const submission of state.submissions) {
  const response = await fetch(new URL(`/v1/evidence/${encodeURIComponent(submission.evidenceId)}/projection`, fabricGateway), {
    headers: {
      'x-demo-subject': 'LOCAL-E2E-PRIVACY-AUDITOR',
      'x-demo-organization': 'ORG-OPTIWORK-ADMIN',
      'x-demo-role': 'payments_service',
    },
  });
  const body = await response.json();
  assert(response.ok && body.success === true, `Fabric projection ${submission.evidenceId} is unavailable.`);
  fabricProjections.push(body.data);
}

const boxesResponse = await fetch(new URL(`/v2/applications/${deployment.applicationId}/boxes`, algod), {
  headers: { 'X-Algo-API-Token': 'a'.repeat(64) },
});
const boxList = await boxesResponse.json();
assert(boxesResponse.ok && Array.isArray(boxList.boxes), 'Algorand application boxes are unavailable.');
const algorandBoxBytes = [];
for (const box of boxList.boxes) {
  const boxUrl = new URL(`/v2/applications/${deployment.applicationId}/box`, algod);
  boxUrl.searchParams.set('name', `b64:${box.name}`);
  const response = await fetch(boxUrl, { headers: { 'X-Algo-API-Token': 'a'.repeat(64) } });
  const body = await response.json();
  assert(response.ok && typeof body.value === 'string', 'An Algorand application box could not be read.');
  algorandBoxBytes.push(Buffer.from(body.value, 'base64'));
}

const prohibited = /(?:@|passport|resume|fullName|displayName|legalName|walletPrivate|mnemonic|privateKey|objectId|objectKey|signedUrl|deliverable\/|document\/|Nova Systemy|Warsaw engineering lead|Bengaluru contract engineer|Pune procurement manager|Leeds account manager)/iu;
const prohibitedInBinaryLedgerData = /(?:passport|resume|fullName|displayName|legalName|walletPrivate|mnemonic|privateKey|objectId|objectKey|signedUrl|deliverable\/|document\/|Nova Systemy|Warsaw engineering lead|Bengaluru contract engineer|Pune procurement manager|Leeds account manager)/iu;
const publicEvidence = JSON.stringify({
  bindings: state.bindings,
  submissions: state.submissions.map(({ objectId: _objectId, ...submission }) => submission),
  timelines: state.timelines,
  fabricProjections,
  algorandTransactions,
});
assert(!prohibited.test(publicEvidence), 'A prohibited personal or signing field appears in the public audit projection.');
assert(!prohibitedInBinaryLedgerData.test(Buffer.concat(algorandBoxBytes).toString('utf8')),
  'A prohibited personal or raw file identifier appears in an Algorand application box.');

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  adapters: health.adapters,
  journeys: walkthrough.journeys,
  books: state.books,
  deployment: {
    applicationId: deployment.applicationId,
    assetId: deployment.assetId,
    genesisHash: deployment.genesisHash,
  },
  privacy: {
    fabricProjections: fabricProjections.length,
    algorandReleaseTransactions: algorandTransactions.length,
    algorandBoxes: algorandBoxBytes.length,
    transactionNotes: 0,
  },
}, null, 2)}\n`);
