ALTER TYPE "public"."audit_action" ADD VALUE 'scanner_user_created';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'scanner_user_disabled';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'scanner_user_enabled';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'scanner_user_role_changed';--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "scanner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "scanner_users" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_scanner_user_id_scanner_users_id_fk" FOREIGN KEY ("scanner_user_id") REFERENCES "public"."scanner_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkins_scanner_user_id_idx" ON "checkins" USING btree ("scanner_user_id");