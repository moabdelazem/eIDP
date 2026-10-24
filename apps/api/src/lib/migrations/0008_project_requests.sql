-- 0008 — One New project form files its Azure DevOps and Jira projects together (bundle_id), and a Jira project may be led by someone other than the requester (project_lead).

ALTER TABLE "requests" ADD COLUMN "project_lead" text;

ALTER TABLE "requests" ADD COLUMN "bundle_id" uuid;

CREATE INDEX "requests_bundle_idx" ON "requests" USING btree ("bundle_id") WHERE bundle_id IS NOT NULL;
