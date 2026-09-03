BEGIN;

CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
  component text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (component, version)
);

CREATE TABLE IF NOT EXISTS gateway_idempotency_records (
  actor_scope_hash char(64) NOT NULL,
  idempotency_key_hash char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  state text NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  owner_token uuid,
  lease_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_scope_hash, idempotency_key_hash),
  CHECK (actor_scope_hash ~ '^[0-9a-f]{64}$'),
  CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (
    (state = 'IN_PROGRESS' AND response_json IS NULL)
    OR (state = 'COMPLETED' AND owner_token IS NULL AND lease_expires_at IS NULL AND response_json IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS gateway_idempotency_records_expiry_idx
  ON gateway_idempotency_records (expires_at);

INSERT INTO gateway_schema_migrations (component, version, checksum)
VALUES (
  'gateway-idempotency',
  1,
  '1cc83dd5dcb5578daf9ae1eb8a106e8246688aef9da3a19d67ec99c462a9a9c2'
)
ON CONFLICT (component, version) DO NOTHING;

COMMIT;
