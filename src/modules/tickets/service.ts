import { and, eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client";
import { config } from "../../config";
import { auditLogs, orders, tickets } from "../../db/schema";

export async function issueTicketForApprovedOrder(
  orderRef: string,
  telegramUserId: string,
  opts?: { telegramUsername?: string | null }
) {
  return db.transaction(async (tx) => {
    const order = await tx.query.orders.findFirst({
      where: eq(orders.orderRef, orderRef)
    });

    if (!order) {
      throw new Error("Order not found.");
    }
    if (order.status !== "approved" && order.status !== "ticket_issued") {
      throw new Error("Order is not approved yet.");
    }

    const existingTicket = await tx.query.tickets.findFirst({
      where: eq(tickets.orderId, order.id)
    });

    if (existingTicket) {
      return existingTicket;
    }

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

    const username =
      opts?.telegramUsername != null && opts.telegramUsername !== ""
        ? opts.telegramUsername
        : null;

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

    await tx
      .update(orders)
      .set({ status: "ticket_issued", updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), eq(orders.status, "approved")));

    await tx.insert(auditLogs).values({
      action: "ticket_claimed",
      actor: telegramUserId,
      entityType: "order",
      entityId: order.id,
      metadata: JSON.stringify({ orderRef, ticketId: created.id })
    });

    return created;
  });
}
