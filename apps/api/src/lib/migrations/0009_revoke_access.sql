-- 0009 — Removing access is a request too (revoke_access): several people may ask to remove someone from the same project, so it stays out of the one-open-creation index, as access requests do.

ALTER TABLE "requests" DROP CONSTRAINT "requests_kind_check";

DROP INDEX "requests_one_open_create_idx";

CREATE UNIQUE INDEX "requests_one_open_create_idx" ON "requests" USING btree (kind,lower(collection),lower(project),lower(COALESCE(repository, ''::text))) WHERE ((status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (kind <> ALL (ARRAY['grant_access'::text, 'revoke_access'::text])));

ALTER TABLE "requests" ADD CONSTRAINT "requests_revoke_check" CHECK ((kind <> 'revoke_access'::text) OR ((cardinality(grantees) > 0) AND (repository IS NULL)));

ALTER TABLE "requests" ADD CONSTRAINT "requests_kind_check" CHECK (kind = ANY (ARRAY['create_repository'::text, 'create_project'::text, 'grant_access'::text, 'revoke_access'::text, 'create_jira_project'::text, 'create_pipeline'::text]));
