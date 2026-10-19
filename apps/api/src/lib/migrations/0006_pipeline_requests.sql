-- 0006 — pipeline requests (create_pipeline): an application written into
-- the inventories repo for a repository that exists, from templates DevOps
-- edit in the portal. What a pipeline is built and deployed with is one
-- document, `pipeline`, set for that kind and no other; the templates are one
-- row per slot, and every save is kept.
--
-- Written to run over a database that applied the same change from the
-- unmerged branch that first had it (as 0005_pipeline_requests and
-- 0006_pipeline_templates): every statement tolerates finding it done.

CREATE TABLE IF NOT EXISTS "pipeline_template_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dir" text NOT NULL,
	"files" jsonb,
	"changed_by" text NOT NULL,
	"changed_by_name" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "pipeline_templates" (
	"dir" text PRIMARY KEY NOT NULL,
	"files" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_by_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "pipeline_template_history_dir_idx" ON "pipeline_template_history" USING btree ("dir","changed_at" DESC NULLS LAST);

ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "pipeline" jsonb;

ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_kind_check";
ALTER TABLE "requests" ADD CONSTRAINT "requests_kind_check" CHECK (kind = ANY (ARRAY['create_repository'::text, 'create_project'::text, 'grant_access'::text, 'create_jira_project'::text, 'create_pipeline'::text]));

ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_pipeline_check";
ALTER TABLE "requests" ADD CONSTRAINT "requests_pipeline_check" CHECK ((kind = 'create_pipeline'::text) = (pipeline IS NOT NULL) AND ((kind <> 'create_pipeline'::text) OR (repository IS NOT NULL)));
