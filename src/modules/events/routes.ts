import express from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { EVENT_CATEGORIES, DEFAULT_EVENT_CATEGORY, parseEventCategory } from "../../constants/eventCategories";
import { db } from "../../db/client";
import { eventTiers, events } from "../../db/schema";
import { scheduleChannelAnnounceWhenNewlyPublished } from "../telegram/announceEventChannel";
import { requireScanAuth, requireStaffRole } from "../scanner/scanAuth";
import { setEventSalesActive } from "./activation";
import { setTierEarlyBirdEnabled } from "./earlyBirdActivation";
import { getEventLedgerRows, getEventTicketSalesReport, ledgerRowsToCsv } from "./salesReport";

export const eventsRouter = express.Router();

function routeParamId(value: string | string[] | undefined): string {
  if (value == null) return "";
  return Array.isArray(value) ? String(value[0] ?? "") : String(value);
}

const createEventSchema = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  location: z.string().optional(),
  category: z.enum(EVENT_CATEGORIES).optional(),
  featured: z.boolean().optional(),
  eventImageUrl: z.string().url().optional(),
  ticketTemplateImageUrl: z.string().url().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(["draft", "published", "closed"]).optional()
});

const createTierSchema = z.object({
  tierCode: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  tierName: z.string().min(2).max(100),
  price: z.number().positive(),
  earlyBirdPrice: z.number().positive().optional(),
  earlyBirdEndsAt: z.string().optional(),
  capacity: z.number().int().positive().optional(),
  active: z.boolean().optional()
});

const patchEventSchema = createEventSchema.partial().refine((body) => Object.keys(body).length > 0, {
  message: "At least one field is required"
});

eventsRouter.post("/admin/events", requireScanAuth, requireStaffRole("organizer_admin"), async (req, res) => {
  const data = createEventSchema.parse(req.body);
  const inserted = await db
    .insert(events)
    .values({
      ...data,
      category: data.category ?? DEFAULT_EVENT_CATEGORY,
      featured: data.featured ?? false,
      startsAt: new Date(data.startsAt),
      endsAt: new Date(data.endsAt),
      status: data.status ?? "draft"
    })
    .returning();

  const created = inserted[0];
  if (created.status === "published") {
    scheduleChannelAnnounceWhenNewlyPublished(created.id, undefined);
  }

  res.status(201).json(created);
});

eventsRouter.patch("/admin/events/:eventId", requireScanAuth, requireStaffRole("organizer_admin"), async (req, res) => {
  const data = patchEventSchema.parse(req.body);
  const eventId = routeParamId(req.params.eventId);
  const existing = await db.query.events.findFirst({ where: eq(events.id, eventId) });
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.location !== undefined) patch.location = data.location;
  if (data.category !== undefined) patch.category = data.category;
  if (data.featured !== undefined) patch.featured = data.featured;
  if (data.eventImageUrl !== undefined) patch.eventImageUrl = data.eventImageUrl;
  if (data.ticketTemplateImageUrl !== undefined) patch.ticketTemplateImageUrl = data.ticketTemplateImageUrl;
  if (data.startsAt !== undefined) patch.startsAt = new Date(data.startsAt);
  if (data.endsAt !== undefined) patch.endsAt = new Date(data.endsAt);
  if (data.status !== undefined) patch.status = data.status;

  const updated = await db.update(events).set(patch).where(eq(events.id, eventId)).returning();
  if (!updated.length) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  const row = updated[0];
  if (row.status === "published" && existing?.status !== "published") {
    scheduleChannelAnnounceWhenNewlyPublished(row.id, existing?.status);
  }
  res.json(row);
});

/** Body: `{ "active": true }` → published (on sale); `{ "active": false }` → closed (sales disabled). */
eventsRouter.post("/admin/events/:eventId/activation", requireScanAuth, requireStaffRole("organizer_admin"), async (req, res) => {
  const eventId = routeParamId(req.params.eventId);
  const body = z.object({ active: z.boolean() }).parse(req.body);
  const result = await setEventSalesActive(eventId, body.active);
  if (!result.ok) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json(result.row);
});

/** Body: `{ "enabled": true }` turns on early-bird pricing (requires early price + end date set); `{ "enabled": false }` pauses it without clearing saved values. */
eventsRouter.post(
  "/admin/events/:eventId/tiers/:tierId/early-bird",
  requireScanAuth,
  requireStaffRole("organizer_admin"),
  async (req, res) => {
    const eventId = routeParamId(req.params.eventId);
    const tierId = routeParamId(req.params.tierId);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const result = await setTierEarlyBirdEnabled(eventId, tierId, body.enabled);
    if (!result.ok) {
      if (result.error === "tier_not_found") {
        res.status(404).json({ error: "Tier not found" });
        return;
      }
      res.status(400).json({
        error: "Set earlyBirdPrice and earlyBirdEndsAt on the tier before enabling early bird.",
        code: "early_bird_not_configured"
      });
      return;
    }
    res.json(result.row);
  }
);

eventsRouter.post("/admin/events/:eventId/tiers", requireScanAuth, requireStaffRole("organizer_admin"), async (req, res) => {
  const data = createTierSchema.parse(req.body);
  const eventId = routeParamId(req.params.eventId);
  const hasEb = data.earlyBirdPrice != null;
  const hasEnd = Boolean(data.earlyBirdEndsAt?.trim());
  if (hasEb !== hasEnd) {
    res.status(400).json({ error: "Set both earlyBirdPrice and earlyBirdEndsAt (ISO), or omit both." });
    return;
  }
  const inserted = await db
    .insert(eventTiers)
    .values({
      eventId,
      tierCode: data.tierCode.toLowerCase(),
      tierName: data.tierName,
      price: data.price.toFixed(2),
      earlyBirdPrice:
        data.earlyBirdPrice != null && data.earlyBirdEndsAt
          ? data.earlyBirdPrice.toFixed(2)
          : undefined,
      earlyBirdEndsAt:
        data.earlyBirdPrice != null && data.earlyBirdEndsAt ? new Date(data.earlyBirdEndsAt) : undefined,
      capacity: data.capacity,
      active: data.active ?? true
    })
    .returning();

  res.status(201).json(inserted[0]);
});

