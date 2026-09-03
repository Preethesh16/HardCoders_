ALTER TABLE "jobs" ADD COLUMN "acceptance_criteria" jsonb;
ALTER TABLE "jobs" ADD COLUMN "target_delivery_date" varchar(10);

ALTER TABLE "applications" ADD COLUMN "approach" text;
ALTER TABLE "applications" ADD COLUMN "proposed_skills" jsonb;
ALTER TABLE "applications" ADD COLUMN "proposed_amount_minor" numeric(38, 0);
ALTER TABLE "applications" ADD COLUMN "proposed_currency" varchar(3);
ALTER TABLE "applications" ADD COLUMN "proposed_scale" smallint;
ALTER TABLE "applications" ADD COLUMN "delivery_days" integer;
ALTER TABLE "applications" ADD COLUMN "delivery_date" varchar(10);
ALTER TABLE "applications" ADD COLUMN "availability" text;

UPDATE "applications"
SET
  "approach" = 'Legacy proposal; approach was not captured.',
  "proposed_skills" = "jobs"."skills",
  "proposed_amount_minor" = "jobs"."budget_amount_minor",
  "proposed_currency" = "jobs"."budget_currency",
  "proposed_scale" = "jobs"."budget_scale",
  "delivery_days" = 30,
  "availability" = 'Availability was not captured.'
FROM "jobs"
WHERE "applications"."job_id" = "jobs"."id";

ALTER TABLE "applications" ALTER COLUMN "approach" SET NOT NULL;
ALTER TABLE "applications" ALTER COLUMN "proposed_skills" SET NOT NULL;
ALTER TABLE "applications" ALTER COLUMN "proposed_amount_minor" SET NOT NULL;
ALTER TABLE "applications" ALTER COLUMN "proposed_currency" SET NOT NULL;
ALTER TABLE "applications" ALTER COLUMN "proposed_scale" SET NOT NULL;
ALTER TABLE "applications" ALTER COLUMN "delivery_days" SET NOT NULL;
ALTER TABLE "applications" ALTER COLUMN "availability" SET NOT NULL;

ALTER TABLE "work_contracts" ADD COLUMN "agreement_object_id" varchar(128);
ALTER TABLE "work_contracts" ADD COLUMN "agreement_artifact_hash" varchar(71);
ALTER TABLE "work_contracts" ADD COLUMN "agreement_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "work_contracts" ADD COLUMN "agreement_terms" jsonb;

CREATE INDEX "work_contracts_agreement_object_idx"
ON "work_contracts" USING btree ("agreement_object_id");
