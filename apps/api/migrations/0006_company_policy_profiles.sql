CREATE TABLE "company_policy_profiles" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"version" integer NOT NULL,
	"country" varchar(2) NOT NULL,
	"funding_currency" varchar(3) NOT NULL,
	"source_object_id" varchar(128) NOT NULL,
	"source_file_name" text NOT NULL,
	"source_artifact_hash" varchar(71) NOT NULL,
	"policies" jsonb NOT NULL,
	"legal_clauses" jsonb NOT NULL,
	"commercial_standards" jsonb NOT NULL,
	"authorized_approvers" jsonb NOT NULL,
	"extraction_source" varchar(16) NOT NULL,
	"extraction_model" varchar(64) NOT NULL,
	"profile_hash" varchar(71) NOT NULL,
	"approved_by_user_id" varchar(128) NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "company_policy_profiles_org_version_idx" ON "company_policy_profiles" USING btree ("organization_id","version");
--> statement-breakpoint
CREATE INDEX "company_policy_profiles_org_idx" ON "company_policy_profiles" USING btree ("organization_id","approved_at");
