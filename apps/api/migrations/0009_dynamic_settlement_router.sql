CREATE TABLE IF NOT EXISTS "settlement_route_decisions" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "payment_id" varchar(128) NOT NULL,
  "generation" integer NOT NULL,
  "status" varchar(32) NOT NULL,
  "selected_provider_id" varchar(64),
  "selected_quote_id" varchar(256),
  "selected_recipient_amount_minor" numeric(38,0),
  "payout_currency" varchar(3) NOT NULL,
  "payout_scale" smallint NOT NULL,
  "fx_oracle_hash" varchar(71) NOT NULL,
  "route_hash" varchar(71) NOT NULL,
  "decision" jsonb NOT NULL,
  "decided_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "settlement_route_decisions_generation_idx" ON "settlement_route_decisions" USING btree ("payment_id","generation");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settlement_route_decisions_payment_idx" ON "settlement_route_decisions" USING btree ("payment_id","decided_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settlement_provider_quotes" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "payment_id" varchar(128) NOT NULL,
  "decision_id" varchar(128) NOT NULL,
  "provider_id" varchar(64) NOT NULL,
  "quote_id" varchar(256) NOT NULL,
  "eligible" boolean NOT NULL,
  "reason_codes" jsonb NOT NULL,
  "recipient_amount_minor" numeric(38,0) NOT NULL,
  "payout_currency" varchar(3) NOT NULL,
  "payout_scale" smallint NOT NULL,
  "quoted_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "authenticity_hash" varchar(71) NOT NULL,
  "quote" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "settlement_provider_quotes_quote_idx" ON "settlement_provider_quotes" USING btree ("quote_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settlement_provider_quotes_payment_idx" ON "settlement_provider_quotes" USING btree ("payment_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settlement_executions" (
  "id" varchar(128) PRIMARY KEY NOT NULL,
  "payment_id" varchar(128) NOT NULL,
  "decision_id" varchar(128) NOT NULL,
  "provider_id" varchar(64) NOT NULL,
  "quote_id" varchar(256) NOT NULL,
  "status" varchar(24) NOT NULL,
  "settlement_reference" varchar(128) NOT NULL,
  "response" jsonb NOT NULL,
  "settled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "settlement_executions_reference_idx" ON "settlement_executions" USING btree ("settlement_reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settlement_executions_payment_idx" ON "settlement_executions" USING btree ("payment_id","settled_at");
