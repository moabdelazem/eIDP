-- 0008 — an approved pipeline's branches and service hooks are steps the
-- portal runs itself (createBranchs_hooks_initApp.sh, without the script),
-- rather than one Jenkins provisioning job. `provision` stays allowed for
-- the requests that had it.

ALTER TABLE "request_steps" DROP CONSTRAINT "request_steps_step_check";

ALTER TABLE "request_steps" ADD CONSTRAINT "request_steps_step_check" CHECK (step = ANY (ARRAY['provision'::text, 'branches'::text, 'hooks'::text, 'test'::text]));
