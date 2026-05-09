import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { events, promoCodes } from "../../db/schema";
import { generatePromoCode } from "../../utils";

export const MAX_PROMOS_PER_REQUEST = 200;

export type CreatePromoBatchInput = {
  promoName: string;
  count: number;
  eventId?: string | null;
  discountType: "percent" | "fixed_total";
  discountValue: number;
  maxUses?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  active?: boolean;
};

export type PatchPromoInput = {
  promoName?: string;
  eventId?: string | null;
  discountType?: "percent" | "fixed_total";
  discountValue?: number;
  maxUses?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  active?: boolean;
};

function validateCreateInput(input: CreatePromoBatchInput): string | null {
  if (input.discountType === "percent" && input.discountValue > 100) {
    return "Percent discount cannot exceed 100.";
  }
  if (input.count < 1 || input.count > MAX_PROMOS_PER_REQUEST) {
    return `Count must be between 1 and ${MAX_PROMOS_PER_REQUEST}.`;
  }
  return null;
}

export async function createPromoBatch(
  input: CreatePromoBatchInput
): Promise<
  | { ok: true; rows: (typeof promoCodes.$inferSelect)[] }
  | { ok: false; error: string; code: "validation" | "event" | "alloc" | "db" }
> {
  const v = validateCreateInput(input);
  if (v) return { ok: false, error: v, code: "validation" };

  if (input.eventId) {
    const ev = await db.query.events.findFirst({ where: eq(events.id, input.eventId) });
    if (!ev) return { ok: false, error: "Event not found.", code: "event" };
  }

  const nameTrimmed = input.promoName.trim();

  try {
    const rows = await db.transaction(async (tx) => {
      const codes: string[] = [];
      let safety = 0;
      while (codes.length < input.count && safety < 4000) {
        safety++;
        const candidates = new Set<string>();
        const need = input.count - codes.length;
        while (candidates.size < need + 32) {
          candidates.add(generatePromoCode());
        }
        const list = [...candidates].filter((c) => !codes.includes(c));
        if (!list.length) continue;
        const clash = await tx
          .select({ code: promoCodes.code })
          .from(promoCodes)
          .where(inArray(promoCodes.code, list));
        const taken = new Set(clash.map((r) => r.code));
        for (const c of list) {
          if (codes.length >= input.count) break;
          if (!taken.has(c)) codes.push(c);
        }
      }
      if (codes.length < input.count) {
        throw new Error("UNIQUE_PROMO_ALLOC_FAILED");
      }

      const common = {
        name: nameTrimmed,
        eventId: input.eventId ?? undefined,
        discountType: input.discountType,
        discountValue: input.discountValue.toFixed(2),
        maxUses: input.maxUses ?? undefined,
        validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
        validUntil: input.validUntil ? new Date(input.validUntil) : undefined,
        active: input.active ?? true
      } as const;

      return tx
        .insert(promoCodes)
        .values(
          codes.map((code) => ({
            code,
            ...common
          }))
        )
        .returning();
    });

    return { ok: true, rows };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "UNIQUE_PROMO_ALLOC_FAILED") {
      return { ok: false, error: "Could not allocate enough unique promo codes.", code: "alloc" };
    }
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return { ok: false, error: "Duplicate code collision. Retry.", code: "db" };
    }
    throw e;
  }
}

export async function updatePromoById(
  promoId: string,
  body: PatchPromoInput
): Promise<
  | { ok: true; row: typeof promoCodes.$inferSelect }
  | { ok: false; error: string; status: number }
> {
  const keys = Object.keys(body).filter((k) => body[k as keyof PatchPromoInput] !== undefined);
  if (keys.length === 0) {
    return { ok: false, error: "At least one field is required.", status: 400 };
  }

  const existing = await db.query.promoCodes.findFirst({
    where: eq(promoCodes.id, promoId)
  });
  if (!existing) {
    return { ok: false, error: "Promo code not found.", status: 404 };
  }

  const discountType = body.discountType ?? existing.discountType;
  const discountValueNum = body.discountValue ?? Number(existing.discountValue);

  if (discountType === "percent") {
    if (discountValueNum > 100) {
      return { ok: false, error: "Percent discount cannot exceed 100.", status: 400 };
    }
    if (!Number.isFinite(discountValueNum) || discountValueNum <= 0) {
      return { ok: false, error: "Percent discount must be between 0 and 100.", status: 400 };
    }
  } else if (!Number.isFinite(discountValueNum) || discountValueNum <= 0) {
    return { ok: false, error: "Fixed discount must be positive.", status: 400 };
  }

  const nextEventId = body.eventId !== undefined ? body.eventId : existing.eventId;
  if (nextEventId) {
    const ev = await db.query.events.findFirst({ where: eq(events.id, nextEventId) });
    if (!ev) {
      return { ok: false, error: "Event not found.", status: 404 };
    }
  }

  const nextMaxUses = body.maxUses !== undefined ? body.maxUses : existing.maxUses;
  if (nextMaxUses != null && nextMaxUses < existing.usesCount) {
    return {
      ok: false,
      error: `maxUses cannot be less than current uses (${existing.usesCount}).`,
      status: 400
    };
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.promoName !== undefined) patch.name = body.promoName.trim();
  if (body.eventId !== undefined) patch.eventId = body.eventId;
  if (body.discountType !== undefined) patch.discountType = body.discountType;
  if (body.discountValue !== undefined) patch.discountValue = body.discountValue.toFixed(2);
  if (body.maxUses !== undefined) patch.maxUses = body.maxUses;
  if (body.validFrom !== undefined) patch.validFrom = body.validFrom ? new Date(body.validFrom) : null;
  if (body.validUntil !== undefined) patch.validUntil = body.validUntil ? new Date(body.validUntil) : null;
  if (body.active !== undefined) patch.active = body.active;

  const [updated] = await db.update(promoCodes).set(patch).where(eq(promoCodes.id, promoId)).returning();
  if (!updated) {
    return { ok: false, error: "Promo code not found.", status: 404 };
  }
  return { ok: true, row: updated };
}

export async function deletePromoById(promoId: string): Promise<boolean> {
  const deleted = await db.delete(promoCodes).where(eq(promoCodes.id, promoId)).returning({ id: promoCodes.id });
  return deleted.length > 0;
}
