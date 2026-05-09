import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { events } from "../../db/schema";
import { scheduleChannelAnnounceWhenNewlyPublished } from "../telegram/announceEventChannel";

export type EventRow = typeof events.$inferSelect;

/**
 * Turn public ticket sales on or off by setting status to `published` or `closed`.
 * Does not use `draft` — use PATCH /admin/events/:eventId for that.
 */
export async function setEventSalesActive(
  eventId: string,
  active: boolean
): Promise<{ ok: true; row: EventRow } | { ok: false; error: "not_found" }> {
  const existing = await db.query.events.findFirst({
    where: eq(events.id, eventId),
    columns: { status: true }
  });
  if (!existing) {
    return { ok: false, error: "not_found" };
  }
  const nextStatus = active ? "published" : "closed";
  const [row] = await db
    .update(events)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(events.id, eventId))
    .returning();
  if (!row) {
    return { ok: false, error: "not_found" };
  }
  if (active && existing.status !== "published") {
    scheduleChannelAnnounceWhenNewlyPublished(eventId, existing.status);
  }
  return { ok: true, row };
}
