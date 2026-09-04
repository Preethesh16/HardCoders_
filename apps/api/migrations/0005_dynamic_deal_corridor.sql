ALTER TABLE "jobs" ADD COLUMN "payer_country" varchar(2);
ALTER TABLE "jobs" ADD COLUMN "funding_currency" varchar(3);

UPDATE "jobs"
SET
  "payer_country" = "organizations"."country",
  "funding_currency" = "jobs"."budget_currency"
FROM "organizations"
WHERE "jobs"."organization_id" = "organizations"."id";

ALTER TABLE "jobs" ALTER COLUMN "payer_country" SET NOT NULL;
ALTER TABLE "jobs" ALTER COLUMN "funding_currency" SET NOT NULL;

ALTER TABLE "applications" ADD COLUMN "residence_country" varchar(2);
ALTER TABLE "applications" ADD COLUMN "payout_country" varchar(2);
ALTER TABLE "applications" ADD COLUMN "payout_currency" varchar(3);

UPDATE "applications"
SET
  "residence_country" = "organizations"."country",
  "payout_country" = "organizations"."country",
  "payout_currency" = CASE "organizations"."country"
    WHEN 'IN' THEN 'INR'
    WHEN 'GB' THEN 'GBP'
    WHEN 'PL' THEN 'PLN'
    WHEN 'DE' THEN 'EUR'
    ELSE "applications"."proposed_currency"
  END
FROM "organizations"
WHERE "applications"."applicant_organization_id" = "organizations"."id";

ALTER TABLE "applications" ALTER COLUMN "residence_country" SET NOT NULL;
ALTER TABLE "applications" ALTER COLUMN "payout_country" SET NOT NULL;
ALTER TABLE "applications" ALTER COLUMN "payout_currency" SET NOT NULL;

ALTER TABLE "work_contracts" ADD COLUMN "payer_country" varchar(2);
ALTER TABLE "work_contracts" ADD COLUMN "funding_currency" varchar(3);
ALTER TABLE "work_contracts" ADD COLUMN "provider_residence_country" varchar(2);
ALTER TABLE "work_contracts" ADD COLUMN "payout_country" varchar(2);
ALTER TABLE "work_contracts" ADD COLUMN "payout_currency" varchar(3);
ALTER TABLE "work_contracts" ADD COLUMN "corridor_id" varchar(128);
ALTER TABLE "work_contracts" ADD COLUMN "corridor_direction" varchar(8);
ALTER TABLE "work_contracts" ADD COLUMN "corridor_book_id" varchar(64);

UPDATE "work_contracts"
SET
  "payer_country" = "jobs"."payer_country",
  "funding_currency" = "jobs"."funding_currency",
  "provider_residence_country" = "applications"."residence_country",
  "payout_country" = "applications"."payout_country",
  "payout_currency" = "applications"."payout_currency",
  "corridor_id" = CASE
    WHEN "jobs"."payer_country" = 'PL' AND "applications"."payout_country" = 'IN' THEN 'PL-IN-INWARD-v1'
    WHEN "jobs"."payer_country" = 'IN' AND "applications"."payout_country" = 'GB' THEN 'IN-GB-OUTWARD-v1'
    ELSE 'UNRESOLVED-LEGACY'
  END,
  "corridor_direction" = CASE
    WHEN "jobs"."payer_country" = 'PL' AND "applications"."payout_country" = 'IN' THEN 'INWARD'
    WHEN "jobs"."payer_country" = 'IN' AND "applications"."payout_country" = 'GB' THEN 'OUTWARD'
    ELSE 'REVIEW'
  END,
  "corridor_book_id" = CASE
    WHEN "jobs"."payer_country" = 'PL' AND "applications"."payout_country" = 'IN' THEN 'PL-IN-INWARD'
    WHEN "jobs"."payer_country" = 'IN' AND "applications"."payout_country" = 'GB' THEN 'IN-GB-OUTWARD'
    ELSE 'UNRESOLVED-LEGACY'
  END
FROM "jobs", "applications"
WHERE "work_contracts"."job_id" = "jobs"."id"
  AND "work_contracts"."application_id" = "applications"."id";

ALTER TABLE "work_contracts" ALTER COLUMN "payer_country" SET NOT NULL;
ALTER TABLE "work_contracts" ALTER COLUMN "funding_currency" SET NOT NULL;
ALTER TABLE "work_contracts" ALTER COLUMN "provider_residence_country" SET NOT NULL;
ALTER TABLE "work_contracts" ALTER COLUMN "payout_country" SET NOT NULL;
ALTER TABLE "work_contracts" ALTER COLUMN "payout_currency" SET NOT NULL;
ALTER TABLE "work_contracts" ALTER COLUMN "corridor_id" SET NOT NULL;
ALTER TABLE "work_contracts" ALTER COLUMN "corridor_direction" SET NOT NULL;
ALTER TABLE "work_contracts" ALTER COLUMN "corridor_book_id" SET NOT NULL;

