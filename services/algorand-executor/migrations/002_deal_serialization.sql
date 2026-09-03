BEGIN;

-- 001 was published without deal_id. Keep that migration immutable and make
-- this upgrade safe for databases where 001 has already run.
ALTER TABLE algorand_executor_commands
  ADD COLUMN IF NOT EXISTS deal_id varchar(128);

-- Older commands retain the exact authoritative Fabric read path in their
-- signed permit claims. Only an unescaped canonical deal segment can be
-- recovered without guessing. Encoded/absent paths fail below and require an
-- operator-reviewed rebuild or backfill.
-- Legacy one-time backfill only. Current permits use /v1/evidence/:id/projection
-- and new command rows persist deal_id explicitly before this constraint runs.
UPDATE algorand_executor_commands
SET deal_id = substring(
  permit_claims #>> '{authoritativeReads,0,path}'
  FROM '^/ledger/deals/([A-Za-z0-9][A-Za-z0-9._:-]*)/'
)
WHERE deal_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM algorand_executor_commands
    WHERE deal_id IS NULL
      OR deal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot safely derive deal_id for existing Algorand executor commands.',
      HINT = 'Rebuild this staging database, or perform an operator-reviewed backfill from immutable command evidence before rerunning 002.';
  END IF;
END
$$;

ALTER TABLE algorand_executor_commands
  ALTER COLUMN deal_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'algorand_executor_commands'::regclass
      AND conname = 'algorand_executor_commands_deal_id_check'
  ) THEN
    ALTER TABLE algorand_executor_commands
      ADD CONSTRAINT algorand_executor_commands_deal_id_check
      CHECK (deal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$');
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS algorand_executor_commands_transaction_idx
  ON algorand_executor_commands(transaction_id)
  WHERE transaction_id IS NOT NULL;

-- A crashed PENDING/PREPARED command must be reconciled with its original
-- idempotency key before a later mutation may move the same deal.
CREATE UNIQUE INDEX IF NOT EXISTS algorand_executor_one_active_command_per_deal_idx
  ON algorand_executor_commands(deal_id)
  WHERE status IN ('PENDING', 'PREPARED');

COMMIT;
