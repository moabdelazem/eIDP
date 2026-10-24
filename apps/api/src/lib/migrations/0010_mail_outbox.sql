-- 0010 — Mail the portal sends, as an outbox: queued with what it is about, sent and retried by the mail-outbox job, and kept so it can be read back and sent again.

CREATE TABLE "mail_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"ref" text,
	"to_addresses" text[] NOT NULL,
	"cc_addresses" text[] DEFAULT '{}' NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"html_body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "mail_outbox_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text]))
);


CREATE INDEX "mail_outbox_due_idx" ON "mail_outbox" USING btree ("next_attempt_at") WHERE status = 'pending';

CREATE INDEX "mail_outbox_ref_idx" ON "mail_outbox" USING btree ("ref");
