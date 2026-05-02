ALTER TABLE "tickets" DROP CONSTRAINT "tickets_order_id_unique";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;