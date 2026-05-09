import express from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { promoCodes } from "../../db/schema";
import { rateLimit } from "../../middleware/rateLimit";
import { assertPromoUsable, PromoApplyError } from "./discount";

const validateBodySchema = z.object({
  eventId: z.string().uuid(),
  promoCode: z.string().min(2).max(40)
});

export const promoValidateRouter = express.Router();

promoValidateRouter.post(
  "/promo-codes/validate",
  rateLimit(40, 60 * 1000),
  async (req, res) => {
    const body = validateBodySchema.parse(req.body);
    const normalized = body.promoCode.trim().toLowerCase();

    const row = await db.query.promoCodes.findFirst({
      where: eq(promoCodes.code, normalized)
    });

    if (!row) {
      res.json({
        valid: false as const,
        error: "Invalid promo code."
      });
      return;
    }

    try {
      assertPromoUsable(row, body.eventId);
    } catch (e) {
      if (e instanceof PromoApplyError) {
        res.json({
          valid: false as const,
          error: e.message
        });
        return;
      }
      throw e;
    }

    const usesRemaining =
      row.maxUses != null ? Math.max(0, row.maxUses - row.usesCount) : null;

    res.json({
      valid: true as const,
      promo: {
        id: row.id,
        name: row.name,
        code: row.code,
        eventId: row.eventId,
        discountType: row.discountType,
        discountValue: row.discountValue,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        usesRemaining
      }
    });
  }
);
