BEGIN;

-- PENDING means no signed transaction bytes exist. Once the exact persisted
-- Fabric release lease has expired, the reservation can be terminally
-- cancelled without any Algorand ambiguity and must never become PREPARED.
ALTER TABLE algorand_executor_commands
  ADD COLUMN IF NOT EXISTS cancellation_time timestamptz;

ALTER TABLE algorand_executor_commands
  DROP CONSTRAINT IF EXISTS algorand_executor_commands_status_v3_check,
  DROP CONSTRAINT IF EXISTS algorand_executor_commands_state_v3_check,
  DROP CONSTRAINT IF EXISTS algorand_executor_commands_status_v4_check,
  DROP CONSTRAINT IF EXISTS algorand_executor_commands_state_v4_check;

ALTER TABLE algorand_executor_commands
  ADD CONSTRAINT algorand_executor_commands_status_v4_check
    CHECK (status IN ('PENDING', 'PREPARED', 'CANCELLED', 'ABANDONED', 'SUCCEEDED')),
  ADD CONSTRAINT algorand_executor_commands_state_v4_check
    CHECK (
      (status = 'PENDING'
        AND prepared IS NULL AND response IS NULL
        AND transaction_id IS NULL AND confirmed_round IS NULL
        AND abandonment_round IS NULL AND cancellation_time IS NULL)
      OR (status = 'PREPARED'
        AND prepared IS NOT NULL AND response IS NULL
        AND transaction_id IS NOT NULL AND confirmed_round IS NULL
        AND abandonment_round IS NULL AND cancellation_time IS NULL)
      OR (status = 'CANCELLED'
        AND action = 'release'
        AND permit_claims @> '{"action":"release"}'::jsonb
        AND (permit_claims #>> '{releaseAuthorization,leaseExpiresAt}') IS NOT NULL
        AND prepared IS NULL AND response IS NULL
        AND transaction_id IS NULL AND confirmed_round IS NULL
        AND abandonment_round IS NULL AND cancellation_time IS NOT NULL
        AND cancellation_time >= (permit_claims #>> '{releaseAuthorization,leaseExpiresAt}')::timestamptz)
      OR (status = 'ABANDONED'
        AND prepared IS NOT NULL AND response IS NULL
        AND transaction_id IS NOT NULL AND confirmed_round IS NULL
        AND abandonment_round IS NOT NULL AND cancellation_time IS NULL
        AND abandonment_round >= (prepared ->> 'lastValidRound')::numeric)
      OR (status = 'SUCCEEDED'
        AND prepared IS NOT NULL AND response IS NOT NULL
        AND transaction_id IS NOT NULL AND confirmed_round IS NOT NULL
        AND abandonment_round IS NULL AND cancellation_time IS NULL)
    );

COMMIT;
