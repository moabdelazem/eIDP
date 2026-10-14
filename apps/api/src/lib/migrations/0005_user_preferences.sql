-- 0005 — each person's own preferences, kept with them rather than in one
-- browser: first, how they arranged their Overview.

CREATE TABLE "user_preferences" (
	"uid" text NOT NULL,
	"name" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_uid_name_pk" PRIMARY KEY("uid","name")
);
