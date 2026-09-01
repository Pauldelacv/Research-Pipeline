CREATE TABLE "provider_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"provider" text NOT NULL,
	"provider_kind" text NOT NULL,
	"operation" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"requests" integer DEFAULT 1 NOT NULL,
	"cost_usd" real,
	"cost_source" text DEFAULT 'unknown' NOT NULL,
	"latency_ms" integer,
	"outcome" text DEFAULT 'success' NOT NULL,
	"error_code" text,
	"target" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"scope" text DEFAULT 'step' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"will_retry" boolean DEFAULT false NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"provider" text,
	"operation" text,
	"target_id" text,
	"target_label" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "trust_score" real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "trust_category" text;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_failures" ADD CONSTRAINT "run_failures_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_usage_run_idx" ON "provider_usage" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_usage_run_provider_idx" ON "provider_usage" USING btree ("run_id","provider","operation");--> statement-breakpoint
CREATE INDEX "run_failures_run_idx" ON "run_failures" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "run_failures_run_step_idx" ON "run_failures" USING btree ("run_id","step_id");