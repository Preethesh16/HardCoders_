CREATE TABLE IF NOT EXISTS "company_representative_mandates" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "subject" varchar(128) NOT NULL,
  "representative_email" text NOT NULL,
  "representative_role" text NOT NULL,
  "mandate_reference" varchar(200) NOT NULL,
  "authority_basis" text NOT NULL,
  "status" varchar(16) NOT NULL,
  "valid_from" timestamp with time zone NOT NULL,
  "valid_until" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_representative_mandates_org_subject_ref_idx" ON "company_representative_mandates" USING btree ("organization_id","subject","mandate_reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_representative_mandates_subject_idx" ON "company_representative_mandates" USING btree ("subject","valid_until");
