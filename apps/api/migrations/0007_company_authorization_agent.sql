CREATE TABLE IF NOT EXISTS "company_verification_profiles" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "version" integer NOT NULL,
  "legal_name" text NOT NULL,
  "country" varchar(2) NOT NULL,
  "registry_authority" varchar(64) NOT NULL,
  "registration_number" varchar(64) NOT NULL,
  "lei" varchar(20),
  "tax_identifier" varchar(64),
  "registered_address" text NOT NULL,
  "entity_status" varchar(32) NOT NULL,
  "directors" jsonb NOT NULL,
  "beneficial_owners" jsonb NOT NULL,
  "source_records" jsonb NOT NULL,
  "sanctions_screening" jsonb NOT NULL,
  "verification_outcome" varchar(32) NOT NULL,
  "verification_reasons" jsonb NOT NULL,
  "profile_hash" varchar(71) NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_verification_profiles_org_version_idx" ON "company_verification_profiles" USING btree ("organization_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_verification_profiles_org_idx" ON "company_verification_profiles" USING btree ("organization_id","verified_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_authorization_decisions" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "subject" varchar(128) NOT NULL,
  "profile_id" varchar(128) NOT NULL,
  "representative_email" text NOT NULL,
  "representative_role" text NOT NULL,
  "authority_basis" text NOT NULL,
  "mandate_reference" text NOT NULL,
  "outcome" varchar(24) NOT NULL,
  "checks" jsonb NOT NULL,
  "citations" jsonb NOT NULL,
  "decision_hash" varchar(71) NOT NULL,
  "decided_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_authorization_decisions_subject_idx" ON "company_authorization_decisions" USING btree ("subject","decided_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_authorization_decisions_org_idx" ON "company_authorization_decisions" USING btree ("organization_id","decided_at");
