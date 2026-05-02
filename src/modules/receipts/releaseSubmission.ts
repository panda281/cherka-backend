import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { auditLogs, orders, receiptSubmissions, tickets } from "../../db/schema";

export type ReleaseReceiptSubmissionResult =
  | { ok: true; orderId: string; freedReceiptNo: string }
  | { ok: false; error: string; statusCode: number };

/**
 * Deletes a rejected or verifying receipt submission so its Telebirr receipt number can be submitted again
 * (same or different order). Resets the order to pending_receipt. Never allowed for approved receipts or
 * when the order already has ticket rows.
 */
export async function releaseReceiptSubmissionForResubmit(params: {
  receiptId: string;
  actor: string;
  notes?: string;
}): Promise<ReleaseReceiptSubmissionResult> {
  return db.transaction(async (tx) => {
    const receipt = await tx.query.receiptSubmissions.findFirst({
      where: eq(receiptSubmissions.id, params.receiptId)
    });
    if (!receipt) {
      return { ok: false, error: "Receipt submission not found.", statusCode: 404 };
    }

    if (receipt.verificationStatus === "approved") {
      return { ok: false, error: "Cannot release an approved receipt.", statusCode: 409 };
    }
    if (receipt.verificationStatus !== "rejected" && receipt.verificationStatus !== "verifying") {
      return {
        ok: false,
        error: "Only rejected or verifying submissions can be released.",
        statusCode: 422
      };
    }

    const order = await tx.query.orders.findFirst({ where: eq(orders.id, receipt.orderId) });
    if (!order) {
      return { ok: false, error: "Order not found for this receipt.", statusCode: 404 };
    }
    if (order.status === "approved" || order.status === "ticket_issued") {
      return {
        ok: false,
        error: "Order is already approved or has tickets issued; release is blocked.",
        statusCode: 409
      };
    }

    const [ticketRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .where(eq(tickets.orderId, receipt.orderId));
    if ((ticketRow?.n ?? 0) > 0) {
      return {
        ok: false,
        error: "This order already has ticket rows; release is blocked.",
        statusCode: 409
      };
    }

    const freedReceiptNo = receipt.receiptNo;

    await tx.delete(receiptSubmissions).where(eq(receiptSubmissions.id, receipt.id));

    await tx
      .update(orders)
      .set({ status: "pending_receipt", updatedAt: new Date() })
      .where(eq(orders.id, receipt.orderId));

    await tx.insert(auditLogs).values({
      action: "receipt_released",
      actor: params.actor,
      entityType: "receipt_submission",
      entityId: receipt.id,
      metadata: JSON.stringify({
        orderId: receipt.orderId,
        receiptNo: freedReceiptNo,
        previousStatus: receipt.verificationStatus,
        notes: params.notes ?? null
      })
    });

    return { ok: true, orderId: receipt.orderId, freedReceiptNo };
  });
}
