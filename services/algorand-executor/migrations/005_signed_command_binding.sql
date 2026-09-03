BEGIN;

-- Every signed transaction group must carry the v2 command envelope. The
-- envelope binds the independently stored command hash to all group txids and
-- to a canonical semantic binding that the executor recomputes before any
-- Algod lookup or broadcast. Existing legacy PREPARED/SUCCEEDED rows fail this
-- migration closed and require governed reconciliation before rollout.
ALTER TABLE algorand_executor_commands
  DROP CONSTRAINT IF EXISTS algorand_executor_commands_prepared_v2_check;

ALTER TABLE algorand_executor_commands
  ADD CONSTRAINT algorand_executor_commands_prepared_v2_check
    CHECK (
      prepared IS NULL
      OR (
        jsonb_typeof(prepared) = 'object'
        AND prepared ->> 'schemaVersion' = '2.0'
        AND prepared ->> 'commandHash' = command_hash
        AND prepared ->> 'commandBindingHash' ~ '^sha256:[0-9a-f]{64}$'
        AND prepared ->> 'transactionId' = transaction_id
        AND prepared ->> 'lastValidRound' ~ '^[1-9][0-9]{0,19}$'
        AND (prepared ->> 'lastValidRound')::numeric <= 18446744073709551615
        AND jsonb_typeof(prepared -> 'transactionIds') = 'array'
        AND jsonb_typeof(prepared -> 'signedTransactionsBase64') = 'array'
        AND jsonb_array_length(prepared -> 'transactionIds') BETWEEN 1 AND 16
        AND jsonb_array_length(prepared -> 'transactionIds')
          = jsonb_array_length(prepared -> 'signedTransactionsBase64')
        AND prepared -> 'transactionIds' ->>
          (jsonb_array_length(prepared -> 'transactionIds') - 1) = transaction_id
      )
    );

COMMIT;
