/**
 * OptiWork business system of record.
 *
 * PostgreSQL is authoritative for marketplace workflow, corridor policy, FX
 * quotes, compliance decisions, simulated fiat books, reconciliation and audit.
 * Neither blockchain is ever consulted for a business fact, and no ledger
 * signing key is stored here.
 *
 * Money rules, enforced everywhere below:
 *  - amounts are exact base-10 integers of minor units, stored as `numeric(38,0)`
 *    and read back as strings so no value ever passes through a JS `number`;
 *  - `currency` and `scale` travel with every amount;
 *  - INWARD and OUTWARD books are separated by `direction` and can never be
 *    netted (enforced in SQL by `journal_lines` and in code by the ledger).
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

const id = () => varchar('id', { length: 128 }).primaryKey();
const ref = (name: string) => varchar(name, { length: 128 });
const hash = (name: string) => varchar(name, { length: 71 });
const currency = (name = 'currency') => varchar(name, { length: 3 });
const minor = (name: string) => numeric(name, { precision: 38, scale: 0 });
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const organizations = pgTable('organizations', {
  id: id(),
  legalName: text('legal_name').notNull(),
  country: varchar('country', { length: 2 }).notNull(),
  kind: varchar('kind', { length: 16 }).notNull(),
  createdAt: instant('created_at').notNull(),
});

export const users = pgTable('users', {
  id: id(),
  subject: varchar('subject', { length: 128 }).notNull().unique(),
  displayName: text('display_name').notNull(),
  country: varchar('country', { length: 2 }).notNull(),
  createdAt: instant('created_at').notNull(),
});

export const memberships = pgTable('memberships', {
  id: id(),
  userId: ref('user_id').notNull(),
  organizationId: ref('organization_id').notNull(),
  role: varchar('role', { length: 32 }).notNull(),
  createdAt: instant('created_at').notNull(),
}, (table) => [
  uniqueIndex('memberships_user_org_role_idx').on(table.userId, table.organizationId, table.role),
]);

/**
 * A credential is a signed document, so every field the signature covers is
 * stored verbatim as text. `issuedAt` and `expiresAt` are deliberately *not*
 * `timestamptz`: a database that reformats them - PostgreSQL renders
 * `2026-09-02T09:00:00.000Z` as `2026-09-02 09:00:00+00` - would change the
 * canonical bytes and silently invalidate every signature on read.
 */
export const credentials = pgTable('credentials', {
  id: id(),
  organizationId: ref('organization_id').notNull(),
  subjectDid: text('subject_did').notNull(),
  issuerDid: text('issuer_did').notNull(),
  subjectCommitment: hash('subject_commitment').notNull(),
  subjectType: varchar('subject_type', { length: 16 }).notNull(),
  country: varchar('country', { length: 2 }).notNull(),
  assuranceLevel: varchar('assurance_level', { length: 16 }).notNull(),
  issuedAt: varchar('issued_at', { length: 40 }).notNull(),
  expiresAt: varchar('expires_at', { length: 40 }).notNull(),
  signature: text('signature').notNull(),
  issuerPublicKeyPem: text('issuer_public_key_pem').notNull(),
  createdAt: instant('created_at').notNull(),
});

/** Append-only status history; the latest row is the current status. */
export const credentialStatus = pgTable('credential_status', {
  id: id(),
  credentialId: ref('credential_id').notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  reason: text('reason').notNull(),
  recordedAt: instant('recorded_at').notNull(),
}, (table) => [index('credential_status_credential_idx').on(table.credentialId, table.recordedAt)]);

