/** Tier row subset: effective unit (early bird while window open, else regular `price`). */
export type TierPricingInput = {
  price: string;
  earlyBirdPrice: string | null;
  earlyBirdEndsAt: Date | null;
  /** When false, early-bird fields are ignored (defaults to on for backward compatibility). */
  earlyBirdEnabled?: boolean;
};

export function effectiveUnitPriceEtb(tier: TierPricingInput, at: Date = new Date()): number {
  const regular = Number(tier.price);
  if (!Number.isFinite(regular)) {
    throw new Error("Invalid tier regular price.");
  }
  if (tier.earlyBirdEnabled === false) {
    return regular;
  }
  const ebRaw = tier.earlyBirdPrice != null ? Number(tier.earlyBirdPrice) : null;
  const ends = tier.earlyBirdEndsAt;
  if (
    ebRaw != null &&
    Number.isFinite(ebRaw) &&
    ebRaw > 0 &&
    ends != null &&
    at.getTime() < ends.getTime()
  ) {
    return ebRaw;
  }
  return regular;
}
