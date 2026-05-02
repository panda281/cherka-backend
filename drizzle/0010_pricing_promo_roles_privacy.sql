CREATE TYPE "public"."promo_discount_type" AS ENUM('percent', 'fixed_total');--> statement-breakpoint
CREATE TYPE "public"."scanner_role" AS ENUM('gate', 'finance', 'organizer_admin');--> statement-breakpoint
CREATE TABLE "privacy_acceptances" (
	"telegram_user_id" varchar(50) PRIMARY KEY NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"event_id" uuid,
	"discount_type" "promo_discount_type" NOT NULL,
	"discount_value" numeric(12, 2) NOT NULL,
	"max_uses" integer,
	"uses_count" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "event_tiers" ADD COLUMN "early_bird_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "event_tiers" ADD COLUMN "early_bird_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "unit_price_etb" numeric(12, 2);--> statement-breakpoint
UPDATE "orders" SET "unit_price_etb" = ("expected_amount"::numeric / GREATEST("quantity", 1)) WHERE "unit_price_etb" IS NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "unit_price_etb" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promo_code_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promo_discount_etb" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "scanner_users" ADD COLUMN "role" "scanner_role" DEFAULT 'organizer_admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE set null ON UPDATE no action;