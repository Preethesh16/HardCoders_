BEGIN;

CREATE TABLE IF NOT EXISTS optiwork_fabric_event_checkpoint (
  consumer_id text PRIMARY KEY,
  block_number numeric(20, 0),
  transaction_id text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (block_number IS NULL OR block_number >= 0),
  CHECK ((block_number IS NULL) = (transaction_id IS NULL))
);

CREATE TABLE IF NOT EXISTS optiwork_fabric_processed_event (
  consumer_id text NOT NULL,
  block_number numeric(20, 0) NOT NULL CHECK (block_number >= 0),
  transaction_id text NOT NULL,
  event_name text NOT NULL CHECK (event_name IN ('fabric.work_submitted', 'fabric.work_decided')),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_id, transaction_id, event_name)
);

CREATE INDEX IF NOT EXISTS optiwork_fabric_processed_event_position_idx
  ON optiwork_fabric_processed_event (consumer_id, block_number, transaction_id);

COMMIT;
