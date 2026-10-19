-- 0007 — what follows an approved pipeline request, and what deciders change
-- before approving any request.
--
-- request_steps: the Jenkins provisioning build and the first test build run
-- after the push, one row per step, advanced by a background job. They are
-- the request's follow-ups, not part of it: the request is complete once its
-- files are in inventories, and a step that fails is retried on its own.
--
-- requests.adjustments: each change a decider made to a waiting request (a
-- name, a version), with who and when, shown to the requester as well.
-- requests.pipeline_edits: the files of what approving writes, as a decider
-- edited them; the push writes these instead of the templates' output.

CREATE TABLE "request_steps" (
	"request_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" text NOT NULL,
	"job" text,
	"parameters" jsonb,
	"queue_id" integer,
	"number" integer,
	"url" text,
	"note" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_steps_request_id_step_pk" PRIMARY KEY("request_id","step"),
	CONSTRAINT "request_steps_step_check" CHECK (step = ANY (ARRAY['provision'::text, 'test'::text])),
	CONSTRAINT "request_steps_status_check" CHECK (status = ANY (ARRAY['waiting'::text, 'pending'::text, 'queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text]))
);


ALTER TABLE "requests" ADD COLUMN "adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE "requests" ADD COLUMN "pipeline_edits" jsonb;

ALTER TABLE "request_steps" ADD CONSTRAINT "request_steps_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "request_steps_open_idx" ON "request_steps" USING btree ("status") WHERE status = ANY (ARRAY['pending'::text, 'queued'::text, 'running'::text]);
