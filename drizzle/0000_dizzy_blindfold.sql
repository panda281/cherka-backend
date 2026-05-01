CREATE TYPE "public"."audit_action" AS ENUM('receipt_approved', 'receipt_rejected', 'ticket_claimed', 'ticket_scanned');--> statement-breakpoint
CREATE TYPE "public"."checkin_result" AS ENUM('valid', 'already_used', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'published', 'closed');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_receipt', 'verifying', 'approved', 'rejected', 'ticket_issued');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('unused', 'used', 'void');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('verifying', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "audit_action" NOT NULL,
	"actor" varchar(120) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(120) NOT NULL,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid,
	"scanner_device_id" varchar(100) NOT NULL,
	"result" "checkin_result" NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" text
);
--> statement-breakpoint
CREATE TABLE "event_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"tier_code" varchar(50) NOT NULL,
	"tier_name" varchar(100) NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"capacity" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"location" varchar(200),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"order_ref" varchar(32) NOT NULL,
	"expected_amount" numeric(12, 2) NOT NULL,
	"payer_phone" varchar(20),
	"status" "order_status" DEFAULT 'pending_receipt' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_ref_unique" UNIQUE("order_ref")
);
--> statement-breakpoint
CREATE TABLE "receipt_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"receipt_no" varchar(120) NOT NULL,
	"receipt_url" text,
	"screenshot_path" text,
	"screenshot_hash" varchar(128),
	"verification_status" "verification_status" DEFAULT 'verifying' NOT NULL,
	"verification_notes" text,
	"verified_by" varchar(100),
	"transaction_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_submissions_receipt_no_unique" UNIQUE("receipt_no")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"telegram_user_id" varchar(50) NOT NULL,
	"token_jti" varchar(100) NOT NULL,
	"qr_payload" text NOT NULL,
	"qr_image_data_url" text NOT NULL,
	"status" "ticket_status" DEFAULT 'unused' NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_gate" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "tickets_token_jti_unique" UNIQUE("token_jti")
);
--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tiers" ADD CONSTRAINT "event_tiers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tier_id_event_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."event_tiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_submissions" ADD CONSTRAINT "receipt_submissions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_tier_code_unique" ON "event_tiers" USING btree ("event_id","tier_code");