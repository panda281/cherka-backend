import express from "express";
import { desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { promoCodes } from "../../db/schema";
import { createPromoBatch, MAX_PROMOS_PER_REQUEST, updatePromoById } from "./service";
import { requireScanAuth, requireStaffRole } from "../scanner/scanAuth";

const createPromoSchema = z.object({
  promoName: z.string().min(1).max(200),
  count: z.coerce.number().int().min(1).max(MAX_PROMOS_PER_REQUEST),
  eventId: z.string().uuid().optional().nullable(),
  discountType: z.enum(["percent", "fixed_total"]),
  discountValue: z.coerce.number().positive(),
  maxUses: z.coerce.number().int().positive().optional().nullable(),
  validFrom: z.string().min(1).optional().nullable(),
  validUntil: z.string().min(1).optional().nullable(),
  active: z.boolean().optional()
});

const patchPromoSchema = z
  .object({
    promoName: z.string().min(1).max(200).optional(),
    eventId: z.string().uuid().nullable().optional(),
    discountType: z.enum(["percent", "fixed_total"]).optional(),
    discountValue: z.coerce.number().positive().optional(),
    maxUses: z.coerce.number().int().positive().nullable().optional(),
    validFrom: z.string().min(1).nullable().optional(),
    validUntil: z.string().min(1).nullable().optional(),
    active: z.boolean().optional()
  })
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field is required." });

export const promoAdminRouter = express.Router();

promoAdminRouter.post(
  "/admin/promo-codes",
  requireScanAuth,
  requireStaffRole("organizer_admin"),
  async (req, res) => {
    const body = createPromoSchema.parse(req.body);
    const result = await createPromoBatch({
      promoName: body.promoName,
      count: body.count,
      eventId: body.eventId,
      discountType: body.discountType,
      discountValue: body.discountValue,
      maxUses: body.maxUses,
      validFrom: body.validFrom,
      validUntil: body.validUntil,
      active: body.active
    });

    if (!result.ok) {
      const status =
        result.code === "event" ? 404 : result.code === "validation" ? 400 : result.code === "alloc" ? 503 : 409;
      res.status(status).json({ error: result.error });
      return;
    }

    res.status(201).json({ rows: result.rows, count: result.rows.length });
  }
);

promoAdminRouter.patch(
  "/admin/promo-codes/:promoId",
  requireScanAuth,
  requireStaffRole("organizer_admin"),
  async (req, res) => {
    const promoId = z.string().uuid().parse(req.params.promoId);
    const body = patchPromoSchema.parse(req.body);

    const result = await updatePromoById(promoId, {
      promoName: body.promoName,
      eventId: body.eventId,
      discountType: body.discountType,
      discountValue: body.discountValue,
      maxUses: body.maxUses,
      validFrom: body.validFrom,
      validUntil: body.validUntil,
      active: body.active
    });

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json({ row: result.row });
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