export const jobs = pgTable('jobs', {
  id: id(),
  organizationId: ref('organization_id').notNull(),
  createdByUserId: ref('created_by_user_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  skills: jsonb('skills').$type<string[]>().notNull(),
  acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>(),
  targetDeliveryDate: varchar('target_delivery_date', { length: 10 }),
  destinationCountry: varchar('destination_country', { length: 2 }).notNull(),
  budgetAmountMinor: minor('budget_amount_minor').notNull(),
  budgetCurrency: currency('budget_currency').notNull(),
  budgetScale: smallint('budget_scale').notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  createdAt: instant('created_at').notNull(),
}, (table) => [index('jobs_organization_idx').on(table.organizationId)]);

export const applications = pgTable('applications', {
  id: id(),
  jobId: ref('job_id').notNull(),
  applicantUserId: ref('applicant_user_id').notNull(),
  applicantOrganizationId: ref('applicant_organization_id').notNull(),
  coverLetter: text('cover_letter').notNull(),
  approach: text('approach').notNull(),
  proposedSkills: jsonb('proposed_skills').$type<string[]>().notNull(),
  proposedAmountMinor: minor('proposed_amount_minor').notNull(),
  proposedCurrency: currency('proposed_currency').notNull(),
  proposedScale: smallint('proposed_scale').notNull(),
  deliveryDays: integer('delivery_days').notNull(),
  deliveryDate: varchar('delivery_date', { length: 10 }),
  availability: text('availability').notNull(),
  resumeObjectId: ref('resume_object_id'),
  status: varchar('status', { length: 24 }).notNull(),
  createdAt: instant('created_at').notNull(),
}, (table) => [
  uniqueIndex('applications_job_applicant_idx').on(table.jobId, table.applicantUserId),
]);

/** Advisory only. An evaluation can never change a compliance or payment decision. */
export const aiEvaluations = pgTable('ai_evaluations', {
  id: id(),
  applicationId: ref('application_id').notNull(),
  purpose: varchar('purpose', { length: 32 }).notNull(),
  score: integer('score').notNull(),
  summary: text('summary').notNull(),
  advisoryOnly: boolean('advisory_only').notNull().default(true),
  source: varchar('source', { length: 16 }).notNull(),
  model: varchar('model', { length: 64 }).notNull(),
  fixtureId: varchar('fixture_id', { length: 64 }),
  promptHash: hash('prompt_hash').notNull(),
  createdAt: instant('created_at').notNull(),
}, (table) => [index('ai_evaluations_application_idx').on(table.applicationId)]);

export const aiEvaluationCitations = pgTable('ai_evaluation_citations', {
  id: id(),
  evaluationId: ref('evaluation_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  sourceUri: text('source_uri').notNull(),
  sourceVersion: varchar('source_version', { length: 128 }).notNull(),
  quote: text('quote').notNull(),
}, (table) => [uniqueIndex('ai_citation_ordinal_idx').on(table.evaluationId, table.ordinal)]);

export const workContracts = pgTable('work_contracts', {
  id: id(),
  jobId: ref('job_id').notNull(),
  applicationId: ref('application_id').notNull(),
  buyerOrganizationId: ref('buyer_organization_id').notNull(),
  providerOrganizationId: ref('provider_organization_id').notNull(),
  providerUserId: ref('provider_user_id').notNull(),
  state: varchar('state', { length: 32 }).notNull(),
  terms: text('terms').notNull(),
  contractHash: hash('contract_hash').notNull(),
  agreementObjectId: ref('agreement_object_id'),
  agreementArtifactHash: hash('agreement_artifact_hash'),
  agreementVersion: integer('agreement_version').notNull().default(0),
  agreementTerms: jsonb('agreement_terms').$type<{
    policies: string[];
    legalClauses: string[];
    acceptanceCriteria: string[];
    commercialTerms: string[];
  }>(),
  milestoneId: ref('milestone_id').notNull(),
  milestoneHash: hash('milestone_hash').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  amountCurrency: currency('amount_currency').notNull(),
  amountScale: smallint('amount_scale').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
}, (table) => [index('work_contracts_agreement_object_idx').on(table.agreementObjectId)]);

export const contractApprovals = pgTable('contract_approvals', {
  id: id(),
  contractId: ref('contract_id').notNull(),
  organizationId: ref('organization_id').notNull(),
  userId: ref('user_id').notNull(),
  party: varchar('party', { length: 16 }).notNull(),
  approvalHash: hash('approval_hash').notNull(),
  approvedAt: instant('approved_at').notNull(),
}, (table) => [uniqueIndex('contract_approvals_party_idx').on(table.contractId, table.party)]);

/** A snapshot of the versioned corridor rules that were applied, as of a decision. */
export const corridorPolicies = pgTable('corridor_policies', {
  id: id(),
  originCountry: varchar('origin_country', { length: 2 }).notNull(),
  destinationCountry: varchar('destination_country', { length: 2 }).notNull(),
  direction: varchar('direction', { length: 8 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  fundingCurrency: currency('funding_currency').notNull(),
  payoutCurrency: currency('payout_currency').notNull(),
  policy: jsonb('policy').notNull(),
  sourceUri: text('source_uri').notNull(),
  sourceVersion: varchar('source_version', { length: 128 }).notNull(),
  effectiveAt: instant('effective_at').notNull(),
  canonicalHash: hash('canonical_hash').notNull(),
});

export const complianceResults = pgTable('compliance_results', {
  id: id(),
  contractId: ref('contract_id').notNull(),
  corridorId: ref('corridor_id').notNull(),
  outcome: varchar('outcome', { length: 16 }).notNull(),
  reasons: jsonb('reasons').$type<string[]>().notNull(),
  appliedRules: jsonb('applied_rules').$type<string[]>().notNull(),
  citations: jsonb('citations').$type<Array<{
    sourceUri: string; sourceVersion: string; section: string; quote: string;
  }>>().notNull(),
  inrEquivalent: jsonb('inr_equivalent').$type<{
    amountMinor: string; currency: string; scale: number;
  }>().notNull(),
  policyVersion: varchar('policy_version', { length: 128 }).notNull(),
  rulesVersion: varchar('rules_version', { length: 128 }).notNull(),
  evaluatedAt: instant('evaluated_at').notNull(),
  canonicalHash: hash('canonical_hash').notNull(),
}, (table) => [index('compliance_results_contract_idx').on(table.contractId)]);

export const requiredDocuments = pgTable('required_documents', {
  id: id(),
  complianceResultId: ref('compliance_result_id').notNull(),
  code: varchar('code', { length: 64 }).notNull(),
  satisfied: boolean('satisfied').notNull(),
  reason: text('reason').notNull(),
  citation: jsonb('citation').$type<{
    sourceUri: string; sourceVersion: string; section: string; quote: string;
  }>().notNull(),
  documentHashId: ref('document_hash_id'),
}, (table) => [uniqueIndex('required_documents_code_idx').on(table.complianceResultId, table.code)]);

export const documentHashes = pgTable('document_hashes', {
  id: id(),
  contractId: ref('contract_id').notNull(),
  code: varchar('code', { length: 64 }).notNull(),
  objectId: ref('object_id').notNull(),
  sha256: hash('sha256').notNull(),
  byteLength: numeric('byte_length', { precision: 20, scale: 0 }).notNull(),
  createdAt: instant('created_at').notNull(),
}, (table) => [index('document_hashes_contract_idx').on(table.contractId)]);

export const fxQuotes = pgTable('fx_quotes', {
  id: id(),
  contractId: ref('contract_id').notNull(),
  corridorId: ref('corridor_id').notNull(),
  fundingAmountMinor: minor('funding_amount_minor').notNull(),
  fundingCurrency: currency('funding_currency').notNull(),
  fundingScale: smallint('funding_scale').notNull(),
  settlementAmountMinor: minor('settlement_amount_minor').notNull(),
  settlementScale: smallint('settlement_scale').notNull(),
  payoutAmountMinor: minor('payout_amount_minor').notNull(),
  payoutCurrency: currency('payout_currency').notNull(),
  payoutScale: smallint('payout_scale').notNull(),
  feesMinorTotal: minor('fees_minor_total').notNull(),
  provider: varchar('provider', { length: 64 }).notNull(),
  rateSource: varchar('rate_source', { length: 32 }).notNull(),
  rateObservedAt: instant('rate_observed_at').notNull(),
  quotedAt: instant('quoted_at').notNull(),
  expiresAt: instant('expires_at').notNull(),
  canonicalHash: hash('canonical_hash').notNull(),
  quote: jsonb('quote').notNull(),
}, (table) => [index('fx_quotes_contract_idx').on(table.contractId)]);

export const fxQuoteLegs = pgTable('fx_quote_legs', {
  id: id(),
  quoteId: ref('quote_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  pair: varchar('pair', { length: 7 }).notNull(),
  rateUnits: numeric('rate_units', { precision: 38, scale: 0 }).notNull(),
  rateScale: smallint('rate_scale').notNull(),
  fromAmountMinor: minor('from_amount_minor').notNull(),
  toAmountMinor: minor('to_amount_minor').notNull(),
}, (table) => [uniqueIndex('fx_quote_legs_ordinal_idx').on(table.quoteId, table.ordinal)]);

export const paymentInstructions = pgTable('payment_instructions', {
  id: id(),
  contractId: ref('contract_id').notNull(),
  corridorId: ref('corridor_id').notNull(),
  direction: varchar('direction', { length: 8 }).notNull(),
  bookId: varchar('book_id', { length: 32 }).notNull(),
  quoteId: ref('quote_id').notNull(),
  complianceResultId: ref('compliance_result_id').notNull(),
  state: varchar('state', { length: 32 }).notNull(),
  fundingAmountMinor: minor('funding_amount_minor').notNull(),
  fundingCurrency: currency('funding_currency').notNull(),
  fundingScale: smallint('funding_scale').notNull(),
  payoutAmountMinor: minor('payout_amount_minor').notNull(),
  payoutCurrency: currency('payout_currency').notNull(),
  payoutScale: smallint('payout_scale').notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
}, (table) => [index('payment_instructions_contract_idx').on(table.contractId)]);

export const escrowBindings = pgTable('escrow_bindings', {
  id: id(),
  paymentId: ref('payment_id').notNull().unique(),
  dealId: ref('deal_id').notNull().unique(),
  paymentKey: hash('payment_key').notNull(),
  agreementHash: hash('agreement_hash').notNull(),
  network: varchar('network', { length: 16 }).notNull(),
  genesisHash: text('genesis_hash').notNull(),
  applicationId: numeric('application_id', { precision: 20, scale: 0 }).notNull(),
  assetId: numeric('asset_id', { precision: 20, scale: 0 }).notNull(),
  originProviderAddress: varchar('origin_provider_address', { length: 58 }).notNull(),
  destinationProviderAddress: varchar('destination_provider_address', { length: 58 }).notNull(),
  amountUsdcMinor: minor('amount_usdc_minor').notNull(),
  scale: smallint('scale').notNull(),
  bindingHash: hash('binding_hash').notNull(),
  state: varchar('state', { length: 24 }).notNull(),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
});

/** Every executor call this API has made, with the exact response it observed. */
export const providerCommands = pgTable('provider_commands', {
  id: id(),
  paymentId: ref('payment_id').notNull(),
  action: varchar('action', { length: 16 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull().unique(),
  requestHash: hash('request_hash').notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  transactionId: varchar('transaction_id', { length: 52 }),
  confirmedRound: numeric('confirmed_round', { precision: 20, scale: 0 }),
  response: jsonb('response'),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
}, (table) => [index('provider_commands_payment_idx').on(table.paymentId)]);

export const reconciliationRecords = pgTable('reconciliation_records', {
  id: id(),
  paymentId: ref('payment_id').notNull(),
  scope: varchar('scope', { length: 24 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  expected: jsonb('expected').notNull(),
  observed: jsonb('observed').notNull(),
  detail: text('detail').notNull(),
  checkedAt: instant('checked_at').notNull(),
}, (table) => [index('reconciliation_payment_idx').on(table.paymentId)]);

/** Exact-replay store for every API mutation. */
export const idempotencyRecords = pgTable('idempotency_records', {
  id: id(),
  scope: varchar('scope', { length: 64 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),
  subject: varchar('subject', { length: 128 }).notNull(),
  fingerprint: hash('fingerprint').notNull(),
  statusCode: integer('status_code').notNull(),
  response: jsonb('response').notNull(),
  createdAt: instant('created_at').notNull(),
}, (table) => [uniqueIndex('idempotency_scope_key_idx').on(table.scope, table.idempotencyKey)]);

/** Simulated fiat wallets. `direction` fixes which book an account belongs to. */
export const fiatAccounts = pgTable('fiat_accounts', {
  id: id(),
  bookId: varchar('book_id', { length: 32 }).notNull(),
  direction: varchar('direction', { length: 8 }).notNull(),
  ownerKind: varchar('owner_kind', { length: 24 }).notNull(),
  ownerId: ref('owner_id').notNull(),
  accountType: varchar('account_type', { length: 24 }).notNull(),
  currency: currency().notNull(),
  scale: smallint('scale').notNull(),
  createdAt: instant('created_at').notNull(),
}, (table) => [
  index('fiat_accounts_book_idx').on(table.bookId),
  uniqueIndex('fiat_accounts_denomination_idx')
    .on(table.id, table.bookId, table.direction, table.currency, table.scale),
  uniqueIndex('fiat_accounts_owner_type_idx')
    .on(table.bookId, table.ownerKind, table.ownerId, table.accountType, table.currency),
]);

export const journalEntries = pgTable('journal_entries', {
  id: id(),
  bookId: varchar('book_id', { length: 32 }).notNull(),
  direction: varchar('direction', { length: 8 }).notNull(),
  currency: currency().notNull(),
  scale: smallint('scale').notNull(),
  paymentId: ref('payment_id'),
  reference: varchar('reference', { length: 128 }).notNull(),
  memo: text('memo').notNull(),
  postedAt: instant('posted_at').notNull(),
  entryHash: hash('entry_hash').notNull(),
}, (table) => [
  uniqueIndex('journal_entries_book_reference_idx').on(table.bookId, table.reference),
  index('journal_entries_payment_idx').on(table.paymentId),
  uniqueIndex('journal_entries_denomination_idx')
    .on(table.id, table.bookId, table.direction, table.currency, table.scale),
]);

/**
 * `bookId`, `direction`, `currency` and `scale` are repeated on every line on
 * purpose. Composite foreign keys (added in `0001_ledger_integrity.sql`) then
 * make it *impossible* for a line to point at an account in another book or
 * direction, so an inward payment can never be netted against an outward one
 * even by a direct SQL write.
 */
export const journalLines = pgTable('journal_lines', {
  id: id(),
  entryId: ref('entry_id').notNull(),
  accountId: ref('account_id').notNull(),
  bookId: varchar('book_id', { length: 32 }).notNull(),
  direction: varchar('direction', { length: 8 }).notNull(),
  currency: currency().notNull(),
  scale: smallint('scale').notNull(),
  ordinal: integer('ordinal').notNull(),
  side: varchar('side', { length: 6 }).notNull(),
  amountMinor: minor('amount_minor').notNull(),
}, (table) => [
  uniqueIndex('journal_lines_ordinal_idx').on(table.entryId, table.ordinal),
  index('journal_lines_account_idx').on(table.accountId),
]);

export const uploadedObjects = pgTable('uploaded_objects', {
  id: id(),
  bucket: varchar('bucket', { length: 64 }).notNull(),
  objectKey: text('object_key').notNull(),
  contentType: varchar('content_type', { length: 128 }).notNull(),
  byteLength: numeric('byte_length', { precision: 20, scale: 0 }).notNull(),
  sha256: hash('sha256').notNull(),
  ownerOrganizationId: ref('owner_organization_id').notNull(),
  classification: varchar('classification', { length: 24 }).notNull(),
  createdAt: instant('created_at').notNull(),
}, (table) => [uniqueIndex('uploaded_objects_key_idx').on(table.bucket, table.objectKey)]);

export const workSubmissions = pgTable('work_submissions', {
  id: id(),
  contractId: ref('contract_id').notNull(),
  evidenceId: ref('evidence_id').notNull(),
  version: integer('version').notNull(),
  objectId: ref('object_id').notNull(),
  fileHash: hash('file_hash').notNull(),
  evidenceHash: hash('evidence_hash').notNull(),
  fabricTxId: varchar('fabric_tx_id', { length: 128 }),
  buyerDecision: varchar('buyer_decision', { length: 24 }).notNull(),
  buyerDecisionHash: hash('buyer_decision_hash'),
  decidedAt: instant('decided_at'),
  submittedAt: instant('submitted_at').notNull(),
}, (table) => [
  uniqueIndex('work_submissions_version_idx').on(table.contractId, table.version),
  index('work_submissions_evidence_idx').on(table.evidenceId),
]);

/** The complete, ordered audit narrative shown in every dashboard. */
export const timelineEvents = pgTable('timeline_events', {
  id: id(),
  contractId: ref('contract_id'),
  paymentId: ref('payment_id'),
  sequence: integer('sequence').notNull(),
  kind: varchar('kind', { length: 48 }).notNull(),
  actorSubject: varchar('actor_subject', { length: 128 }).notNull(),
  actorRole: varchar('actor_role', { length: 32 }).notNull(),
  detail: jsonb('detail').notNull(),
  occurredAt: instant('occurred_at').notNull(),
}, (table) => [
  index('timeline_events_contract_idx').on(table.contractId, table.sequence),
  index('timeline_events_payment_idx').on(table.paymentId, table.sequence),
]);

export const schema = {
  organizations,
  users,
  memberships,
  credentials,
  credentialStatus,
  jobs,
  applications,
  aiEvaluations,
  aiEvaluationCitations,
  workContracts,
  contractApprovals,
  corridorPolicies,
  complianceResults,
  requiredDocuments,
  documentHashes,
  fxQuotes,
  fxQuoteLegs,
  paymentInstructions,
  escrowBindings,
  providerCommands,
  reconciliationRecords,
  idempotencyRecords,
  fiatAccounts,
  journalEntries,
  journalLines,
  uploadedObjects,
  workSubmissions,
  timelineEvents,
} as const;

export type Schema = typeof schema;
export { primaryKey, boolean };
