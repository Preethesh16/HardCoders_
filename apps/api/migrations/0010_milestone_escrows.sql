ALTER TABLE "jobs" ADD COLUMN "milestones" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE "contract_milestones" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"contract_id" varchar(128) NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"deliverable" text NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"amount_minor" numeric(38, 0) NOT NULL,
	"amount_currency" varchar(3) NOT NULL,
	"amount_scale" smallint NOT NULL,
	"due_date" varchar(10),
	"state" varchar(24) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "contract_milestones_ordinal_idx" ON "contract_milestones" USING btree ("contract_id","ordinal");
--> statement-breakpoint
CREATE INDEX "contract_milestones_state_idx" ON "contract_milestones" USING btree ("contract_id","state");
--> statement-breakpoint
INSERT INTO "contract_milestones" (
	"id", "contract_id", "ordinal", "title", "description", "deliverable",
	"acceptance_criteria", "amount_minor", "amount_currency", "amount_scale",
	"due_date", "state", "created_at", "updated_at"
)
SELECT
	wc."milestone_id", wc."id", 1, j."title", j."description", 'Approved project deliverable',
	COALESCE(j."acceptance_criteria", '[]'::jsonb), wc."amount_minor", wc."amount_currency", wc."amount_scale",
	j."target_delivery_date",
	CASE
		WHEN wc."state" = 'COMPLETED' THEN 'COMPLETED'
		WHEN wc."state" = 'COMPANY_APPROVED' THEN 'APPROVED'
		WHEN wc."state" = 'REVISION_REQUIRED' THEN 'REVISION_REQUIRED'
		WHEN wc."state" IN ('WORK_SUBMITTED', 'VALIDATION_RECORDED') THEN 'SUBMITTED'
		WHEN wc."state" IN ('ESCROW_FUNDED', 'IN_PROGRESS', 'ESCROW_RELEASED') THEN 'FUNDED'
		ELSE 'PENDING'
	END,
	wc."created_at", wc."updated_at"
FROM "work_contracts" wc JOIN "jobs" j ON j."id" = wc."job_id";
--> statement-breakpoint
ALTER TABLE "payment_instructions" ADD COLUMN "milestone_id" varchar(128);
--> statement-breakpoint
UPDATE "payment_instructions" p SET "milestone_id" = wc."milestone_id" FROM "work_contracts" wc WHERE wc."id" = p."contract_id";
--> statement-breakpoint
ALTER TABLE "payment_instructions" ALTER COLUMN "milestone_id" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_instructions_milestone_idx" ON "payment_instructions" USING btree ("contract_id","milestone_id");
--> statement-breakpoint
ALTER TABLE "work_submissions" ADD COLUMN "milestone_id" varchar(128);
--> statement-breakpoint
UPDATE "work_submissions" s SET "milestone_id" = wc."milestone_id" FROM "work_contracts" wc WHERE wc."id" = s."contract_id";
--> statement-breakpoint
ALTER TABLE "work_submissions" ALTER COLUMN "milestone_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "work_submissions_version_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "work_submissions_version_idx" ON "work_submissions" USING btree ("contract_id","milestone_id","version");
