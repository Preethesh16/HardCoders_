import { Type, type Static } from '@sinclair/typebox';

const Strict = { additionalProperties: false } as const;
const Identifier = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' });
const EvidenceIdentifier = Type.String({ minLength: 6, maxLength: 64, pattern: '^EVID-[A-Z0-9][A-Z0-9-]*$' });
const Hash = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });

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
  expectedFileHash: Hash,
  expectedVersion: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  escrowBindingHash: Hash,
  complianceResultHash: Hash,
  fxQuoteHash: Hash,
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  command: Type.Object({
    action: Type.Literal('release'),
    method: Type.Literal('POST'),
    path: Type.String({ minLength: 1, maxLength: 512, pattern: '^/v1/' }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9._:-]+$' }),
    body: Type.Unknown(),
  }, Strict),
}, Strict);
export type ReleasePermitBody = Static<typeof ReleasePermitBodySchema>;
