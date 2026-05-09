import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { eventTiers } from "../../db/schema";

export type TierRow = typeof eventTiers.$inferSelect;

/**
 * Enable or disable early-bird pricing for a tier without clearing stored early-bird $ / end date.
 * Enabling requires both earlyBirdPrice and earlyBirdEndsAt to be set.
 */
export async function setTierEarlyBirdEnabled(
  eventId: string,
  tierId: string,
  enabled: boolean
): Promise<
  | { ok: true; row: TierRow }
  | { ok: false; error: "tier_not_found" | "early_bird_not_configured" }
> {
  const tier = await db.query.eventTiers.findFirst({
    where: and(eq(eventTiers.id, tierId), eq(eventTiers.eventId, eventId))
  });
  if (!tier) {
    return { ok: false, error: "tier_not_found" };
  }
  if (enabled && (tier.earlyBirdPrice == null || tier.earlyBirdEndsAt == null)) {
    return { ok: false, error: "early_bird_not_configured" };
  }
  const [row] = await db
    .update(eventTiers)
    .set({ earlyBirdEnabled: enabled, updatedAt: new Date() })
    .where(and(eq(eventTiers.id, tierId), eq(eventTiers.eventId, eventId)))
    .returning();
  if (!row) {
    return { ok: false, error: "tier_not_found" };
  }
  return { ok: true, row };
}
