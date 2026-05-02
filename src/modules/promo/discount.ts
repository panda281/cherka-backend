import type { promoCodes } from "../../db/schema";

export type PromoRow = typeof promoCodes.$inferSelect;

export class PromoApplyError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "PromoApplyError";
  }
}

export function computePromoDiscountEtb(subtotal: number, promo: PromoRow): number {
  if (subtotal <= 0 || !Number.isFinite(subtotal)) {
    return 0;
  }
  if (promo.discountType === "percent") {
    const pct = Number(promo.discountValue);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    const raw = (subtotal * Math.min(100, pct)) / 100;
    return Math.min(subtotal, roundMoney(raw));
  }
  const fixed = Number(promo.discountValue);
  if (!Number.isFinite(fixed) || fixed <= 0) return 0;
  return Math.min(subtotal, roundMoney(fixed));
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export function assertPromoUsable(promo: PromoRow, eventId: string, at: Date = new Date()): void {
  if (!promo.active) {
    throw new PromoApplyError("Promo code is not active.");
  }
  if (promo.eventId != null && promo.eventId !== eventId) {
    throw new PromoApplyError("Promo code does not apply to this event.");
  }
  if (promo.validFrom != null && at.getTime() < promo.validFrom.getTime()) {
    throw new PromoApplyError("Promo code is not valid yet.");
  }
  if (promo.validUntil != null && at.getTime() > promo.validUntil.getTime()) {
    throw new PromoApplyError("Promo code has expired.");
  }
  if (promo.maxUses != null && promo.usesCount >= promo.maxUses) {
    throw new PromoApplyError("Promo code has reached its usage limit.");
  }
  if (promo.discountType === "percent") {
    const p = Number(promo.discountValue);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      throw new PromoApplyError("Invalid promo configuration (percent).", 500);
    }
  } else {
    const f = Number(promo.discountValue);
    if (!Number.isFinite(f) || f <= 0) {
      throw new PromoApplyError("Invalid promo configuration (fixed discount).", 500);
    }
  }
}
