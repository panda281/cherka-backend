import { eq } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db/client";
import { orders, receiptSubmissions } from "../../db/schema";
import { issueTicketsForApprovedOrder } from "../tickets/service";
import { approveReceiptSubmission } from "./approveSubmission";
import { logReceiptVerify } from "./verifyLogging";
import { resolveReceiptVerification } from "./verifier";

type TicketRow = Awaited<ReturnType<typeof issueTicketsForApprovedOrder>>["tickets"][number];

export type ReverifyTelebirrResult =
  | {
      ok: true;
      receiptId: string;
      orderRef: string;
      verificationNotes: string;
      /** All ticket rows for this order after issuance */
      tickets: TicketRow[];
      /** Tickets created or filled in by this call */
      newlyIssuedTickets: TicketRow[];
      /** First ticket; kept for older clients */
      ticket: TicketRow | null;
      telegramUserId: string | null;
      hasTicket: boolean;
    }
  | { ok: false; message: string; receiptId?: string };

export async function reverifyReceiptWithTelebirrApi(params: {
  receiptId: string;
  verifiedBy: string;
}): Promise<ReverifyTelebirrResult> {
  if (!config.receiptVerifyTelebirrUrl?.trim()) {
    return {
      ok: false,
      message: "RECEIPT_VERIFY_TELEBIRR_URL is not set — cannot re-run automatic Telebirr verification."
    };
  }

  const receipt = await db.query.receiptSubmissions.findFirst({
    where: eq(receiptSubmissions.id, params.receiptId)
  });
  if (!receipt) {
    return { ok: false, message: "Receipt not found." };
  }
  if (receipt.verificationStatus !== "verifying") {
    return {
      ok: false,
      receiptId: receipt.id,
      message: `Receipt is not pending verification (status: ${receipt.verificationStatus}). Only "verifying" receipts can be re-verified.`
    };
  }

  const order = await db.query.orders.findFirst({ where: eq(orders.id, receipt.orderId) });
  if (!order) {
    return { ok: false, message: "Order not found." };
  }

  logReceiptVerify("admin_reverify_start", {
    receiptId: receipt.id,
    orderRef: order.orderRef,
    receiptNo: receipt.receiptNo,
    verifiedBy: params.verifiedBy
  });

  const verifyResult = await resolveReceiptVerification(
    {
      receiptNo: receipt.receiptNo,
      expectedAmount: Number(order.expectedAmount),
      receiverNumber: config.telebirrReceiver,
      receiverName: config.telebirrReceiverName
    },
    { skipExternalApi: false }
  );

  if (!verifyResult.ok) {
    logReceiptVerify("admin_reverify_failed", {
      receiptId: receipt.id,
      orderRef: order.orderRef,
      notes: verifyResult.notes.slice(0, 500)
    });
    return {
      ok: false,
      receiptId: receipt.id,
      message: `Telebirr check did not pass: ${verifyResult.notes}`
    };
  }

  const approved = await approveReceiptSubmission({
    receiptId: receipt.id,
    verifiedBy: params.verifiedBy,
    verificationNotes: verifyResult.notes,
    auditMetadata: { orderId: order.id, source: "admin_reverify_telebirr" }
  });

  if (!approved.ok) {
    return { ok: false, receiptId: receipt.id, message: approved.error };
  }

  const freshOrder = approved.order;
  const tgId = freshOrder.telegramUserId?.trim() || null;

  if (!tgId) {
    logReceiptVerify("admin_reverify_ok_no_telegram", { receiptId: receipt.id, orderRef: freshOrder.orderRef });
    return {
      ok: true,
      receiptId: receipt.id,
      orderRef: freshOrder.orderRef,
      verificationNotes: verifyResult.notes,
      tickets: [],
      newlyIssuedTickets: [],
      ticket: null,
      telegramUserId: null,
      hasTicket: false
    };
  }

  try {
    const issued = await issueTicketsForApprovedOrder(freshOrder.orderRef, tgId);
    logReceiptVerify("admin_reverify_ok_ticket", {
      receiptId: receipt.id,
      orderRef: freshOrder.orderRef,
      ticketIds: issued.newlyIssued.map((t) => t.id),
      telegramUserId: tgId
    });
    return {
      ok: true,
      receiptId: receipt.id,
      orderRef: freshOrder.orderRef,
      verificationNotes: verifyResult.notes,
      tickets: issued.tickets,
      newlyIssuedTickets: issued.newlyIssued,
      ticket: issued.tickets[0] ?? null,
      telegramUserId: tgId,
      hasTicket: issued.tickets.length > 0
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logReceiptVerify("admin_reverify_ok_ticket_fail", {
      receiptId: receipt.id,
      orderRef: freshOrder.orderRef,
      error: msg
    });
    return {
      ok: true,
      receiptId: receipt.id,
      orderRef: freshOrder.orderRef,
      verificationNotes: `${verifyResult.notes} (ticket issue failed: ${msg})`,
      tickets: [],
      newlyIssuedTickets: [],
      ticket: null,
      telegramUserId: tgId,
      hasTicket: false
    };
  }
}
