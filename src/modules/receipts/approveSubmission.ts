import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db/client";
import { auditLogs, orders, receiptSubmissions } from "../../db/schema";

export async function approveReceiptSubmission(params: {
  receiptId: string;
  verifiedBy: string;
  verificationNotes?: string;
  auditMetadata?: Record<string, unknown>;
}): Promise<
  | { ok: true; receipt: typeof receiptSubmissions.$inferSelect; order: typeof orders.$inferSelect }
  | { ok: false; error: string; statusCode: number }
> {
  const receipt = await db.query.receiptSubmissions.findFirst({
    where: eq(receiptSubmissions.id, params.receiptId)
  });
  if (!receipt) {
    return { ok: false, error: "Receipt submission not found.", statusCode: 404 };
  }

  const duplicate = await db.query.receiptSubmissions.findFirst({
    where: and(
      eq(receiptSubmissions.receiptNo, receipt.receiptNo),
      ne(receiptSubmissions.id, receipt.id),
      eq(receiptSubmissions.verificationStatus, "approved")
    )
  });

  if (duplicate) {
    return { ok: false, error: "Receipt already used in approved submission.", statusCode: 409 };
  }

  const [approvedReceipt] = await db
    .update(receiptSubmissions)
    .set({
      verificationStatus: "approved",
      verifiedBy: params.verifiedBy,
      verificationNotes: params.verificationNotes ?? "Approved.",
      updatedAt: new Date()
    })
    .where(eq(receiptSubmissions.id, receipt.id))
    .returning();

  const [updatedOrder] = await db
    .update(orders)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(orders.id, receipt.orderId))
    .returning();

  await db.insert(auditLogs).values({
    action: "receipt_approved",
    actor: params.verifiedBy,
    entityType: "receipt_submission",
    entityId: approvedReceipt.id,
    metadata: JSON.stringify(
      params.auditMetadata ?? {
        orderId: receipt.orderId
      }
    )
  });

  return { ok: true, receipt: approvedReceipt, order: updatedOrder };
}
