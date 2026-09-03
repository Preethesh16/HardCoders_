ALTER TABLE "work_submissions" ADD COLUMN "evidence_id" varchar(128);

UPDATE "work_submissions"
SET "evidence_id" = 'legacy-' || "id"
WHERE "evidence_id" IS NULL;

ALTER TABLE "work_submissions" ALTER COLUMN "evidence_id" SET NOT NULL;
CREATE INDEX "work_submissions_evidence_idx" ON "work_submissions" USING btree ("evidence_id");
