import express from "express";
import { desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { events, promoCodes } from "../../db/schema";
import { requireScanAuth, requireStaffRole } from "../scanner/scanAuth";

const createPromoSchema = z.object({
  code: z.string().min(2).max(40),
  eventId: z.string().uuid().optional().nullable(),
  discountType: z.enum(["percent", "fixed_total"]),
  discountValue: z.coerce.number().positive(),
  maxUses: z.coerce.number().int().positive().optional().nullable(),
  validFrom: z.string().min(1).optional().nullable(),
  validUntil: z.string().min(1).optional().nullable(),
  active: z.boolean().optional()
});

export const promoAdminRouter = express.Router();

promoAdminRouter.post(
  "/admin/promo-codes",
  requireScanAuth,
  requireStaffRole("organizer_admin"),
  async (req, res) => {
    const body = createPromoSchema.parse(req.body);
    const normalized = body.code.trim().toLowerCase();
    if (body.discountType === "percent" && body.discountValue > 100) {
      res.status(400).json({ error: "Percent discount cannot exceed 100." });
      return;
    }
    if (body.eventId) {
      const ev = await db.query.events.findFirst({ where: eq(events.id, body.eventId) });
      if (!ev) {
        res.status(404).json({ error: "Event not found." });
        return;
      }
    }
    try {
      const [row] = await db
        .insert(promoCodes)
        .values({
          code: normalized,
          eventId: body.eventId ?? undefined,
          discountType: body.discountType,
          discountValue: body.discountValue.toFixed(2),
          maxUses: body.maxUses ?? undefined,
          validFrom: body.validFrom ? new Date(body.validFrom) : undefined,
          validUntil: body.validUntil ? new Date(body.validUntil) : undefined,
          active: body.active ?? true
        })
        .returning();
      res.status(201).json(row);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        res.status(409).json({ error: "A promo with this code already exists." });
        return;
      }
      throw e;
    }
  }
);

promoAdminRouter.get(
  "/admin/promo-codes",
  requireScanAuth,
  requireStaffRole("finance"),
  async (req, res) => {
    const eventId = typeof req.query.eventId === "string" ? req.query.eventId.trim() : "";
    const rows = await db.query.promoCodes.findMany({
      where: eventId
        ? or(eq(promoCodes.eventId, eventId), isNull(promoCodes.eventId))
        : undefined,
      orderBy: [desc(promoCodes.createdAt)]
    });
    res.json({ rows });
  }
);
