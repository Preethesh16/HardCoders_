ALTER TABLE "compliance_results"
  ADD COLUMN "applied_rules" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "citations" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "inr_equivalent" jsonb NOT NULL DEFAULT '{"amountMinor":"0","currency":"INR","scale":2}'::jsonb;
--> statement-breakpoint
ALTER TABLE "required_documents"
  ADD COLUMN "reason" text NOT NULL DEFAULT 'Recorded before schema version 0002.',
  ADD COLUMN "citation" jsonb NOT NULL DEFAULT '{"sourceUri":"https://example.invalid/legacy","sourceVersion":"legacy","section":"legacy","quote":"Legacy decision without a persisted citation."}'::jsonb;
--> statement-breakpoint
ALTER TABLE "compliance_results"
  ALTER COLUMN "applied_rules" DROP DEFAULT,
  ALTER COLUMN "citations" DROP DEFAULT,
  ALTER COLUMN "inr_equivalent" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "required_documents"
  ALTER COLUMN "reason" DROP DEFAULT,
  ALTER COLUMN "citation" DROP DEFAULT;
