ALTER TABLE "uploaded_objects"
  ADD COLUMN IF NOT EXISTS "file_name" text NOT NULL DEFAULT 'artifact.bin';

CREATE TABLE IF NOT EXISTS "freelancer_profiles" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "user_id" varchar(128) NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "headline" text NOT NULL,
  "bio" text NOT NULL,
  "experience" jsonb NOT NULL,
  "github_links" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "freelancer_profiles_user_idx"
  ON "freelancer_profiles" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "freelancer_profiles_org_idx"
  ON "freelancer_profiles" USING btree ("organization_id");

CREATE TABLE IF NOT EXISTS "freelancer_documents" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "freelancer_user_id" varchar(128) NOT NULL,
  "owner_organization_id" varchar(128) NOT NULL,
  "object_id" varchar(128) NOT NULL,
  "category" varchar(24) NOT NULL,
  "uploaded_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "freelancer_documents_object_idx"
  ON "freelancer_documents" USING btree ("object_id");
CREATE INDEX IF NOT EXISTS "freelancer_documents_user_idx"
  ON "freelancer_documents" USING btree ("freelancer_user_id", "uploaded_at");
