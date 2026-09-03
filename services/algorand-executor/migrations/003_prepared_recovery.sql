BEGIN;

-- A signed command may be released from the per-deal serialization fence only
-- after the executor has observed a committed Algorand round at or beyond the
-- transaction group's lastValidRound and scanned every block in its signed
-- validity window without finding the transaction.
ALTER TABLE algorand_executor_commands
  ADD COLUMN IF NOT EXISTS abandonment_round numeric(20, 0);

-- 001 used unnamed checks, whose PostgreSQL-generated names are stable. Once
-- 004 owns the current state constraint this earlier migration must be a no-op
-- on restart, including when terminal CANCELLED rows already exist.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'algorand_executor_commands'::regclass
      AND conname = 'algorand_executor_commands_state_v4_check'
  ) THEN
    ALTER TABLE algorand_executor_commands
      DROP CONSTRAINT IF EXISTS algorand_executor_commands_status_check,
      DROP CONSTRAINT IF EXISTS algorand_executor_commands_check,
      DROP CONSTRAINT IF EXISTS algorand_executor_commands_status_v3_check,
      DROP CONSTRAINT IF EXISTS algorand_executor_commands_state_v3_check;

    ALTER TABLE algorand_executor_commands
      ADD CONSTRAINT algorand_executor_commands_status_v3_check
        CHECK (status IN ('PENDING', 'PREPARED', 'ABANDONED', 'SUCCEEDED')),
      ADD CONSTRAINT algorand_executor_commands_state_v3_check
        CHECK (
          (status = 'PENDING'
            AND prepared IS NULL AND response IS NULL
            AND transaction_id IS NULL AND confirmed_round IS NULL AND abandonment_round IS NULL)
          OR (status = 'PREPARED'
            AND prepared IS NOT NULL AND response IS NULL
            AND transaction_id IS NOT NULL AND confirmed_round IS NULL AND abandonment_round IS NULL)
          OR (status = 'ABANDONED'
            AND prepared IS NOT NULL AND response IS NULL
            AND transaction_id IS NOT NULL AND confirmed_round IS NULL
            AND abandonment_round IS NOT NULL
            AND abandonment_round >= (prepared ->> 'lastValidRound')::numeric)
          OR (status = 'SUCCEEDED'
            AND prepared IS NOT NULL AND response IS NOT NULL
            AND transaction_id IS NOT NULL AND confirmed_round IS NOT NULL AND abandonment_round IS NULL)
        );
  END IF;
END
$migration$;

COMMIT;
