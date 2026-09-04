/**
 * Request and response schemas.
 *
 * Every route validates at runtime with TypeBox, which is also what makes the
 * surface OpenAPI-describable. Money is always an object of exact minor units
 * plus currency and scale - never a number.
 */

import { Type } from '@sinclair/typebox';
import {
  ActorRoleSchema,
  CountryCodeSchema,
  CurrencySchema,
  IdentifierSchema,
  IsoTimestampSchema,
  MoneySchema,
  Sha256Schema,
  UnsignedIntegerStringSchema,
} from '@optiwork/contracts';

export const ErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    detail: Type.Optional(Type.Unknown()),
    requestId: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const MoneyInput = MoneySchema;

export const JobMilestoneInput = Type.Object({
  title: Type.String({ minLength: 2, maxLength: 200 }),
  description: Type.String({ minLength: 10, maxLength: 4_000 }),
  deliverable: Type.String({ minLength: 3, maxLength: 2_000 }),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 2, maxLength: 2_000 }), {
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
  }),
  amount: MoneyInput,
  dueDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
}, { additionalProperties: false });

export const CreateJobBody = Type.Object({
  title: Type.String({ minLength: 4, maxLength: 200 }),
  description: Type.String({ minLength: 20, maxLength: 8_000 }),
  skills: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 24 }),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 2_000 }), {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  })),
  targetDeliveryDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  payerCountry: CountryCodeSchema,
  fundingCurrency: CurrencySchema,
  destinationCountry: CountryCodeSchema,
  budget: MoneyInput,
  milestones: Type.Optional(Type.Array(JobMilestoneInput, { minItems: 1, maxItems: 5 })),
}, { additionalProperties: false });

export const CreateApplicationBody = Type.Object({
  residenceCountry: CountryCodeSchema,
  payoutCountry: CountryCodeSchema,
  payoutCurrency: CurrencySchema,
  coverLetter: Type.String({ minLength: 20, maxLength: 8_000 }),
  approach: Type.Optional(Type.String({ minLength: 20, maxLength: 8_000 })),
  proposedSkills: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
    minItems: 1,
    maxItems: 24,
    uniqueItems: true,
  })),
  proposedPrice: Type.Optional(MoneyInput),
  deliveryDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 730 })),
  deliveryDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  availability: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
  resumeObjectId: Type.Optional(IdentifierSchema),
}, { additionalProperties: false });

export const ExtractFormBody = Type.Object({
  purpose: Type.Union([Type.Literal('COMPANY_IDENTITY'), Type.Literal('COMPANY_POLICY'), Type.Literal('JOB_BRIEF'), Type.Literal('FREELANCER_PROPOSAL'), Type.Literal('AGREEMENT_TERMS')]),
  fileName: Type.String({ minLength: 1, maxLength: 200 }),
  contentType: Type.String({ minLength: 3, maxLength: 128 }),
  contentBase64: Type.String({ minLength: 4, maxLength: 11_200_000 }),
}, { additionalProperties: false });

const PolicyList = Type.Array(Type.String({ minLength: 2, maxLength: 2_000 }), {
  minItems: 1,
  maxItems: 32,
  uniqueItems: true,
});

