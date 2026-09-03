CREATE TABLE "ai_evaluation_citations" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"evaluation_id" varchar(128) NOT NULL,
	"ordinal" integer NOT NULL,
	"source_uri" text NOT NULL,
	"source_version" varchar(128) NOT NULL,
	"quote" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_evaluations" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"application_id" varchar(128) NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"score" integer NOT NULL,
	"summary" text NOT NULL,
	"advisory_only" boolean DEFAULT true NOT NULL,
	"source" varchar(16) NOT NULL,
	"model" varchar(64) NOT NULL,
	"fixture_id" varchar(64),
	"prompt_hash" varchar(71) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"job_id" varchar(128) NOT NULL,
	"applicant_user_id" varchar(128) NOT NULL,
	"applicant_organization_id" varchar(128) NOT NULL,
	"cover_letter" text NOT NULL,
	"resume_object_id" varchar(128),
	"status" varchar(24) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_results" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"contract_id" varchar(128) NOT NULL,
	"corridor_id" varchar(128) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"reasons" jsonb NOT NULL,
	"policy_version" varchar(128) NOT NULL,
	"rules_version" varchar(128) NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"canonical_hash" varchar(71) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_approvals" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"contract_id" varchar(128) NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"party" varchar(16) NOT NULL,
	"approval_hash" varchar(71) NOT NULL,
	"approved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corridor_policies" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"origin_country" varchar(2) NOT NULL,
	"destination_country" varchar(2) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"status" varchar(16) NOT NULL,
	"funding_currency" varchar(3) NOT NULL,
	"payout_currency" varchar(3) NOT NULL,
	"policy" jsonb NOT NULL,
	"source_uri" text NOT NULL,
	"source_version" varchar(128) NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"canonical_hash" varchar(71) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_status" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"credential_id" varchar(128) NOT NULL,
	"status" varchar(16) NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"subject_did" text NOT NULL,
	"issuer_did" text NOT NULL,
	"subject_commitment" varchar(71) NOT NULL,
	"subject_type" varchar(16) NOT NULL,
	"country" varchar(2) NOT NULL,
	"assurance_level" varchar(16) NOT NULL,
	"issued_at" varchar(40) NOT NULL,
	"expires_at" varchar(40) NOT NULL,
	"signature" text NOT NULL,
	"issuer_public_key_pem" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_hashes" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"contract_id" varchar(128) NOT NULL,
	"code" varchar(64) NOT NULL,
	"object_id" varchar(128) NOT NULL,
	"sha256" varchar(71) NOT NULL,
	"byte_length" numeric(20, 0) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_bindings" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"payment_id" varchar(128) NOT NULL,
	"deal_id" varchar(128) NOT NULL,
	"payment_key" varchar(71) NOT NULL,
	"agreement_hash" varchar(71) NOT NULL,
	"network" varchar(16) NOT NULL,
	"genesis_hash" text NOT NULL,
	"application_id" numeric(20, 0) NOT NULL,
	"asset_id" numeric(20, 0) NOT NULL,
	"origin_provider_address" varchar(58) NOT NULL,
	"destination_provider_address" varchar(58) NOT NULL,
	"amount_usdc_minor" numeric(38, 0) NOT NULL,
	"scale" smallint NOT NULL,
	"binding_hash" varchar(71) NOT NULL,
	"state" varchar(24) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "escrow_bindings_payment_id_unique" UNIQUE("payment_id"),
	CONSTRAINT "escrow_bindings_deal_id_unique" UNIQUE("deal_id")
);
--> statement-breakpoint
CREATE TABLE "fiat_accounts" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"book_id" varchar(32) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"owner_kind" varchar(24) NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"account_type" varchar(24) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"scale" smallint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_quote_legs" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"quote_id" varchar(128) NOT NULL,
	"ordinal" integer NOT NULL,
	"pair" varchar(7) NOT NULL,
	"rate_units" numeric(38, 0) NOT NULL,
	"rate_scale" smallint NOT NULL,
	"from_amount_minor" numeric(38, 0) NOT NULL,
	"to_amount_minor" numeric(38, 0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_quotes" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"contract_id" varchar(128) NOT NULL,
	"corridor_id" varchar(128) NOT NULL,
	"funding_amount_minor" numeric(38, 0) NOT NULL,
	"funding_currency" varchar(3) NOT NULL,
	"funding_scale" smallint NOT NULL,
	"settlement_amount_minor" numeric(38, 0) NOT NULL,
	"settlement_scale" smallint NOT NULL,
	"payout_amount_minor" numeric(38, 0) NOT NULL,
	"payout_currency" varchar(3) NOT NULL,
	"payout_scale" smallint NOT NULL,
	"fees_minor_total" numeric(38, 0) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"rate_source" varchar(32) NOT NULL,
	"rate_observed_at" timestamp with time zone NOT NULL,
	"quoted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"canonical_hash" varchar(71) NOT NULL,
	"quote" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"scope" varchar(64) NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"subject" varchar(128) NOT NULL,
	"fingerprint" varchar(71) NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"created_by_user_id" varchar(128) NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"skills" jsonb NOT NULL,
	"destination_country" varchar(2) NOT NULL,
	"budget_amount_minor" numeric(38, 0) NOT NULL,
	"budget_currency" varchar(3) NOT NULL,
	"budget_scale" smallint NOT NULL,
	"status" varchar(24) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"book_id" varchar(32) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"scale" smallint NOT NULL,
	"payment_id" varchar(128),
	"reference" varchar(128) NOT NULL,
	"memo" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"entry_hash" varchar(71) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"entry_id" varchar(128) NOT NULL,
	"account_id" varchar(128) NOT NULL,
	"book_id" varchar(32) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"scale" smallint NOT NULL,
	"ordinal" integer NOT NULL,
	"side" varchar(6) NOT NULL,
	"amount_minor" numeric(38, 0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"role" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"country" varchar(2) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_instructions" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"contract_id" varchar(128) NOT NULL,
	"corridor_id" varchar(128) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"book_id" varchar(32) NOT NULL,
	"quote_id" varchar(128) NOT NULL,
	"compliance_result_id" varchar(128) NOT NULL,
	"state" varchar(32) NOT NULL,
	"funding_amount_minor" numeric(38, 0) NOT NULL,
	"funding_currency" varchar(3) NOT NULL,
	"funding_scale" smallint NOT NULL,
	"payout_amount_minor" numeric(38, 0) NOT NULL,
	"payout_currency" varchar(3) NOT NULL,
	"payout_scale" smallint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_commands" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"payment_id" varchar(128) NOT NULL,
	"action" varchar(16) NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"request_hash" varchar(71) NOT NULL,
	"status" varchar(16) NOT NULL,
	"transaction_id" varchar(52),
	"confirmed_round" numeric(20, 0),
	"response" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_commands_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_records" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"payment_id" varchar(128) NOT NULL,
	"scope" varchar(24) NOT NULL,
	"status" varchar(24) NOT NULL,
	"expected" jsonb NOT NULL,
	"observed" jsonb NOT NULL,
	"detail" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "required_documents" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"compliance_result_id" varchar(128) NOT NULL,
	"code" varchar(64) NOT NULL,
	"satisfied" boolean NOT NULL,
	"document_hash_id" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"contract_id" varchar(128),
	"payment_id" varchar(128),
	"sequence" integer NOT NULL,
	"kind" varchar(48) NOT NULL,
	"actor_subject" varchar(128) NOT NULL,
	"actor_role" varchar(32) NOT NULL,
	"detail" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploaded_objects" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"bucket" varchar(64) NOT NULL,
	"object_key" text NOT NULL,
	"content_type" varchar(128) NOT NULL,
	"byte_length" numeric(20, 0) NOT NULL,
	"sha256" varchar(71) NOT NULL,
	"owner_organization_id" varchar(128) NOT NULL,
	"classification" varchar(24) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"subject" varchar(128) NOT NULL,
	"display_name" text NOT NULL,
	"country" varchar(2) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_subject_unique" UNIQUE("subject")
);
--> statement-breakpoint
CREATE TABLE "work_contracts" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"job_id" varchar(128) NOT NULL,
	"application_id" varchar(128) NOT NULL,
	"buyer_organization_id" varchar(128) NOT NULL,
	"provider_organization_id" varchar(128) NOT NULL,
	"provider_user_id" varchar(128) NOT NULL,
	"state" varchar(32) NOT NULL,
	"terms" text NOT NULL,
	"contract_hash" varchar(71) NOT NULL,
	"milestone_id" varchar(128) NOT NULL,
	"milestone_hash" varchar(71) NOT NULL,
	"amount_minor" numeric(38, 0) NOT NULL,
	"amount_currency" varchar(3) NOT NULL,
	"amount_scale" smallint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_submissions" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"contract_id" varchar(128) NOT NULL,
	"version" integer NOT NULL,
	"object_id" varchar(128) NOT NULL,
	"file_hash" varchar(71) NOT NULL,
	"evidence_hash" varchar(71) NOT NULL,
	"fabric_tx_id" varchar(128),
	"buyer_decision" varchar(24) NOT NULL,
	"buyer_decision_hash" varchar(71),
	"decided_at" timestamp with time zone,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_citation_ordinal_idx" ON "ai_evaluation_citations" USING btree ("evaluation_id","ordinal");--> statement-breakpoint
CREATE INDEX "ai_evaluations_application_idx" ON "ai_evaluations" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_job_applicant_idx" ON "applications" USING btree ("job_id","applicant_user_id");--> statement-breakpoint
CREATE INDEX "compliance_results_contract_idx" ON "compliance_results" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_approvals_party_idx" ON "contract_approvals" USING btree ("contract_id","party");--> statement-breakpoint
CREATE INDEX "credential_status_credential_idx" ON "credential_status" USING btree ("credential_id","recorded_at");--> statement-breakpoint
CREATE INDEX "document_hashes_contract_idx" ON "document_hashes" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "fiat_accounts_book_idx" ON "fiat_accounts" USING btree ("book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fiat_accounts_denomination_idx" ON "fiat_accounts" USING btree ("id","book_id","direction","currency","scale");--> statement-breakpoint
CREATE UNIQUE INDEX "fiat_accounts_owner_type_idx" ON "fiat_accounts" USING btree ("book_id","owner_kind","owner_id","account_type","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_quote_legs_ordinal_idx" ON "fx_quote_legs" USING btree ("quote_id","ordinal");--> statement-breakpoint
CREATE INDEX "fx_quotes_contract_idx" ON "fx_quotes" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key_idx" ON "idempotency_records" USING btree ("scope","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_organization_idx" ON "jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_book_reference_idx" ON "journal_entries" USING btree ("book_id","reference");--> statement-breakpoint
CREATE INDEX "journal_entries_payment_idx" ON "journal_entries" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_denomination_idx" ON "journal_entries" USING btree ("id","book_id","direction","currency","scale");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_ordinal_idx" ON "journal_lines" USING btree ("entry_id","ordinal");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_role_idx" ON "memberships" USING btree ("user_id","organization_id","role");--> statement-breakpoint
CREATE INDEX "payment_instructions_contract_idx" ON "payment_instructions" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "provider_commands_payment_idx" ON "provider_commands" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "reconciliation_payment_idx" ON "reconciliation_records" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "required_documents_code_idx" ON "required_documents" USING btree ("compliance_result_id","code");--> statement-breakpoint
CREATE INDEX "timeline_events_contract_idx" ON "timeline_events" USING btree ("contract_id","sequence");--> statement-breakpoint
CREATE INDEX "timeline_events_payment_idx" ON "timeline_events" USING btree ("payment_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uploaded_objects_key_idx" ON "uploaded_objects" USING btree ("bucket","object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "work_submissions_version_idx" ON "work_submissions" USING btree ("contract_id","version");