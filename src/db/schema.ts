import {
  boolean,
  index,
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
  "receipt_released",
  "ticket_claimed",
  "ticket_scanned",
  "scanner_user_created",
  "scanner_user_disabled",
  "scanner_user_enabled",
  "scanner_user_role_changed"
]);

/** Staff login for scanner web: gate = scan only; finance = sales/ledger read; organizer_admin = scan + finance + receipt moderation HTTP */
export const scannerRoleEnum = pgEnum("scanner_role", ["gate", "finance", "organizer_admin"]);

export const promoDiscountTypeEnum = pgEnum("promo_discount_type", ["percent", "fixed_total"]);

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
  category: varchar("category", { length: 40 }).default("Music").notNull(),
  featured: boolean("featured").default(false).notNull(),
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
    /** Regular / door price (after early bird window). */
    price: numeric("price", { precision: 12, scale: 2 }).notNull(),
    /** Optional early-bird unit price; active while `earlyBirdEndsAt` is in the future. */
    earlyBirdPrice: numeric("early_bird_price", { precision: 12, scale: 2 }),
    earlyBirdEndsAt: timestamp("early_bird_ends_at", { withTimezone: true }),
    capacity: integer("capacity"),
    active: boolean("active").default(true).notNull(),
    createdAt: now,
    updatedAt
  },
  (table) => ({
    eventTierCodeUnique: uniqueIndex("event_tier_code_unique").on(table.eventId, table.tierCode)
  })
);

export const promoCodes = pgTable("promo_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Normalized lowercase in app; globally unique. */
  code: varchar("code", { length: 40 }).notNull().unique(),
  /** When set, code applies only to orders for this event. */
  eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
  discountType: promoDiscountTypeEnum("discount_type").notNull(),
  /** percent: 0–100; fixed_total: ETB subtracted from order subtotal (capped at subtotal). */
  discountValue: numeric("discount_value", { precision: 12, scale: 2 }).notNull(),
  maxUses: integer("max_uses"),
  usesCount: integer("uses_count").default(0).notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  active: boolean("active").default(true).notNull(),
  createdAt: now,
  updatedAt
});

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "restrict" }),
  tierId: uuid("tier_id")
    .notNull()
    .references(() => eventTiers.id, { onDelete: "restrict" }),
  orderRef: varchar("order_ref", { length: 32 }).notNull().unique(),
  /** Effective unit price at checkout (early bird or regular, before promo). */
  unitPriceEtb: numeric("unit_price_etb", { precision: 12, scale: 2 }).notNull(),
  expectedAmount: numeric("expected_amount", { precision: 12, scale: 2 }).notNull(),
  promoCodeId: uuid("promo_code_id").references(() => promoCodes.id, { onDelete: "set null" }),
  promoDiscountEtb: numeric("promo_discount_etb", { precision: 12, scale: 2 }).default("0").notNull(),
  payerPhone: varchar("payer_phone", { length: 20 }),
  /** Set when user interacts via Telegram user bot — used for /start auto-claim */
  telegramUserId: varchar("telegram_user_id", { length: 50 }),
  /** Number of QR tickets for this order (same tier); expectedAmount is unit price × quantity */
  quantity: integer("quantity").default(1).notNull(),
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
    .references(() => orders.id, { onDelete: "cascade" }),
  telegramUserId: varchar("telegram_user_id", { length: 50 }).notNull(),
  /** From Telegram at claim time; null if hidden or HTTP claim without username */
  telegramUsername: varchar("telegram_username", { length: 64 }),
  tokenJti: varchar("token_jti", { length: 100 }).notNull().unique(),
  qrPayload: text("qr_payload").notNull(),
  qrImageDataUrl: text("qr_image_data_url").notNull(),
  status: ticketStatusEnum("status").default("unused").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByGate: varchar("used_by_gate", { length: 100 }),
  createdAt: now,
  updatedAt
});

/**
 * Append-only sale lines (one row per issued ticket) for tax and organizer exports.
 * Do not update or delete from application code after insert.
 */
export const ticketSaleLedger = pgTable(
  "ticket_sale_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Same instant as the ticket row (issue time). */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
    ticketId: uuid("ticket_id")
      .notNull()
      .unique()
      .references(() => tickets.id, { onDelete: "restrict" }),
    eventId: uuid("event_id").notNull(),
    eventNameSnapshot: varchar("event_name_snapshot", { length: 200 }).notNull(),
    tierId: uuid("tier_id").notNull(),
    tierCodeSnapshot: varchar("tier_code_snapshot", { length: 50 }).notNull(),
    tierNameSnapshot: varchar("tier_name_snapshot", { length: 100 }).notNull(),
    listUnitPriceEtb: numeric("list_unit_price_etb", { precision: 12, scale: 2 }).notNull(),
    orderId: uuid("order_id").notNull(),
    orderRef: varchar("order_ref", { length: 32 }).notNull(),
    orderQuantity: integer("order_quantity").notNull(),
    orderTotalEtb: numeric("order_total_etb", { precision: 12, scale: 2 }).notNull(),
    lineAllocatedEtb: numeric("line_allocated_etb", { precision: 12, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).default("ETB").notNull(),
    buyerTelegramUserId: varchar("buyer_telegram_user_id", { length: 50 }).notNull(),
    buyerTelegramUsername: varchar("buyer_telegram_username", { length: 64 }),
    /** issue = live issuance; backfill = migrated historical row */
    source: varchar("source", { length: 20 }).default("issue").notNull()
  },
  (table) => ({
    eventIdIdx: index("ticket_sale_ledger_event_id_idx").on(table.eventId)
  })
);

/** Gate / scanner web app users; passwords are bcrypt hashes. */
export const scannerUsers = pgTable("scanner_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 128 }).notNull(),
  role: scannerRoleEnum("role").default("organizer_admin").notNull(),
  /** When false, login and JWT scan are rejected until re-enabled. */
  active: boolean("active").default(true).notNull(),
  createdAt: now,
  updatedAt
});

export const checkins = pgTable(
  "checkins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    /** Set when the scan used a scanner JWT (not API key); used for per-staff stats. */
    scannerUserId: uuid("scanner_user_id").references(() => scannerUsers.id, { onDelete: "set null" }),
    scannerDeviceId: varchar("scanner_device_id", { length: 100 }).notNull(),
    result: checkinResultEnum("result").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
    details: text("details")
  },
  (table) => ({
    scannerUserIdIdx: index("checkins_scanner_user_id_idx").on(table.scannerUserId)
  })
);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  action: auditActionEnum("action").notNull(),
  actor: varchar("actor", { length: 120 }).notNull(),
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: varchar("entity_id", { length: 120 }).notNull(),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

/** Telegram user bot: one row per user who accepted the current policy. */
export const privacyAcceptances = pgTable("privacy_acceptances", {
  telegramUserId: varchar("telegram_user_id", { length: 50 }).primaryKey(),
  policyVersion: varchar("policy_version", { length: 64 }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull()
});
