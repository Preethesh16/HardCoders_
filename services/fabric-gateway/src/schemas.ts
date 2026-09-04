import { Type, type Static } from '@sinclair/typebox';

const Strict = { additionalProperties: false } as const;
const Identifier = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
const EvidenceIdentifier = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
const Hash = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const PositiveIntegerString = Type.String({ pattern: '^[1-9][0-9]*$' });
const IdempotencyKey = Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9._:-]+$' });
const AlgorandAddress = Type.String({ pattern: '^[A-Z2-7]{58}$' });

export const EvidenceParamsSchema = Type.Object({ evidenceId: EvidenceIdentifier }, Strict);
export type EvidenceParams = Static<typeof EvidenceParamsSchema>;

export const MutationHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9._:-]+$' }),
  'x-correlation-id': Type.Optional(Identifier),
  'x-demo-subject': Type.Optional(Identifier),
  'x-demo-organization': Type.Optional(Identifier),
  'x-demo-role': Type.Optional(Identifier),
}, { additionalProperties: true });
export type MutationHeaders = Static<typeof MutationHeadersSchema>;

export const QueryHeadersSchema = Type.Object({
  'x-demo-subject': Type.Optional(Identifier),
  'x-demo-organization': Type.Optional(Identifier),
  'x-demo-role': Type.Optional(Identifier),
}, { additionalProperties: true });
export type QueryHeaders = Static<typeof QueryHeadersSchema>;

export const SubmitEvidenceBodySchema = Type.Object({
  evidenceId: EvidenceIdentifier,
  contractHash: Hash,
  milestoneHash: Hash,
  fileHash: Hash,
  buyerOrganizationRef: Type.String({ pattern: '^buyer:[a-f0-9]{64}$' }),
  version: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
}, Strict);
export type SubmitEvidenceBody = Static<typeof SubmitEvidenceBodySchema>;

export const DecideEvidenceBodySchema = Type.Object({
  decision: Type.Union([
    Type.Literal('APPROVED'),
    Type.Literal('REVISION_REQUIRED'),
    Type.Literal('DISPUTED'),
  ]),
  expectedFileHash: Hash,
  expectedVersion: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
}, Strict);
export type DecideEvidenceBody = Static<typeof DecideEvidenceBodySchema>;

export const ReleasePermitBodySchema = Type.Object({
  command: Type.Object({
    action: Type.Literal('release'),
    method: Type.Literal('POST'),
    path: Type.String({ minLength: 1, maxLength: 512, pattern: '^/escrows/' }),
    idempotencyKey: IdempotencyKey,
    body: Type.Object({
      evidenceId: EvidenceIdentifier,
      escrowBinding: Type.Object({
        dealId: Identifier,
        agreementHash: Hash,
        originProviderAddress: AlgorandAddress,
        destinationProviderAddress: AlgorandAddress,
        assetId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        amount: Type.Object({
          amountMinor: PositiveIntegerString,
          currency: Type.String({ minLength: 3, maxLength: 12, pattern: '^[A-Z][A-Z0-9-]*$' }),
          scale: Type.Integer({ minimum: 0, maximum: 8 }),
        }, Strict),
        network: Type.Union([Type.Literal('localnet'), Type.Literal('testnet')]),
        genesisHash: Type.String({ minLength: 16, maxLength: 256 }),
        applicationId: PositiveIntegerString,
      }, Strict),
      milestoneId: Identifier,
      amountMinor: PositiveIntegerString,
      intentId: Identifier,
      bindingHash: Hash,
      fenceGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      leaseExpiresAt: Type.String({ format: 'date-time' }),
      authorizationCommitment: Hash,
      fabricClaimTransactionId: Identifier,
      releaseBinding: Type.Object({
        escrowBindingHash: Hash,
        workEvidenceHash: Hash,
        fabricTxHash: Hash,
        complianceResultHash: Hash,
        fxQuoteHash: Hash,
        settlementRouteHash: Hash,
        generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        idempotencyKey: IdempotencyKey,
        expiresAt: Type.String({ format: 'date-time' }),
      }, Strict),
    }, Strict),
  }, Strict),
}, Strict);
export type ReleasePermitBody = Static<typeof ReleasePermitBodySchema>;

export const GenericPermitBodySchema = Type.Object({
  command: Type.Object({
    action: Type.Union([
      Type.Literal('create'), Type.Literal('fund'), Type.Literal('pause'),
      Type.Literal('resume'), Type.Literal('refund'), Type.Literal('complete'),
    ]),
    method: Type.Literal('POST'),
    path: Type.String({ minLength: 1, maxLength: 512, pattern: '^/escrows(?:/|$)' }),
    idempotencyKey: IdempotencyKey,
    body: Type.Unknown(),
  }, Strict),
}, Strict);
export type GenericPermitBody = Static<typeof GenericPermitBodySchema>;
