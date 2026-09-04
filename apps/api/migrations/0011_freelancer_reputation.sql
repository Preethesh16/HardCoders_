CREATE TABLE "freelancer_ratings" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "contract_id" varchar(128) NOT NULL,
  "freelancer_user_id" varchar(128) NOT NULL,
  "freelancer_organization_id" varchar(128) NOT NULL,
  "buyer_organization_id" varchar(128) NOT NULL,
  "rated_by_user_id" varchar(128) NOT NULL,
  "stars" smallint NOT NULL,
  "review" text NOT NULL,
  "rated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "freelancer_ratings_stars_check" CHECK ("stars" BETWEEN 1 AND 5)
);--> statement-breakpoint
CREATE UNIQUE INDEX "freelancer_ratings_contract_idx" ON "freelancer_ratings" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "freelancer_ratings_profile_idx" ON "freelancer_ratings" USING btree ("freelancer_user_id", "rated_at");
