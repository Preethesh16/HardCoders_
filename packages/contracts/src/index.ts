import { Static, Type } from '@sinclair/typebox';

export const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
export const Sha256Schema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
export const CountryCodeSchema = Type.String({ pattern: '^[A-Z]{2}$' });
export const CurrencySchema = Type.String({ pattern: '^[A-Z]{3}$' });
export const IsoTimestampSchema = Type.String({ format: 'date-time' });
export const UnsignedIntegerStringSchema = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });

export const MoneySchema = Type.Object({
  amountMinor: UnsignedIntegerStringSchema,
  currency: CurrencySchema,
  scale: Type.Integer({ minimum: 0, maximum: 8 }),
}, { additionalProperties: false });

export const CorridorDirectionSchema = Type.Union([Type.Literal('INWARD'), Type.Literal('OUTWARD')]);
export const CorridorStatusSchema = Type.Union([Type.Literal('ACTIVE'), Type.Literal('MANUAL_REVIEW'), Type.Literal('BLOCKED')]);

export const DueDiligenceRuleSchema = Type.Object({
  code: IdentifierSchema,
  threshold: MoneySchema,
  appliesTo: Type.Union([Type.Literal('BUYER'), Type.Literal('SELLER'), Type.Literal('BOTH')]),
  requiredDocuments: Type.Array(IdentifierSchema, { uniqueItems: true }),
  sourceSection: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false });

export const CorridorPolicySchema = Type.Object({
  id: IdentifierSchema,
  originCountry: CountryCodeSchema,
  destinationCountry: CountryCodeSchema,
  direction: CorridorDirectionSchema,
  status: CorridorStatusSchema,
  fundingCurrency: CurrencySchema,
  settlementCurrency: Type.Literal('USD'),
  payoutCurrency: CurrencySchema,
  requiredProviderCapabilities: Type.Array(IdentifierSchema, { uniqueItems: true }),
  transactionCap: Type.Optional(MoneySchema),
  dueDiligenceRules: Type.Array(DueDiligenceRuleSchema),
  requiredDocuments: Type.Array(IdentifierSchema, { uniqueItems: true }),
  purposeCodes: Type.Array(IdentifierSchema, { uniqueItems: true }),
  sourceUri: Type.String({ format: 'uri' }),
  sourceVersion: IdentifierSchema,
  effectiveAt: IsoTimestampSchema,
}, { additionalProperties: false });

export const FxRateSchema = Type.Object({
  pair: Type.String({ pattern: '^[A-Z]{3}/[A-Z]{3}$' }),
  units: UnsignedIntegerStringSchema,
  scale: Type.Integer({ minimum: 0, maximum: 12 }),
}, { additionalProperties: false });

export const FxQuoteSchema = Type.Object({
  id: IdentifierSchema,
  corridorId: IdentifierSchema,
  fundingAmount: MoneySchema,
  grossSettlementAmount: MoneySchema,
  settlementAmount: MoneySchema,
  grossPayoutAmount: MoneySchema,
  payoutAmount: MoneySchema,
  rates: Type.Tuple([FxRateSchema, FxRateSchema]),
  fees: Type.Array(Type.Object({
    code: IdentifierSchema,
    amount: MoneySchema,
    basisPoints: Type.Integer({ minimum: 0, maximum: 10_000 }),
  }, { additionalProperties: false })),
  provider: IdentifierSchema,
  quotedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  canonicalHash: Sha256Schema,
  executable: Type.Literal(false),
}, { additionalProperties: false });

export const CredentialStatusSchema = Type.Union([Type.Literal('ACTIVE'), Type.Literal('REVOKED'), Type.Literal('SUSPENDED')]);
export const VerifiableCredentialSchema = Type.Object({
  id: IdentifierSchema,
  issuerDid: Type.String({ pattern: '^did:key:' }),
  subjectDid: Type.String({ pattern: '^did:key:' }),
  subjectCommitment: Sha256Schema,
  subjectType: Type.Union([Type.Literal('COMPANY'), Type.Literal('FREELANCER'), Type.Literal('SUPPLIER')]),
  country: CountryCodeSchema,
  assuranceLevel: Type.Union([Type.Literal('BASIC'), Type.Literal('ENHANCED')]),
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  status: CredentialStatusSchema,
  signature: Type.String({ minLength: 16, maxLength: 2048 }),
}, { additionalProperties: false });

export const BuyerDecisionSchema = Type.Union([
  Type.Literal('PENDING'), Type.Literal('APPROVED'), Type.Literal('REVISION_REQUIRED'), Type.Literal('DISPUTED'),
]);
export const WorkEvidenceSchema = Type.Object({
  evidenceId: IdentifierSchema,
  contractHash: Sha256Schema,
  milestoneHash: Sha256Schema,
  fileHash: Sha256Schema,
  sellerIdentityRef: IdentifierSchema,
  version: Type.Integer({ minimum: 1 }),
  submittedAt: IsoTimestampSchema,
  buyerDecision: BuyerDecisionSchema,
  buyerDecisionHash: Type.Optional(Sha256Schema),
  decidedAt: Type.Optional(IsoTimestampSchema),
  fabricTxId: Type.Optional(IdentifierSchema),
}, { additionalProperties: false });

export const AlgorandNetworkSchema = Type.Union([Type.Literal('localnet'), Type.Literal('testnet')]);
export const AlgorandAddressSchema = Type.String({ pattern: '^[A-Z2-7]{58}$' });
export const EscrowBindingSchema = Type.Object({
  paymentKey: Sha256Schema,
  agreementHash: Sha256Schema,
  network: AlgorandNetworkSchema,
  genesisHash: Type.String({ minLength: 8, maxLength: 128 }),
  applicationId: UnsignedIntegerStringSchema,
  assetId: UnsignedIntegerStringSchema,
  originProviderAddress: AlgorandAddressSchema,
  destinationProviderAddress: AlgorandAddressSchema,
  amountUSDCMinor: UnsignedIntegerStringSchema,
  scale: Type.Literal(6),
}, { additionalProperties: false });

