BEGIN;

CREATE TABLE IF NOT EXISTS algorand_executor_commands (
  idempotency_key varchar(256) PRIMARY KEY,
  action varchar(16) NOT NULL CHECK (action IN ('create', 'fund', 'release', 'pause', 'resume', 'refund', 'complete')),
  command_hash char(71) NOT NULL CHECK (command_hash ~ '^sha256:[a-f0-9]{64}$'),
  permit_jti varchar(128) NOT NULL,
  permit_claims jsonb NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('PENDING', 'PREPARED', 'SUCCEEDED')),
  prepared jsonb,
  response jsonb,
  transaction_id char(52) CHECK (transaction_id IS NULL OR transaction_id ~ '^[A-Z2-7]{52}$'),
  confirmed_round numeric(20, 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'PENDING' AND prepared IS NULL AND response IS NULL)
    OR (status = 'PREPARED' AND prepared IS NOT NULL AND response IS NULL AND transaction_id IS NOT NULL)
    OR (status = 'SUCCEEDED' AND prepared IS NOT NULL AND response IS NOT NULL AND transaction_id IS NOT NULL AND confirmed_round IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS algorand_executor_permits (
  jti varchar(128) PRIMARY KEY,
  idempotency_key varchar(256) NOT NULL REFERENCES algorand_executor_commands(idempotency_key),
  command_hash char(71) NOT NULL CHECK (command_hash ~ '^sha256:[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS algorand_executor_escrows (
  deal_id varchar(128) PRIMARY KEY,
  immutable_binding_hash char(71) NOT NULL CHECK (immutable_binding_hash ~ '^sha256:[a-f0-9]{64}$'),
  binding jsonb NOT NULL,
  projection jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS algorand_executor_commands_status_idx
  ON algorand_executor_commands(status, updated_at);

COMMIT;
