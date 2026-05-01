import express from "express";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { auditLogs, checkins, orders, receiptSubmissions, tickets } from "../../db/schema";
import { config } from "../../config";

const approveSchema = z.object({
  verifiedBy: z.string().min(2),
  amountMatched: z.boolean(),
  receiverMatched: z.boolean(),
  timeWindowMatched: z.boolean(),
  notes: z.string().optional()
});

const rejectSchema = z.object({
  verifiedBy: z.string().min(2),
  reason: z.enum([
    "REJECTED_AMOUNT_MISMATCH",
    "REJECTED_DUPLICATE_RECEIPT",
    "REJECTED_INVALID_RECEIPT",
    "REJECTED_RECEIVER_MISMATCH"
  ]),
  notes: z.string().optional()
});

export const adminReceiptsRouter = express.Router();

adminReceiptsRouter.get("/admin/receipt-submissions", async (req, res) => {
  const status = String(req.query.status ?? "verifying");
  const rows = await db.query.receiptSubmissions.findMany({
    where: eq(receiptSubmissions.verificationStatus, status as "verifying"),
    orderBy: [desc(receiptSubmissions.createdAt)]
  });

  res.json({
    telebirrReceiver: config.telebirrReceiver,
    telebirrReceiverName: config.telebirrReceiverName,
    rows
  });
});

adminReceiptsRouter.post("/admin/receipt-submissions/:receiptId/approve", async (req, res) => {
  const body = approveSchema.parse(req.body);
  const receipt = await db.query.receiptSubmissions.findFirst({
    where: eq(receiptSubmissions.id, req.params.receiptId)
  });
  if (!receipt) {
    res.status(404).json({ error: "Receipt submission not found." });
    return;
  }

  const duplicate = await db.query.receiptSubmissions.findFirst({
    where: and(
      eq(receiptSubmissions.receiptNo, receipt.receiptNo),
      ne(receiptSubmissions.id, receipt.id),
      eq(receiptSubmissions.verificationStatus, "approved")
    )
  });

  if (duplicate) {
    res.status(409).json({ error: "Receipt already used in approved submission." });
    return;
  }

  if (!body.amountMatched || !body.receiverMatched || !body.timeWindowMatched) {
    res.status(422).json({ error: "Approval checklist failed. Use reject endpoint." });
    return;
  }

  const [approvedReceipt] = await db
    .update(receiptSubmissions)
    .set({
      verificationStatus: "approved",
      verifiedBy: body.verifiedBy,
      verificationNotes: body.notes ?? "Approved by manual verification checklist.",
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
    actor: body.verifiedBy,
    entityType: "receipt_submission",
    entityId: approvedReceipt.id,
    metadata: JSON.stringify({
      orderId: receipt.orderId,
      amountMatched: body.amountMatched,
      receiverMatched: body.receiverMatched,
      timeWindowMatched: body.timeWindowMatched
    })
  });

  res.json({ receipt: approvedReceipt, order: updatedOrder });
});

adminReceiptsRouter.post("/admin/receipt-submissions/:receiptId/reject", async (req, res) => {
  const body = rejectSchema.parse(req.body);
  const receipt = await db.query.receiptSubmissions.findFirst({
    where: eq(receiptSubmissions.id, req.params.receiptId)
  });
  if (!receipt) {
    res.status(404).json({ error: "Receipt submission not found." });
    return;
  }

  const [rejectedReceipt] = await db
    .update(receiptSubmissions)
    .set({
      verificationStatus: "rejected",
      verifiedBy: body.verifiedBy,
      verificationNotes: `${body.reason}${body.notes ? `: ${body.notes}` : ""}`,
      updatedAt: new Date()
    })
    .where(eq(receiptSubmissions.id, receipt.id))
    .returning();

  const [updatedOrder] = await db
    .update(orders)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(orders.id, receipt.orderId))
    .returning();

  await db.insert(auditLogs).values({
    action: "receipt_rejected",
    actor: body.verifiedBy,
    entityType: "receipt_submission",
    entityId: rejectedReceipt.id,
    metadata: JSON.stringify({ reason: body.reason, orderId: receipt.orderId })
  });

  res.json({ receipt: rejectedReceipt, order: updatedOrder });
});

adminReceiptsRouter.get("/admin/metrics", async (_req, res) => {
  const [pending] = await db.select({ count: sql<number>`count(*)::int` }).from(receiptSubmissions).where(eq(receiptSubmissions.verificationStatus, "verifying"));
  const [approved] = await db.select({ count: sql<number>`count(*)::int` }).from(receiptSubmissions).where(eq(receiptSubmissions.verificationStatus, "approved"));
  const [rejected] = await db.select({ count: sql<number>`count(*)::int` }).from(receiptSubmissions).where(eq(receiptSubmissions.verificationStatus, "rejected"));
  const ticketRows = await db
    .select({
      eventId: orders.eventId,
      tierId: orders.tierId,
      status: tickets.status,
      count: sql<number>`count(*)::int`
    })
    .from(tickets)
    .innerJoin(orders, eq(tickets.orderId, orders.id))
    .groupBy(orders.eventId, orders.tierId, tickets.status);
  const [checkinCount] = await db.select({ count: sql<number>`count(*)::int` }).from(checkins);

  res.json({
    pendingVerifications: pending.count,
    approvedVerifications: approved.count,
    rejectedVerifications: rejected.count,
    totalCheckins: checkinCount.count,
    ticketSummary: ticketRows
  });
});
