ALTER TABLE "job" ADD COLUMN "cron" text;
--> statement-breakpoint
CREATE TABLE "cron_run" (
  "id" uuid PRIMARY KEY NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "app"("id") ON DELETE CASCADE,
  "deployment_id" uuid NOT NULL,
  "cron" text NOT NULL,
  "trigger" text NOT NULL,
  "scheduled_at" timestamp with time zone NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "error" text
);
--> statement-breakpoint
CREATE INDEX "cron_run_app_started_idx" ON "cron_run" ("app_id", "started_at" DESC);
