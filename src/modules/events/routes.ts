import express from "express";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { eventTiers, events } from "../../db/schema";

export const eventsRouter = express.Router();

const createEventSchema = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  location: z.string().optional(),
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
  capacity: z.number().int().positive().optional(),
  active: z.boolean().optional()
});

eventsRouter.post("/admin/events", async (req, res) => {
  const data = createEventSchema.parse(req.body);
  const inserted = await db
    .insert(events)
    .values({
      ...data,
      startsAt: new Date(data.startsAt),
      endsAt: new Date(data.endsAt),
      status: data.status ?? "draft"
    })
    .returning();

  res.status(201).json(inserted[0]);
});

eventsRouter.post("/admin/events/:eventId/tiers", async (req, res) => {
  const data = createTierSchema.parse(req.body);
  const inserted = await db
    .insert(eventTiers)
    .values({
      eventId: req.params.eventId,
      tierCode: data.tierCode.toLowerCase(),
      tierName: data.tierName,
      price: data.price.toFixed(2),
      capacity: data.capacity,
      active: data.active ?? true
    })
    .returning();

  res.status(201).json(inserted[0]);
});

eventsRouter.patch("/admin/events/:eventId/tiers/:tierId", async (req, res) => {
  const data = createTierSchema.partial().parse(req.body);
  const updated = await db
    .update(eventTiers)
    .set({
      tierCode: data.tierCode?.toLowerCase(),
      tierName: data.tierName,
      price: data.price?.toFixed(2),
      capacity: data.capacity,
      active: data.active
    })
    .where(and(eq(eventTiers.id, req.params.tierId), eq(eventTiers.eventId, req.params.eventId)))
    .returning();

  if (!updated.length) {
    res.status(404).json({ error: "Tier not found" });
    return;
  }
  res.json(updated[0]);
});

eventsRouter.get("/events", async (_req, res) => {
  const allEvents = await db.select().from(events).orderBy(asc(events.startsAt));
  const tiers = await db.select().from(eventTiers).where(eq(eventTiers.active, true));

  const payload = allEvents.map((eventItem) => ({
    ...eventItem,
    tiers: tiers.filter((tier) => tier.eventId === eventItem.id)
  }));

  res.json(payload);
});

eventsRouter.get("/events/:eventId/tiers/:tierCode", async (req, res) => {
  const tier = await db.query.eventTiers.findFirst({
    where: and(eq(eventTiers.eventId, req.params.eventId), eq(eventTiers.tierCode, req.params.tierCode))
  });

  if (!tier) {
    res.status(404).json({ error: "Tier not found." });
    return;
  }

  res.json(tier);
});
