import express from "express";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { auditLogs, checkins, orders, receiptSubmissions, tickets } from "../../db/schema";
import { config } from "../../config";
import { requireScanAuth, requireStaffRole } from "../scanner/scanAuth";
import { approveReceiptSubmission } from "./approveSubmission";
import { reverifyReceiptWithTelebirrApi } from "./reverifySubmission";
import { releaseReceiptSubmissionForResubmit } from "./releaseSubmission";

const approveSchema = z.object({
  verifiedBy: z.string().min(2),
  amountMatched: z.boolean(),
  receiverMatched: z.boolean(),
  timeWindowMatched: z.boolean(),
  notes: z.string().optional()
});

const reverifySchema = z.object({
  verifiedBy: z.string().min(2)
});

const releaseSubmissionSchema = z.object({
  releasedBy: z.string().min(2),
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

adminReceiptsRouter.use(requireScanAuth, requireStaffRole("organizer_admin"));

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

  const outcome = await approveReceiptSubmission({
    receiptId: receipt.id,
    verifiedBy: body.verifiedBy,
    verificationNotes: body.notes ?? "Approved by manual verification checklist.",
    auditMetadata: {
      orderId: receipt.orderId,
      amountMatched: body.amountMatched,
      receiverMatched: body.receiverMatched,
      timeWindowMatched: body.timeWindowMatched
    }
  });

  if (!outcome.ok) {
    res.status(outcome.statusCode).json({ error: outcome.error });
    return;
  }

  res.json({ receipt: outcome.receipt, order: outcome.order });
});

/** Re-run Telebirr API on a receipt still in `verifying`; approve + issue ticket when possible (QR push only via admin Telegram /reverify). */
adminReceiptsRouter.post("/admin/receipt-submissions/:receiptId/reverify", async (req, res) => {
  const body = reverifySchema.parse(req.body);
  const result = await reverifyReceiptWithTelebirrApi({
    receiptId: req.params.receiptId,
    verifiedBy: body.verifiedBy
  });
  if (!result.ok) {
    res.status(400).json({ error: result.message, receiptId: result.receiptId });
    return;
  }
  res.json({
    ok: true,
    orderRef: result.orderRef,
    receiptId: result.receiptId,
    verificationNotes: result.verificationNotes,
    hasTicket: result.hasTicket,
    ticketId: result.ticket?.id ?? null,
    ticketIds: result.tickets.map((t) => t.id),
    ticketsIssuedThisCall: result.newlyIssuedTickets.map((t) => t.id),
    telegramUserId: result.telegramUserId
  });
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

/**
 * Remove a rejected or verifying submission so the same Telebirr receipt_no can be used again;
 * resets the order to pending_receipt. Blocked if the order is approved/ticket_issued or has ticket rows.
 */
adminReceiptsRouter.post("/admin/receipt-submissions/:receiptId/release", async (req, res) => {
  const body = releaseSubmissionSchema.parse(req.body);
  const result = await releaseReceiptSubmissionForResubmit({
    receiptId: req.params.receiptId,
    actor: body.releasedBy,
    notes: body.notes
  });
  if (!result.ok) {
    res.status(result.statusCode).json({ error: result.error });
    return;
  }
  const order = await db.query.orders.findFirst({ where: eq(orders.id, result.orderId) });
  res.json({
    ok: true,
    freedReceiptNo: result.freedReceiptNo,
    orderId: result.orderId,
    order: order ?? null
  });
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
