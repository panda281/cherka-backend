import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { orders, tickets } from "../../db/schema";
import { logReceiptVerify } from "../receipts/verifyLogging";
import { issueTicketsForApprovedOrder } from "../tickets/service";
import { pushTicketQrToTelegramUser } from "./pushTicketPhoto";

function ticketPushCaption(orderRef: string, indexOneBased: number, totalQty: number): string | undefined {
  if (totalQty <= 1) return undefined;
  return `Ticket ${indexOneBased}/${totalQty} for order ${orderRef}. Each QR can be used once.`;
}

export type PushAllTicketQrsResult =
  | { ok: true; pushed: number; total: number; orderRef: string; warning?: string }
  | { ok: false; error: string };

/**
 * Ensures ticket rows exist, then sends each QR image to the ticket holder via the user bot.
 * Used for admin “resend” and relies on idempotent issueTicketsForApprovedOrder.
 */
export async function pushAllTicketQrsForOrder(params: {
  orderRef: string;
  actorLabel: string;
}): Promise<PushAllTicketQrsResult> {
  const order = await db.query.orders.findFirst({ where: eq(orders.orderRef, params.orderRef) });
  if (!order) {
    return { ok: false, error: "Order not found." };
  }
  if (order.status !== "approved" && order.status !== "ticket_issued") {
    return { ok: false, error: `Order is not approved (status: ${order.status}).` };
  }

  const tgId = order.telegramUserId?.trim();
  if (!tgId) {
    return {
      ok: false,
      error:
        "No Telegram user linked to this order. The buyer must open the user bot and run /claim ORDER_REF from their account."
    };
  }

  await issueTicketsForApprovedOrder(params.orderRef, tgId);

  const rows = await db.query.tickets.findMany({
    where: eq(tickets.orderId, order.id),
    orderBy: [asc(tickets.createdAt)]
  });
  if (!rows.length) {
    return { ok: false, error: "No ticket rows exist for this order yet." };
  }

  const qty = Math.max(1, order.quantity);
  let pushed = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]!;
    const chatId = t.telegramUserId.trim();
    const r = await pushTicketQrToTelegramUser({
      telegramUserId: chatId,
      orderRef: params.orderRef,
      qrImageDataUrl: t.qrImageDataUrl,
      caption: ticketPushCaption(params.orderRef, i + 1, qty)
    });
    if (r.ok) {
      pushed++;
    } else {
      errors.push(r.error);
      logReceiptVerify("ticket_resend_push_fail", {
        orderRef: params.orderRef,
        ticketId: t.id,
        actor: params.actorLabel,
        error: r.error
      });
    }
  }

  logReceiptVerify("ticket_resend_push_batch_done", {
    orderRef: params.orderRef,
    actor: params.actorLabel,
    pushed,
    total: rows.length
  });

  if (pushed === 0) {
    return { ok: false, error: errors[0] ?? "All Telegram sends failed." };
  }

  if (pushed < rows.length) {
    return {
      ok: true,
      pushed,
      total: rows.length,
      orderRef: params.orderRef,
      warning: `Only ${pushed}/${rows.length} delivered. ${errors[0] ?? ""}`.trim()
    };
  }

  return { ok: true, pushed, total: rows.length, orderRef: params.orderRef };
}
