-- 0006 — pipeline templates, edited by DevOps in the portal instead of
-- baked into the image: what approved pipelines are written from, one row
-- per slot, and every save kept so what a pipeline was written from and who
-- changed it can be told afterwards.

CREATE TABLE "pipeline_template_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dir" text NOT NULL,
	"files" jsonb,
	"changed_by" text NOT NULL,
	"changed_by_name" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);


CREATE TABLE "pipeline_templates" (
	"dir" text PRIMARY KEY NOT NULL,
	"files" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_by_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);


CREATE INDEX "pipeline_template_history_dir_idx" ON "pipeline_template_history" USING btree ("dir","changed_at" DESC NULLS LAST);
