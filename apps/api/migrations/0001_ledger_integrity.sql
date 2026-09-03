-- Integrity the schema generator cannot express.
--
-- These constraints are the difference between "the application tries to keep
-- the books right" and "the database will not store books that are wrong".

--> statement-breakpoint
-- Referential integrity for the aggregates the workflow walks.
ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
  ADD CONSTRAINT "memberships_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "credentials"
  ADD CONSTRAINT "credentials_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "credential_status"
  ADD CONSTRAINT "credential_status_credential_fk" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id");
--> statement-breakpoint
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id"),
  ADD CONSTRAINT "jobs_creator_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_job_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id"),
  ADD CONSTRAINT "applications_user_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "users"("id"),
  ADD CONSTRAINT "applications_organization_fk" FOREIGN KEY ("applicant_organization_id") REFERENCES "organizations"("id");
--> statement-breakpoint
ALTER TABLE "ai_evaluations"
  ADD CONSTRAINT "ai_evaluations_application_fk" FOREIGN KEY ("application_id") REFERENCES "applications"("id");
--> statement-breakpoint
ALTER TABLE "ai_evaluation_citations"
  ADD CONSTRAINT "ai_citations_evaluation_fk" FOREIGN KEY ("evaluation_id") REFERENCES "ai_evaluations"("id");
--> statement-breakpoint
ALTER TABLE "work_contracts"
  ADD CONSTRAINT "work_contracts_job_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id"),
  ADD CONSTRAINT "work_contracts_application_fk" FOREIGN KEY ("application_id") REFERENCES "applications"("id");
--> statement-breakpoint
ALTER TABLE "contract_approvals"
  ADD CONSTRAINT "contract_approvals_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "work_contracts"("id");
--> statement-breakpoint
ALTER TABLE "compliance_results"
  ADD CONSTRAINT "compliance_results_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "work_contracts"("id");
--> statement-breakpoint
ALTER TABLE "required_documents"
  ADD CONSTRAINT "required_documents_result_fk" FOREIGN KEY ("compliance_result_id") REFERENCES "compliance_results"("id"),
  ADD CONSTRAINT "required_documents_hash_fk" FOREIGN KEY ("document_hash_id") REFERENCES "document_hashes"("id");
--> statement-breakpoint
ALTER TABLE "document_hashes"
  ADD CONSTRAINT "document_hashes_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "work_contracts"("id"),
  ADD CONSTRAINT "document_hashes_object_fk" FOREIGN KEY ("object_id") REFERENCES "uploaded_objects"("id");
--> statement-breakpoint
ALTER TABLE "fx_quotes"
  ADD CONSTRAINT "fx_quotes_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "work_contracts"("id");
--> statement-breakpoint
ALTER TABLE "fx_quote_legs"
  ADD CONSTRAINT "fx_quote_legs_quote_fk" FOREIGN KEY ("quote_id") REFERENCES "fx_quotes"("id");
--> statement-breakpoint
ALTER TABLE "payment_instructions"
  ADD CONSTRAINT "payment_instructions_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "work_contracts"("id"),
  ADD CONSTRAINT "payment_instructions_quote_fk" FOREIGN KEY ("quote_id") REFERENCES "fx_quotes"("id"),
  ADD CONSTRAINT "payment_instructions_compliance_fk" FOREIGN KEY ("compliance_result_id") REFERENCES "compliance_results"("id");
--> statement-breakpoint
ALTER TABLE "escrow_bindings"
  ADD CONSTRAINT "escrow_bindings_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "payment_instructions"("id");
--> statement-breakpoint
ALTER TABLE "provider_commands"
  ADD CONSTRAINT "provider_commands_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "payment_instructions"("id");
--> statement-breakpoint
ALTER TABLE "reconciliation_records"
  ADD CONSTRAINT "reconciliation_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "payment_instructions"("id");
