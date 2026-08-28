CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"validation_status" text DEFAULT 'pending' NOT NULL,
	"validation_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" integer,
	"score_breakdown" jsonb,
	"flagged_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"extracted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"confidence" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'auto' NOT NULL,
	"extracted_by" text,
	"previous_value" jsonb,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"agreement_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_scores" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"run_id" text NOT NULL,
	"score" integer NOT NULL,
	"breakdown" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"run_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"tone" text DEFAULT 'neutral' NOT NULL,
	"detected" boolean DEFAULT false NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"rationale" text,
	"source" text DEFAULT 'derived' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"entity_field_id" text,
	"source_id" text NOT NULL,
	"snippet" text NOT NULL,
	"locator" text,
	"confidence" real DEFAULT 0 NOT NULL,
	"method" text DEFAULT 'rule' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"destination_id" text NOT NULL,
	"connector" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"entity_count" integer DEFAULT 0 NOT NULL,
	"location" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pipeline_step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"metrics" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"objective" text NOT NULL,
	"config_key" text NOT NULL,
	"config" jsonb NOT NULL,
	"targeting" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"last_run_id" text,
	"last_run_at" timestamp with time zone,
	"entity_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"run_id" text NOT NULL,
	"action" text NOT NULL,
	"field_key" text,
	"previous_value" jsonb,
	"new_value" jsonb,
	"note" text,
	"reviewer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"level" text DEFAULT 'info' NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"current_step" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"targeting" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text,
	"snippet" text,
	"kind" text DEFAULT 'search_result' NOT NULL,
	"provider" text NOT NULL,
	"query" text,
	"rank" integer,
	"http_status" integer,
	"content_hash" text,
	"fetched_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_candidates" ADD CONSTRAINT "entity_candidates_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_candidates" ADD CONSTRAINT "entity_candidates_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_fields" ADD CONSTRAINT "entity_fields_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_scores" ADD CONSTRAINT "entity_scores_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_signals" ADD CONSTRAINT "entity_signals_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_entity_field_id_entity_fields_id_fk" FOREIGN KEY ("entity_field_id") REFERENCES "public"."entity_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_step_runs" ADD CONSTRAINT "pipeline_step_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_run_dedupe_idx" ON "entities" USING btree ("run_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "entities_run_status_idx" ON "entities" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "entities_run_score_idx" ON "entities" USING btree ("run_id","score");--> statement-breakpoint
CREATE INDEX "entities_tenant_idx" ON "entities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "candidates_run_idx" ON "entity_candidates" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_fields_entity_key_idx" ON "entity_fields" USING btree ("entity_id","key");--> statement-breakpoint
CREATE INDEX "entity_fields_status_idx" ON "entity_fields" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "entity_scores_entity_idx" ON "entity_scores" USING btree ("entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_signals_entity_key_idx" ON "entity_signals" USING btree ("entity_id","key");--> statement-breakpoint
CREATE INDEX "entity_signals_run_key_idx" ON "entity_signals" USING btree ("run_id","key","detected");--> statement-breakpoint
CREATE INDEX "evidence_entity_idx" ON "evidence" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "evidence_field_idx" ON "evidence" USING btree ("entity_field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_dedupe_idx" ON "evidence" USING btree ("entity_field_id","source_id","snippet");--> statement-breakpoint
CREATE INDEX "exports_run_idx" ON "exports" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "step_runs_run_step_idx" ON "pipeline_step_runs" USING btree ("run_id","step_id");--> statement-breakpoint
CREATE INDEX "projects_tenant_idx" ON "projects" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reviews_entity_idx" ON "reviews" USING btree ("entity_id","created_at");--> statement-breakpoint
CREATE INDEX "run_events_run_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "run_events_level_idx" ON "run_events" USING btree ("run_id","level");--> statement-breakpoint
CREATE INDEX "runs_project_idx" ON "runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_tenant_idx" ON "runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_run_url_idx" ON "sources" USING btree ("run_id","canonical_url");--> statement-breakpoint
CREATE INDEX "sources_run_idx" ON "sources" USING btree ("run_id","discovered_at");