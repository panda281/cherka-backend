import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

export const eventStatusEnum = pgEnum("event_status", ["draft", "published", "closed"]);
export const orderStatusEnum = pgEnum("order_status", [
  "pending_receipt",
  "verifying",
  "approved",
  "rejected",
  "ticket_issued"
]);
export const verificationStatusEnum = pgEnum("verification_status", [
  "verifying",
  "approved",
  "rejected"
]);
export const ticketStatusEnum = pgEnum("ticket_status", ["unused", "used", "void"]);
export const checkinResultEnum = pgEnum("checkin_result", ["valid", "already_used", "invalid"]);
export const auditActionEnum = pgEnum("audit_action", [
  "receipt_approved",
  "receipt_rejected",
  "ticket_claimed",
  "ticket_scanned"
]);

const now = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

export const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  location: varchar("location", { length: 200 }),
  eventImageUrl: text("event_image_url"),
  ticketTemplateImageUrl: text("ticket_template_image_url"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  status: eventStatusEnum("status").default("draft").notNull(),
  createdAt: now,
  updatedAt
});

export const eventTiers = pgTable(
  "event_tiers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    tierCode: varchar("tier_code", { length: 50 }).notNull(),
    tierName: varchar("tier_name", { length: 100 }).notNull(),
    price: numeric("price", { precision: 12, scale: 2 }).notNull(),
    capacity: integer("capacity"),
    active: boolean("active").default(true).notNull(),
    createdAt: now,
    updatedAt
  },
  (table) => ({
    eventTierCodeUnique: uniqueIndex("event_tier_code_unique").on(table.eventId, table.tierCode)
  })
);

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "restrict" }),
  tierId: uuid("tier_id")
    .notNull()
    .references(() => eventTiers.id, { onDelete: "restrict" }),
  orderRef: varchar("order_ref", { length: 32 }).notNull().unique(),
  expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull(),
  payerPhone: varchar("payer_phone", { length: 20 }),
  status: orderStatusEnum("status").default("pending_receipt").notNull(),
  createdAt: now,
  updatedAt
});

export const receiptSubmissions = pgTable("receipt_submissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  receiptNo: varchar("receipt_no", { length: 120 }).notNull().unique(),
  receiptUrl: text("receipt_url"),
  screenshotPath: text("screenshot_path"),
  screenshotHash: varchar("screenshot_hash", { length: 128 }),
  verificationStatus: verificationStatusEnum("verification_status").default("verifying").notNull(),
  verificationNotes: text("verification_notes"),
  verifiedBy: varchar("verified_by", { length: 100 }),
  transactionAt: timestamp("transaction_at", { withTimezone: true }),
  createdAt: now,
  updatedAt
});

export const tickets = pgTable("tickets", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" })
    .unique(),
  telegramUserId: varchar("telegram_user_id", { length: 50 }).notNull(),
  tokenJti: varchar("token_jti", { length: 100 }).notNull().unique(),
  qrPayload: text("qr_payload").notNull(),
  qrImageDataUrl: text("qr_image_data_url").notNull(),
  status: ticketStatusEnum("status").default("unused").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByGate: varchar("used_by_gate", { length: 100 }),
  createdAt: now,
  updatedAt
});

export const checkins = pgTable("checkins", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
  scannerDeviceId: varchar("scanner_device_id", { length: 100 }).notNull(),
  result: checkinResultEnum("result").notNull(),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
  details: text("details")
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  action: auditActionEnum("action").notNull(),
  actor: varchar("actor", { length: 120 }).notNull(),
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: varchar("entity_id", { length: 120 }).notNull(),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});
