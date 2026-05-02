CREATE TABLE "ticket_sale_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_name_snapshot" varchar(200) NOT NULL,
	"tier_id" uuid NOT NULL,
	"tier_code_snapshot" varchar(50) NOT NULL,
	"tier_name_snapshot" varchar(100) NOT NULL,
	"list_unit_price_etb" numeric(12, 2) NOT NULL,
	"order_id" uuid NOT NULL,
	"order_ref" varchar(32) NOT NULL,
	"order_quantity" integer NOT NULL,
	"order_total_etb" numeric(12, 2) NOT NULL,
	"line_allocated_etb" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'ETB' NOT NULL,
	"buyer_telegram_user_id" varchar(50) NOT NULL,
	"buyer_telegram_username" varchar(64),
	"source" varchar(20) DEFAULT 'issue' NOT NULL,
	CONSTRAINT "ticket_sale_ledger_ticket_id_unique" UNIQUE("ticket_id")
);
--> statement-breakpoint
ALTER TABLE "ticket_sale_ledger" ADD CONSTRAINT "ticket_sale_ledger_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_sale_ledger_event_id_idx" ON "ticket_sale_ledger" USING btree ("event_id");--> statement-breakpoint
INSERT INTO "ticket_sale_ledger" (
	"id",
	"recorded_at",
	"ticket_id",
	"event_id",
	"event_name_snapshot",
	"tier_id",
	"tier_code_snapshot",
	"tier_name_snapshot",
	"list_unit_price_etb",
	"order_id",
	"order_ref",
	"order_quantity",
	"order_total_etb",
	"line_allocated_etb",
	"currency",
	"buyer_telegram_user_id",
	"buyer_telegram_username",
	"source"
)
SELECT
	gen_random_uuid(),
	t."created_at",
	t."id",
	o."event_id",
	e."name",
	o."tier_id",
	et."tier_code",
	et."tier_name",
	et."price",
	o."id",
	o."order_ref",
	o."quantity",
	o."expected_amount",
	(o."expected_amount"::numeric / greatest(o."quantity", 1))::numeric(12, 2),
	'ETB',
	t."telegram_user_id",
	t."telegram_username",
	'backfill'
FROM "tickets" t
INNER JOIN "orders" o ON o."id" = t."order_id"
INNER JOIN "events" e ON e."id" = o."event_id"
INNER JOIN "event_tiers" et ON et."id" = o."tier_id"
WHERE NOT EXISTS (
	SELECT 1 FROM "ticket_sale_ledger" l WHERE l."ticket_id" = t."id"
);