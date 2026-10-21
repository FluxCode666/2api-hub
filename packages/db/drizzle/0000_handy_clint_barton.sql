CREATE TYPE "public"."billing_type" AS ENUM('per_token', 'per_request', 'subscription');--> statement-breakpoint
CREATE TYPE "public"."channel_protocol" AS ENUM('openai_chat', 'openai_responses', 'anthropic', 'gemini');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('active', 'paused', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('new', 'read', 'handled');--> statement-breakpoint
CREATE TYPE "public"."feedback_type" AS ENUM('recommend_site', 'suggestion', 'complaint', 'bug');--> statement-breakpoint
CREATE TYPE "public"."model_modality" AS ENUM('text', 'image', 'video', 'audio', 'embedding');--> statement-breakpoint
CREATE TYPE "public"."model_tier" AS ENUM('flagship', 'standard', 'lite');--> statement-breakpoint
CREATE TYPE "public"."probe_kind" AS ENUM('availability', 'authenticity', 'discovery');--> statement-breakpoint
CREATE TYPE "public"."probe_trigger" AS ENUM('schedule', 'merchant', 'admin', 'onboarding', 'public');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('visible', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."site_status" AS ENUM('draft', 'pending', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."site_type" AS ENUM('new_api', 'sub2api', 'one_api', 'custom');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'done', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."test_status" AS ENUM('pass', 'fail', 'untested');--> statement-breakpoint
CREATE TYPE "public"."trust_verdict" AS ENUM('genuine', 'suspect', 'fake', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'merchant', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'banned');--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content_md" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authenticity_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"channel_model_id" integer,
	"task_id" integer,
	"model" text NOT NULL,
	"protocol" "channel_protocol" NOT NULL,
	"score" integer,
	"verdict" "trust_verdict" NOT NULL,
	"checks" jsonb NOT NULL,
	"duration_ms" integer,
	"trigger" "probe_trigger" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"upstream_name" text NOT NULL,
	"model_id" integer,
	"price_override_input" double precision,
	"price_override_output" double precision,
	"last_status" "test_status" DEFAULT 'untested' NOT NULL,
	"last_latency_ms" integer,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"trust_score" integer,
	"trust_verdict" "trust_verdict" DEFAULT 'unknown' NOT NULL,
	"trust_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_stats" (
	"channel_id" integer PRIMARY KEY NOT NULL,
	"uptime_1h" double precision,
	"uptime_24h" double precision,
	"uptime_7d" double precision,
	"samples_24h" integer DEFAULT 0 NOT NULL,
	"latency_p50_24h" integer,
	"latency_p95_24h" integer,
	"ttft_avg_24h" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_probe_at" timestamp with time zone,
	"trust_score" integer,
	"trust_verdict" "trust_verdict" DEFAULT 'unknown' NOT NULL,
	"recommend_score" double precision,
	"sparkline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"vendor_id" integer,
	"protocol" "channel_protocol" DEFAULT 'openai_chat' NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"api_key_mask" text NOT NULL,
	"group_ratio" double precision DEFAULT 1 NOT NULL,
	"billing_type" "billing_type" DEFAULT 'per_token' NOT NULL,
	"primary_model" text NOT NULL,
	"backup_model" text,
	"rpm_limit" integer,
	"status" "channel_status" DEFAULT 'active' NOT NULL,
	"probe_enabled" boolean DEFAULT true NOT NULL,
	"probe_interval_sec" integer DEFAULT 600 NOT NULL,
	"next_probe_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_probe_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" uuid NOT NULL,
	"channel_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"type" "feedback_type" NOT NULL,
	"site_name" text,
	"site_url" text,
	"contact" text,
	"content" text NOT NULL,
	"ip_hash" text,
	"status" "feedback_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"vendor_id" integer NOT NULL,
	"family" text,
	"modality" "model_modality" DEFAULT 'text' NOT NULL,
	"tier" "model_tier" DEFAULT 'standard' NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"default_protocol" "channel_protocol" DEFAULT 'openai_chat' NOT NULL,
	"official_input_price" double precision,
	"official_output_price" double precision,
	"context_window" integer,
	"knowledge_cutoff" text,
	"expected_tps" integer,
	"released_at" text,
	"description" text,
	"is_featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probe_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"channel_model_id" integer,
	"model" text NOT NULL,
	"protocol" "channel_protocol" NOT NULL,
	"kind" "probe_kind" NOT NULL,
	"trigger" "probe_trigger" NOT NULL,
	"success" boolean NOT NULL,
	"http_status" integer,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer,
	"ttft_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"tokens_per_sec" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probe_tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"kind" "probe_kind" NOT NULL,
	"trigger" "probe_trigger" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"content" text NOT NULL,
	"status" "review_status" DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_stats" (
	"site_id" integer PRIMARY KEY NOT NULL,
	"channel_count" integer DEFAULT 0 NOT NULL,
	"model_count" integer DEFAULT 0 NOT NULL,
	"avg_uptime_24h" double precision,
	"best_recommend_score" double precision,
	"min_actual_ratio" double precision,
	"vendor_slugs" text[] DEFAULT '{}' NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"avg_rating" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"homepage_url" text NOT NULL,
	"invite_url" text,
	"logo_url" text,
	"description" text,
	"type" "site_type" DEFAULT 'new_api' NOT NULL,
	"recharge_ratio" double precision DEFAULT 1 NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"payment_methods" text[] DEFAULT '{}' NOT NULL,
	"status" "site_status" DEFAULT 'draft' NOT NULL,
	"review_note" text,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"reviewed_by" uuid,
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"sort_weight" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"nickname" text NOT NULL,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"name_zh" text,
	"color" text DEFAULT '#888888' NOT NULL,
	"icon_url" text,
	"website" text,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ip_hash" text NOT NULL,
	"host" text NOT NULL,
	"model" text NOT NULL,
	"protocol" "channel_protocol" NOT NULL,
	"score" integer,
	"verdict" "trust_verdict" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_reports" ADD CONSTRAINT "authenticity_reports_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticity_reports" ADD CONSTRAINT "authenticity_reports_channel_model_id_channel_models_id_fk" FOREIGN KEY ("channel_model_id") REFERENCES "public"."channel_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_stats" ADD CONSTRAINT "channel_stats_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_runs" ADD CONSTRAINT "probe_runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_runs" ADD CONSTRAINT "probe_runs_channel_model_id_channel_models_id_fk" FOREIGN KEY ("channel_model_id") REFERENCES "public"."channel_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_tasks" ADD CONSTRAINT "probe_tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_tasks" ADD CONSTRAINT "probe_tasks_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_stats" ADD CONSTRAINT "site_stats_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_time_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_reports_channel_idx" ON "authenticity_reports" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_models_uq" ON "channel_models" USING btree ("channel_id","upstream_name");--> statement-breakpoint
CREATE INDEX "channel_models_model_idx" ON "channel_models" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "channels_site_idx" ON "channels" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "channels_due_idx" ON "channels" USING btree ("next_probe_at");--> statement-breakpoint
CREATE INDEX "channels_vendor_idx" ON "channels" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "models_slug_uq" ON "models" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "models_vendor_idx" ON "models" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "probe_runs_channel_time_idx" ON "probe_runs" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "probe_runs_time_idx" ON "probe_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "probe_tasks_status_idx" ON "probe_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "probe_tasks_channel_idx" ON "probe_tasks" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_site_user_uq" ON "reviews" USING btree ("site_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_slug_uq" ON "sites" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "sites_owner_idx" ON "sites" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sites_status_idx" ON "sites" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_slug_uq" ON "vendors" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "verify_requests_ip_idx" ON "verify_requests" USING btree ("ip_hash","created_at");