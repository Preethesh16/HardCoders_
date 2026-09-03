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
  destinationCountry: CountryCodeSchema,
  budget: MoneyInput,
}, { additionalProperties: false });

export const CreateApplicationBody = Type.Object({
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
  policies: AgreementTermList,
  legalClauses: Type.Array(Type.String({ minLength: 2, maxLength: 2_000 }), {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  }),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 2, maxLength: 2_000 }), {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  }),
  commercialTerms: AgreementTermList,
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

export const CreateQuoteBody = Type.Object({
  originCountry: CountryCodeSchema,
  destinationCountry: CountryCodeSchema,
  fundingAmount: MoneyInput,
}, { additionalProperties: false });

export const CreateSubmissionBody = Type.Object({
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
    code: Type.Union([
      Type.Literal('INVOICE'),
      Type.Literal('FORM_A2_DEMO'),
      Type.Literal('TAX_REVIEW_DEMO'),
      Type.Literal('IMPORT_EVIDENCE'),
      Type.Literal('BUYER_DUE_DILIGENCE'),
    ]),
    contentType: Type.String({ minLength: 3, maxLength: 128 }),
    contentBase64: Type.String({ minLength: 4, maxLength: 8_000_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }),
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