eventsRouter.patch("/admin/events/:eventId/tiers/:tierId", requireScanAuth, requireStaffRole("organizer_admin"), async (req, res) => {
  const data = createTierSchema.partial().parse(req.body);
  const eventId = routeParamId(req.params.eventId);
  const tierId = routeParamId(req.params.tierId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (data.tierCode !== undefined) patch.tierCode = data.tierCode.toLowerCase();
  if (data.tierName !== undefined) patch.tierName = data.tierName;
  if (data.price !== undefined) patch.price = data.price.toFixed(2);
  if (data.capacity !== undefined) patch.capacity = data.capacity;
  if (data.active !== undefined) patch.active = data.active;
  if (data.earlyBirdPrice !== undefined) {
    patch.earlyBirdPrice =
      data.earlyBirdPrice != null ? data.earlyBirdPrice.toFixed(2) : null;
  }
  if (data.earlyBirdEndsAt !== undefined) {
    patch.earlyBirdEndsAt = data.earlyBirdEndsAt ? new Date(data.earlyBirdEndsAt) : null;
  }
  const updated = await db
    .update(eventTiers)
    .set(patch)
    .where(and(eq(eventTiers.id, tierId), eq(eventTiers.eventId, eventId)))
    .returning();

  if (!updated.length) {
    res.status(404).json({ error: "Tier not found" });
    return;
  }
  res.json(updated[0]);
});

/** Issued tickets + revenue by tier; optional line-level log (detail=1&limit=). */
eventsRouter.get("/admin/events/:eventId/sales", requireScanAuth, requireStaffRole("finance"), async (req, res) => {
  const eventId = routeParamId(req.params.eventId);
  const detail =
    req.query.detail === "1" || String(req.query.detail ?? "").toLowerCase() === "true";
  const limitRaw = Number(req.query.limit ?? 200);
  const detailLimit = detail ? Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200)) : null;
  const report = await getEventTicketSalesReport(eventId, detailLimit);
  if (!report) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json(report);
});

/** Full immutable ledger rows (JSON) for tax / organizers. */
eventsRouter.get("/admin/events/:eventId/sales-ledger", requireScanAuth, requireStaffRole("finance"), async (req, res) => {
  const eventId = routeParamId(req.params.eventId);
  const eventItem = await db.query.events.findFirst({ where: eq(events.id, eventId) });
  if (!eventItem) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  const rows = await getEventLedgerRows(eventId);
  res.json({
    event: { id: eventItem.id, name: eventItem.name },
    immutable: true,
    note: "Append-only ledger; rows are not updated after insert.",
    rowCount: rows.length,
    rows
  });
});

/** CSV download (UTF-8 BOM) for Excel / accountants. */
eventsRouter.get("/admin/events/:eventId/sales-ledger.csv", requireScanAuth, requireStaffRole("finance"), async (req, res) => {
  const eventId = routeParamId(req.params.eventId);
  const eventItem = await db.query.events.findFirst({ where: eq(events.id, eventId) });
  if (!eventItem) {
    res.status(404).send("Event not found");
    return;
  }
  const rows = await getEventLedgerRows(eventId);
  const csv = ledgerRowsToCsv(rows);
  const safeName = eventItem.name.replace(/[^\w\-]+/g, "_").slice(0, 60);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="sales-ledger_${safeName}_${eventId.slice(0, 8)}.csv"`
  );
  res.send("\uFEFF" + csv);
});

eventsRouter.get("/events", async (req, res) => {
  const rawCat = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const categoryFilter = rawCat && rawCat.toLowerCase() !== "all" ? parseEventCategory(rawCat) : null;
  if (rawCat && rawCat.toLowerCase() !== "all" && !categoryFilter) {
    res.status(400).json({ error: "Invalid category.", allowed: [...EVENT_CATEGORIES, "all"] });
    return;
  }

  const allEvents = await db
    .select()
    .from(events)
    .where(
      categoryFilter
        ? and(eq(events.category, categoryFilter), eq(events.status, "published"))
        : eq(events.status, "published")
    )
    .orderBy(desc(events.featured), asc(events.startsAt));
  const tiers = await db.select().from(eventTiers).where(eq(eventTiers.active, true));

  const payload = allEvents.map((eventItem) => ({
    ...eventItem,
    tiers: tiers.filter((tier) => tier.eventId === eventItem.id)
  }));

  res.json(payload);
});

eventsRouter.get("/events/:eventId/tiers/:tierCode", async (req, res) => {
  const eventId = routeParamId(req.params.eventId);
  const tierCode = routeParamId(req.params.tierCode).toLowerCase();
  const eventRow = await db.query.events.findFirst({
    where: and(eq(events.id, eventId), eq(events.status, "published"))
  });
  if (!eventRow) {
    res.status(404).json({ error: "Tier not found." });
    return;
  }

  const tier = await db.query.eventTiers.findFirst({
    where: and(eq(eventTiers.eventId, eventId), eq(eventTiers.tierCode, tierCode))
  });

  if (!tier) {
    res.status(404).json({ error: "Tier not found." });
    return;
  }

  res.json(tier);
});
