import { and, asc, eq, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client";
import { config } from "../../config";
import { auditLogs, eventTiers, events, orders, ticketSaleLedger, tickets } from "../../db/schema";

const MAX_TICKETS_PER_ORDER = 50;

function normalizedQuantity(raw: number | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_TICKETS_PER_ORDER, Math.max(1, Math.floor(n)));
}

export type IssuedTicketsResult = {
  tickets: (typeof tickets.$inferSelect)[];
  newlyIssued: (typeof tickets.$inferSelect)[];
};

/**
 * Ensures an approved order has exactly `order.quantity` ticket rows (each with its own QR).
 * Idempotent: repeated calls add only missing tickets and return full list.
 */
export async function issueTicketsForApprovedOrder(
  orderRef: string,
  telegramUserId: string,
  opts?: { telegramUsername?: string | null }
): Promise<IssuedTicketsResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM orders WHERE order_ref = ${orderRef} FOR UPDATE`);

    const order = await tx.query.orders.findFirst({
      where: eq(orders.orderRef, orderRef)
    });

    if (!order) {
      throw new Error("Order not found.");
    }
    if (order.status !== "approved" && order.status !== "ticket_issued") {
      throw new Error("Order is not approved yet.");
    }

    const tierRow = await tx.query.eventTiers.findFirst({
      where: eq(eventTiers.id, order.tierId)
    });

    const eventRow = await tx.query.events.findFirst({
      where: eq(events.id, order.eventId)
    });

    const qty = normalizedQuantity(order.quantity);

    const existing = await tx.query.tickets.findMany({
      where: eq(tickets.orderId, order.id),
      orderBy: [asc(tickets.createdAt)]
    });

    if (existing.length >= qty) {
      return { tickets: existing, newlyIssued: [] };
    }

    const username =
      opts?.telegramUsername != null && opts.telegramUsername !== ""
        ? opts.telegramUsername
        : null;

    const newlyIssued: (typeof tickets.$inferSelect)[] = [];

    for (let i = existing.length; i < qty; i++) {
      const tokenJti = randomUUID();
      const payload = {
        ticketId: randomUUID(),
        eventId: order.eventId,
        tierId: order.tierId,
        telegramUserId,
        jti: tokenJti,
        orderRef
      };
      const qrPayload = jwt.sign(payload, config.jwtSecret, { expiresIn: "14d" });
      const qrImageDataUrl = await QRCode.toDataURL(qrPayload, { errorCorrectionLevel: "M" });

      const [created] = await tx
        .insert(tickets)
        .values({
          orderId: order.id,
          telegramUserId,
          telegramUsername: username,
          tokenJti,
          qrPayload,
          qrImageDataUrl,
          status: "unused"
        })
        .returning();

      newlyIssued.push(created);

      const lineAllocated = (Number(order.expectedAmount) / qty).toFixed(2);
      await tx.insert(ticketSaleLedger).values({
        recordedAt: created.createdAt,
        ticketId: created.id,
        eventId: order.eventId,
        eventNameSnapshot: eventRow?.name ?? "unknown",
        tierId: order.tierId,
        tierCodeSnapshot: tierRow?.tierCode ?? "",
        tierNameSnapshot: tierRow?.tierName ?? "",
        listUnitPriceEtb: order.unitPriceEtb ?? tierRow?.price ?? "0",
        orderId: order.id,
        orderRef: order.orderRef,
        orderQuantity: qty,
        orderTotalEtb: order.expectedAmount,
        lineAllocatedEtb: lineAllocated,
        currency: "ETB",
        buyerTelegramUserId: telegramUserId,
        buyerTelegramUsername: username,
        source: "issue"
      });

      await tx.insert(auditLogs).values({
        action: "ticket_claimed",
        actor: telegramUserId,
        entityType: "order",
        entityId: order.id,
        metadata: JSON.stringify({
          orderRef,
          ticketId: created.id,
          ticketIndex: i + 1,
          quantity: qty,
          eventId: order.eventId,
          tierId: order.tierId,
          tierCode: tierRow?.tierCode ?? null,
          tierName: tierRow?.tierName ?? null
        })
      });
    }

    await tx
      .update(orders)
      .set({ status: "ticket_issued", updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), eq(orders.status, "approved")));

    return { tickets: [...existing, ...newlyIssued], newlyIssued };
  });
}

/** Returns the first ticket row after ensuring the full quantity is issued. */
export async function issueTicketForApprovedOrder(
  orderRef: string,
  telegramUserId: string,
  opts?: { telegramUsername?: string | null }
) {
  const { tickets: rows } = await issueTicketsForApprovedOrder(orderRef, telegramUserId, opts);
  const first = rows[0];
  if (!first) {
    throw new Error("No tickets could be issued.");
  }
  return first;
}