export const SaveCompanyPolicyProfileBody = Type.Object({
  companyCountry: CountryCodeSchema,
  fundingCurrency: CurrencySchema,
  fileName: Type.String({ minLength: 1, maxLength: 200 }),
  contentType: Type.String({ minLength: 3, maxLength: 128 }),
  contentBase64: Type.String({ minLength: 4, maxLength: 11_200_000 }),
  policies: PolicyList,
  legalClauses: PolicyList,
  commercialStandards: PolicyList,
  authorizedApprovers: PolicyList,
  extractionSource: Type.Union([Type.Literal('OPENAI'), Type.Literal('FIXTURE')]),
  extractionModel: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

export const EvaluateCompanyAuthorizationBody = Type.Object({
  legalName: Type.String({ minLength: 2, maxLength: 300 }),
  country: CountryCodeSchema,
  registryAuthority: Type.String({ minLength: 2, maxLength: 64 }),
  registrationNumber: Type.String({ minLength: 2, maxLength: 64 }),
  lei: Type.Optional(Type.String({ pattern: '^[A-Z0-9]{20}$' })),
  taxIdentifier: Type.Optional(Type.String({ minLength: 2, maxLength: 64 })),
  registeredAddress: Type.String({ minLength: 8, maxLength: 1_000 }),
  directors: Type.Array(Type.String({ minLength: 2, maxLength: 200 }), { minItems: 1, maxItems: 64, uniqueItems: true }),
  beneficialOwners: Type.Array(Type.Object({
    name: Type.String({ minLength: 2, maxLength: 300 }),
    ownershipPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    controlType: Type.String({ minLength: 2, maxLength: 200 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
  representativeEmail: Type.String({ format: 'email', maxLength: 320 }),
  representativeRole: Type.String({ minLength: 2, maxLength: 160 }),
  authorityBasis: Type.String({ minLength: 12, maxLength: 1_000 }),
  mandateReference: Type.String({ minLength: 4, maxLength: 200 }),
}, { additionalProperties: false });

export const EvaluateApplicationBody = Type.Object({
  select: Type.Optional(Type.Boolean()),
  amount: Type.Optional(MoneyInput),
}, { additionalProperties: false });

export const SelectApplicationBody = Type.Object({
  amount: MoneyInput,
}, { additionalProperties: false });

export const ApproveContractBody = Type.Object({
  party: Type.Union([Type.Literal('BUYER'), Type.Literal('PROVIDER')]),
  acceptedTermsHash: Sha256Schema,
}, { additionalProperties: false });

const AgreementTermList = Type.Array(Type.String({ minLength: 2, maxLength: 2_000 }), {
  maxItems: 32,
  uniqueItems: true,
});

export const PrepareAgreementBody = Type.Object({
  policies: Type.Optional(AgreementTermList),
  legalClauses: Type.Optional(AgreementTermList),
  acceptanceCriteria: Type.Optional(AgreementTermList),
  commercialTerms: Type.Optional(AgreementTermList),
}, { additionalProperties: false });

export const VerifyCredentialBody = Type.Object({
  credentialId: IdentifierSchema,
  expectedCountry: Type.Optional(CountryCodeSchema),
  expectedSubjectType: Type.Optional(Type.Union([
    Type.Literal('COMPANY'), Type.Literal('FREELANCER'), Type.Literal('SUPPLIER'),
  ])),
  expectedAudienceDid: Type.Optional(Type.String({ minLength: 8, maxLength: 256 })),
}, { additionalProperties: false });

export const ResolveCorridorBody = Type.Object({
  originCountry: CountryCodeSchema,
  destinationCountry: CountryCodeSchema,
}, { additionalProperties: false });

export const PreviewComplianceBody = Type.Object({
  originCountry: CountryCodeSchema,
  destinationCountry: CountryCodeSchema,
  inrEquivalentMinor: UnsignedIntegerStringSchema,
  providedDocuments: Type.Array(IdentifierSchema, { maxItems: 32, uniqueItems: true }),
  purposeCode: Type.Optional(IdentifierSchema),
  originAssuranceLevel: Type.Optional(Type.Union([Type.Literal('BASIC'), Type.Literal('ENHANCED')])),
  destinationAssuranceLevel: Type.Optional(Type.Union([Type.Literal('BASIC'), Type.Literal('ENHANCED')])),
  riskSignals: Type.Optional(Type.Array(Type.Union([
    Type.Literal('SANCTIONS_PARTY_MATCH'),
    Type.Literal('RESTRICTED_BANK_MATCH'),
    Type.Literal('PROHIBITED_GOODS_OR_SERVICES'),
  ]), { maxItems: 3, uniqueItems: true })),
  fundingAmountMinor: Type.Optional(UnsignedIntegerStringSchema),
}, { additionalProperties: false });

export const CreateQuoteBody = Type.Object({
  originCountry: CountryCodeSchema,
  destinationCountry: CountryCodeSchema,
  fundingAmount: MoneyInput,
}, { additionalProperties: false });

export const CreateSubmissionBody = Type.Object({
  milestoneId: Type.Optional(IdentifierSchema),
  fileName: Type.String({ minLength: 1, maxLength: 200 }),
  contentType: Type.String({ minLength: 3, maxLength: 128 }),
  contentBase64: Type.String({ minLength: 4, maxLength: 24_000_000 }),
  note: Type.String({ minLength: 0, maxLength: 2_000 }),
}, { additionalProperties: false });

export const DecideSubmissionBody = Type.Object({
  decision: Type.Union([
    Type.Literal('APPROVED'), Type.Literal('REVISION_REQUIRED'), Type.Literal('DISPUTED'),
  ]),
  comment: Type.String({ minLength: 0, maxLength: 2_000 }),
}, { additionalProperties: false });

export const CreatePaymentBody = Type.Object({
  contractId: IdentifierSchema,
  milestoneId: Type.Optional(IdentifierSchema),
  fundingAmount: MoneyInput,
  purposeCode: Type.Optional(IdentifierSchema),
}, { additionalProperties: false });

export const RefundPaymentBody = Type.Object({
  reason: Type.String({ minLength: 4, maxLength: 500 }),
}, { additionalProperties: false });

export const SupplierPaymentBody = Type.Object({
  contractId: IdentifierSchema,
  fundingAmount: MoneyInput,
  invoiceReference: Type.String({ minLength: 3, maxLength: 128 }),
  documents: Type.Array(Type.Object({
    code: IdentifierSchema,
    contentType: Type.String({ minLength: 3, maxLength: 128 }),
    contentBase64: Type.String({ minLength: 4, maxLength: 8_000_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

export const RecordDocumentBody = Type.Object({
  code: Type.String({ minLength: 2, maxLength: 64 }),
  contentType: Type.String({ minLength: 3, maxLength: 128 }),
  contentBase64: Type.String({ minLength: 4, maxLength: 8_000_000 }),
}, { additionalProperties: false });

export const IdParams = Type.Object({ id: IdentifierSchema }, { additionalProperties: false });

export const TimelineEventSchema = Type.Object({
  id: IdentifierSchema,
  sequence: Type.Integer(),
  kind: Type.String(),
  actorSubject: Type.String(),
  actorRole: Type.String(),
  detail: Type.Unknown(),
  occurredAt: IsoTimestampSchema,
}, { additionalProperties: true });

export const HealthSchema = Type.Object({
  name: Type.Literal('optiwork-api'),
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  version: Type.String(),
  profile: Type.Union([Type.Literal('demo'), Type.Literal('local'), Type.Literal('testnet')]),
  network: Type.Union([Type.Literal('localnet'), Type.Literal('testnet')]),
  adapters: Type.Object({
    storage: Type.String(),
    ai: Type.String(),
    regulations: Type.String(),
    fx: Type.String(),
    algorand: Type.String(),
    fabric: Type.String(),
    auth: Type.String(),
    database: Type.String(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export {
  ActorRoleSchema,
  CurrencySchema,
  IdentifierSchema,
  IsoTimestampSchema,
  Sha256Schema,
  UnsignedIntegerStringSchema,
};
