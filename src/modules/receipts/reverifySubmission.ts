import { eq } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db/client";
import { orders, receiptSubmissions } from "../../db/schema";
import { issueTicketForApprovedOrder } from "../tickets/service";
import { approveReceiptSubmission } from "./approveSubmission";
import { logReceiptVerify } from "./verifyLogging";
import { resolveReceiptVerification } from "./verifier";

export type ReverifyTelebirrResult =
  | {
      ok: true;
      receiptId: string;
      orderRef: string;
      verificationNotes: string;
      ticket: Awaited<ReturnType<typeof issueTicketForApprovedOrder>> | null;
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
      ticket: null,
      telegramUserId: null,
      hasTicket: false
    };
  }

  try {
    const ticket = await issueTicketForApprovedOrder(freshOrder.orderRef, tgId);
    logReceiptVerify("admin_reverify_ok_ticket", {
      receiptId: receipt.id,
      orderRef: freshOrder.orderRef,
      ticketId: ticket.id,
      telegramUserId: tgId
    });
    return {
      ok: true,
      receiptId: receipt.id,
      orderRef: freshOrder.orderRef,
      verificationNotes: verifyResult.notes,
      ticket,
      telegramUserId: tgId,
      hasTicket: true
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
      ticket: null,
      telegramUserId: tgId,
      hasTicket: false
    };
  }
}