--> statement-breakpoint
ALTER TABLE "work_submissions"
  ADD CONSTRAINT "work_submissions_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "work_contracts"("id"),
  ADD CONSTRAINT "work_submissions_object_fk" FOREIGN KEY ("object_id") REFERENCES "uploaded_objects"("id");

--> statement-breakpoint
-- Direction and book membership are immutable facts about an account.
ALTER TABLE "fiat_accounts"
  ADD CONSTRAINT "fiat_accounts_direction_check" CHECK ("direction" IN ('INWARD', 'OUTWARD')),
  ADD CONSTRAINT "fiat_accounts_scale_check" CHECK ("scale" BETWEEN 0 AND 8);
--> statement-breakpoint
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_direction_check" CHECK ("direction" IN ('INWARD', 'OUTWARD')),
  ADD CONSTRAINT "journal_entries_scale_check" CHECK ("scale" BETWEEN 0 AND 8);

--> statement-breakpoint
-- A journal line may only reference an account in the SAME book, direction,
-- currency and scale as its entry. Inward and outward books therefore cannot be
-- netted, and a mixed-denomination entry cannot exist, even under direct SQL.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_side_check" CHECK ("side" IN ('DEBIT', 'CREDIT')),
  ADD CONSTRAINT "journal_lines_positive_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "journal_lines_entry_denomination_fk"
    FOREIGN KEY ("entry_id", "book_id", "direction", "currency", "scale")
    REFERENCES "journal_entries"("id", "book_id", "direction", "currency", "scale"),
  ADD CONSTRAINT "journal_lines_account_denomination_fk"
    FOREIGN KEY ("account_id", "book_id", "direction", "currency", "scale")
    REFERENCES "fiat_accounts"("id", "book_id", "direction", "currency", "scale");

--> statement-breakpoint
-- Double entry, enforced at commit rather than trusted to the application.
CREATE OR REPLACE FUNCTION optiwork_assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  debits numeric(38, 0);
  credits numeric(38, 0);
  lines integer;
BEGIN
  SELECT
    COALESCE(SUM(amount_minor) FILTER (WHERE side = 'DEBIT'), 0),
    COALESCE(SUM(amount_minor) FILTER (WHERE side = 'CREDIT'), 0),
    COUNT(*)
  INTO debits, credits, lines
  FROM journal_lines
  WHERE entry_id = NEW.id;

  IF lines < 2 THEN
    RAISE EXCEPTION 'journal entry % needs at least two lines', NEW.id;
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', NEW.id, debits, credits;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "journal_entries_balanced"
  AFTER INSERT OR UPDATE ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION optiwork_assert_entry_balanced();

--> statement-breakpoint
-- Non-negative fixed-point money everywhere it is stored.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_budget_check" CHECK ("budget_amount_minor" >= 0);
--> statement-breakpoint
ALTER TABLE "work_contracts" ADD CONSTRAINT "work_contracts_amount_check" CHECK ("amount_minor" > 0);
--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_amounts_check" CHECK (
  "funding_amount_minor" > 0 AND "settlement_amount_minor" > 0
  AND "payout_amount_minor" > 0 AND "fees_minor_total" >= 0
);
--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_expiry_check" CHECK ("expires_at" > "quoted_at");
--> statement-breakpoint
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_amounts_check" CHECK (
  "funding_amount_minor" > 0 AND "payout_amount_minor" > 0
);
--> statement-breakpoint
ALTER TABLE "payment_instructions"
  ADD CONSTRAINT "payment_instructions_direction_check" CHECK ("direction" IN ('INWARD', 'OUTWARD'));
--> statement-breakpoint
ALTER TABLE "escrow_bindings" ADD CONSTRAINT "escrow_bindings_amount_check" CHECK (
  "amount_usdc_minor" > 0 AND "scale" = 6
);
--> statement-breakpoint
-- MainNet can never be recorded as a settlement network.
ALTER TABLE "escrow_bindings"
  ADD CONSTRAINT "escrow_bindings_network_check" CHECK ("network" IN ('localnet', 'testnet'));