export const ReleaseAuthorizationSchema = Type.Object({
  escrowBindingHash: Sha256Schema,
  workEvidenceHash: Sha256Schema,
  fabricTxHash: Sha256Schema,
  complianceResultHash: Sha256Schema,
  fxQuoteHash: Sha256Schema,
  generation: Type.Integer({ minimum: 1 }),
  idempotencyKey: IdentifierSchema,
  expiresAt: IsoTimestampSchema,
}, { additionalProperties: false });

export const ComplianceOutcomeSchema = Type.Union([Type.Literal('PASSED'), Type.Literal('MANUAL_REVIEW'), Type.Literal('BLOCKED')]);
export const ComplianceResultSchema = Type.Object({
  id: IdentifierSchema,
  corridorId: IdentifierSchema,
  outcome: ComplianceOutcomeSchema,
  reasons: Type.Array(Type.String({ minLength: 1, maxLength: 512 })),
  requiredDocuments: Type.Array(IdentifierSchema, { uniqueItems: true }),
  policyVersion: IdentifierSchema,
  evaluatedAt: IsoTimestampSchema,
  canonicalHash: Sha256Schema,
}, { additionalProperties: false });

export const PaymentStateSchema = Type.Union([
  Type.Literal('DRAFT'), Type.Literal('COMPLIANCE_PENDING'), Type.Literal('MANUAL_REVIEW'),
  Type.Literal('QUOTED'), Type.Literal('FIAT_FUNDED'), Type.Literal('ESCROW_CREATED'),
  Type.Literal('USDC_LOCKED'), Type.Literal('WORK_PENDING'), Type.Literal('RELEASE_AUTHORIZED'),
  Type.Literal('USDC_RELEASED'), Type.Literal('PAYOUT_CREDITED'), Type.Literal('COMPLETED'),
  Type.Literal('REFUNDED'), Type.Literal('EXPIRED'), Type.Literal('FAILED_RECONCILIATION'),
]);

export const WorkContractStateSchema = Type.Union([
  Type.Literal('DRAFT'), Type.Literal('CANDIDATE_SELECTED'), Type.Literal('PARTY_APPROVAL_PENDING'),
  Type.Literal('RULES_VERIFIED'), Type.Literal('FX_LOCKED'), Type.Literal('ESCROW_CREATED'),
  Type.Literal('ESCROW_FUNDED'), Type.Literal('IN_PROGRESS'), Type.Literal('WORK_SUBMITTED'),
  Type.Literal('VALIDATION_RECORDED'), Type.Literal('COMPANY_APPROVED'), Type.Literal('RELEASE_AUTHORIZED'),
  Type.Literal('ESCROW_RELEASED'), Type.Literal('COMPLETED'), Type.Literal('REVISION_REQUIRED'),
  Type.Literal('DISPUTED'), Type.Literal('CANCELLED'), Type.Literal('EXPIRED'),
]);

export const ActorRoleSchema = Type.Union([
  Type.Literal('company_member'), Type.Literal('freelancer'), Type.Literal('supplier'),
  Type.Literal('provider_operator'), Type.Literal('platform_admin'), Type.Literal('compliance_service'),
  Type.Literal('payments_service'), Type.Literal('audit_service'),
]);
export const ActorSchema = Type.Object({
  subject: IdentifierSchema,
  organizationId: IdentifierSchema,
  role: ActorRoleSchema,
}, { additionalProperties: false });

export const HealthResponseSchema = Type.Object({
  name: Type.Literal('optiwork-api'),
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  version: Type.String(),
  profile: Type.Union([Type.Literal('demo'), Type.Literal('local'), Type.Literal('testnet')]),
}, { additionalProperties: false });

export const ErrorResponseSchema = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), requestId: Type.Optional(Type.String()) }, { additionalProperties: false }),
}, { additionalProperties: false });

export type MoneyDto = Static<typeof MoneySchema>;
export type CorridorDirection = Static<typeof CorridorDirectionSchema>;
export type CorridorStatus = Static<typeof CorridorStatusSchema>;
export type DueDiligenceRule = Static<typeof DueDiligenceRuleSchema>;
export type CorridorPolicy = Static<typeof CorridorPolicySchema>;
export type FxRateDto = Static<typeof FxRateSchema>;
export type FxQuote = Static<typeof FxQuoteSchema>;
export type VerifiableCredential = Static<typeof VerifiableCredentialSchema>;
export type BuyerDecision = Static<typeof BuyerDecisionSchema>;
export type WorkEvidence = Static<typeof WorkEvidenceSchema>;
export type AlgorandNetwork = Static<typeof AlgorandNetworkSchema>;
export type EscrowBinding = Static<typeof EscrowBindingSchema>;
export type ReleaseAuthorization = Static<typeof ReleaseAuthorizationSchema>;
export type ComplianceOutcome = Static<typeof ComplianceOutcomeSchema>;
export type ComplianceResult = Static<typeof ComplianceResultSchema>;
export type PaymentState = Static<typeof PaymentStateSchema>;
export type WorkContractState = Static<typeof WorkContractStateSchema>;
export type ActorRole = Static<typeof ActorRoleSchema>;
export type Actor = Static<typeof ActorSchema>;
export type HealthResponse = Static<typeof HealthResponseSchema>;
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
