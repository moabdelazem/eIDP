-- 0005 — pipeline requests (create_pipeline): an application written into
-- the inventories repo for a repository that exists. What it is built and
-- deployed with is one document, `pipeline`, set for that kind and no other.

ALTER TABLE "requests" DROP CONSTRAINT "requests_kind_check";
ALTER TABLE "requests" ADD COLUMN "pipeline" jsonb;
ALTER TABLE "requests" ADD CONSTRAINT "requests_pipeline_check" CHECK ((kind = 'create_pipeline'::text) = (pipeline IS NOT NULL) AND ((kind <> 'create_pipeline'::text) OR (repository IS NOT NULL)));
ALTER TABLE "requests" ADD CONSTRAINT "requests_kind_check" CHECK (kind = ANY (ARRAY['create_repository'::text, 'create_project'::text, 'grant_access'::text, 'create_jira_project'::text, 'create_pipeline'::text]));
