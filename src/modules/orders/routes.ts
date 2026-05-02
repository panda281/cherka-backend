import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { events, eventTiers, orders, promoCodes, receiptSubmissions, tickets } from "../../db/schema";
import { effectiveUnitPriceEtb } from "../pricing/effectiveUnitPrice";
import { assertPromoUsable, computePromoDiscountEtb, PromoApplyError } from "../promo/discount";
import { config } from "../../config";
import { buildOrderRef, buildReceiptUrl, buildTelegramUserBotOrderDeepLink, sha256 } from "../../utils";
import { approveReceiptSubmission } from "../receipts/approveSubmission";
import { logReceiptVerify } from "../receipts/verifyLogging";
import { resolveReceiptVerification } from "../receipts/verifier";
import { pushTicketQrToTelegramUser } from "../telegram/pushTicketPhoto";
import { issueTicketsForApprovedOrder } from "../tickets/service";
import { rateLimit } from "../../middleware/rateLimit";

const uploadDir = path.resolve("uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

const MAX_TICKETS_PER_ORDER = 50;

const createOrderSchema = z.object({
  eventId: z.string().uuid(),
  tierId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(MAX_TICKETS_PER_ORDER).optional().default(1),
  payerPhone: z.string().optional(),
  telegramUserId: z.string().min(1).optional(),
  promoCode: z.string().min(2).max(40).optional()
});

const receiptBodySchema = z.object({
  receiptNo: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().min(6)),
  verifierMode: z.enum(["manual", "parser"]).optional(),
  /** Telegram numeric user id — link buyer so a ticket row is created and /myticket works */
  telegramUserId: z.string().min(1).optional(),
  telegramUsername: z.string().optional()
});

export const ordersRouter = express.Router();

function roundEtb(n: number): number {
  return Math.round(n * 100) / 100;
}

ordersRouter.post("/orders", async (req, res) => {
  const payload = createOrderSchema.parse(req.body);
  const eventRow = await db.query.events.findFirst({
    where: eq(events.id, payload.eventId)
  });
  if (!eventRow) {
    res.status(404).json({ error: "Event not found." });
    return;
  }
  if (eventRow.status !== "published") {
    res.status(403).json({
      error: "This event is not open for new orders.",
      eventStatus: eventRow.status
    });
    return;
  }

  const tier = await db.query.eventTiers.findFirst({
    where: and(eq(eventTiers.id, payload.tierId), eq(eventTiers.eventId, payload.eventId), eq(eventTiers.active, true))
  });

  if (!tier) {
    res.status(404).json({ error: "Active tier not found for event." });
    return;
  }

  const qty = payload.quantity;
  const promoNormalized = payload.promoCode?.trim().toLowerCase();

  try {
    const checkout = await db.transaction(async (tx) => {
      let promoRow: (typeof promoCodes.$inferSelect) | null = null;
      if (promoNormalized) {
        const locked = await tx
          .select()
          .from(promoCodes)
          .where(eq(promoCodes.code, promoNormalized))
          .for("update")
          .limit(1);
        promoRow = locked[0] ?? null;
        if (!promoRow) {
          throw new PromoApplyError("Invalid promo code.");
        }
        assertPromoUsable(promoRow, payload.eventId);
      }

      const unitPriceNum = effectiveUnitPriceEtb(tier);
      const subtotal = roundEtb(unitPriceNum * qty);
      const discountNum = promoRow ? computePromoDiscountEtb(subtotal, promoRow) : 0;
      const finalTotal = roundEtb(subtotal - discountNum);

      if (promoRow) {
        const [bumped] = await tx
          .update(promoCodes)
          .set({
            usesCount: sql`${promoCodes.usesCount} + 1`,
            updatedAt: new Date()
          })
          .where(
            and(
              eq(promoCodes.id, promoRow.id),
              eq(promoCodes.active, true),
              or(isNull(promoCodes.maxUses), lt(promoCodes.usesCount, promoCodes.maxUses))
            )
          )
          .returning({ id: promoCodes.id });
        if (!bumped) {
          throw new PromoApplyError("Promo code is no longer available.", 409);
        }
      }

      const orderRef = buildOrderRef();
      const [orderRow] = await tx
        .insert(orders)
        .values({
          eventId: payload.eventId,
          tierId: payload.tierId,
          orderRef,
          unitPriceEtb: unitPriceNum.toFixed(2),
          expectedAmount: finalTotal.toFixed(2),
          promoCodeId: promoRow?.id,
          promoDiscountEtb: discountNum.toFixed(2),
          quantity: qty,
          payerPhone: payload.payerPhone,
          telegramUserId: payload.telegramUserId?.trim() || undefined
        })
        .returning();

      return {
        order: orderRow!,
        unitPriceNum,
        subtotal,
        discountNum,
        finalTotal,
        promoRow
      };
    });

    const { order: inserted, unitPriceNum, subtotal, discountNum, finalTotal } = checkout;
    const totalAmount = finalTotal.toFixed(2);
    const unitStr = unitPriceNum.toFixed(2);
    const telegramOpenBotUrl = buildTelegramUserBotOrderDeepLink(inserted.orderRef);

    const baseNote =
      discountNum > 0
        ? `Subtotal ${subtotal.toFixed(2)} ETB (${qty} × ${unitStr} ETB)${checkout.promoRow ? `, promo −${discountNum.toFixed(2)} ETB` : ""}. Pay exactly ${totalAmount} ETB total.`
        : null;

    res.status(201).json({
      order: inserted,
      paymentInstruction: {
        receiverNumber: config.telebirrReceiver,
        receiverName: config.telebirrReceiverName,
        exactAmount: totalAmount,
        unitPrice: unitStr,
        quantity: qty,
        subtotalEtb: subtotal.toFixed(2),
        ...(discountNum > 0 ? { promoDiscountEtb: discountNum.toFixed(2) } : {}),
        onePaymentForOrderTotal: true,
        note:
          qty > 1
            ? `Pay once: send exactly ${totalAmount} ETB in a single transfer (${qty} tickets × ${unitStr} ETB list price each${discountNum > 0 ? ", after promo" : ""}). Order reference: ${inserted.orderRef}. Submit one receipt showing this full amount — it covers all tickets.${baseNote ? ` ${baseNote}` : ""}`
            : `Pay once: send exactly ${totalAmount} ETB. Order reference: ${inserted.orderRef}.${baseNote ? ` ${baseNote}` : ""}`
      },
      telegramOpenBotUrl,
      telegramNextStepHint:
        telegramOpenBotUrl != null
          ? qty > 1
            ? "After one payment for the full total and submitting that receipt on the web, open this link and tap Start in Telegram — you receive one QR per ticket."
            : "After paying and submitting your receipt on the web, open this link and tap Start in Telegram to receive your ticket QR codes."
          : null
    });
  } catch (e) {
    if (e instanceof PromoApplyError) {
      res.status(e.statusCode).json({ error: e.message });
      return;
    }
    throw e;
  }
});

ordersRouter.post("/orders/:orderId/receipt", rateLimit(8, 10 * 60 * 1000), upload.single("screenshot"), async (req, res) => {
  const body = receiptBodySchema.parse(req.body);
  const orderId = String(req.params.orderId);
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId)
  });

  if (!order) {
    res.status(404).json({ error: "Order not found." });
    return;
  }

  const receiptTaken = await db.query.receiptSubmissions.findFirst({
    where: eq(receiptSubmissions.receiptNo, body.receiptNo)
  });
  if (receiptTaken) {
    res.status(409).json({
      error:
        "This Telebirr receipt was already used. Each receipt can only be submitted once — it cannot be reused for another order after a ticket was issued (or while another submission exists)."
    });
    return;
  }

  const result = await resolveReceiptVerification(
    {
      receiptNo: body.receiptNo,
      expectedAmount: Number(order.expectedAmount),
      receiverNumber: config.telebirrReceiver,
      receiverName: config.telebirrReceiverName
    },
    { skipExternalApi: body.verifierMode === "manual" }
  );

  const screenshotPath = req.file?.path ?? null;
  const screenshotHash = screenshotPath ? sha256(screenshotPath) : null;

  const insertedReceipt = await db
    .insert(receiptSubmissions)
    .values({
      orderId: order.id,
      receiptNo: body.receiptNo,
      receiptUrl: buildReceiptUrl(body.receiptNo),
      screenshotPath,
      screenshotHash,
      verificationStatus: "verifying",
      verificationNotes: result.notes
    })
    .returning();

  let receiptRow = insertedReceipt[0];
  await db.update(orders).set({ status: "verifying", updatedAt: new Date() }).where(eq(orders.id, order.id));

  let orderRow = (await db.query.orders.findFirst({ where: eq(orders.id, order.id) }))!;

  let issuedTickets: Awaited<ReturnType<typeof issueTicketsForApprovedOrder>>["tickets"] | null = null;
  let ticketDelivery: "none" | "pushed" | "failed" | "no_telegram" | "skipped_existing" = "none";

  if (result.ok) {
    const approved = await approveReceiptSubmission({
      receiptId: receiptRow.id,
      verifiedBy: "telebirr_verify_api",
      verificationNotes: result.notes,
      auditMetadata: { orderId: order.id, source: "telebirr_verify_api" }
    });
    logReceiptVerify("http_receipt_auto_approve", {
      orderId: order.id,
      orderRef: order.orderRef,
      receiptId: receiptRow.id,
      approveOk: approved.ok,
      ...(!approved.ok && "error" in approved ? { approveError: approved.error } : {})
    });
    if (approved.ok) {
      receiptRow = approved.receipt;
      orderRow = approved.order;

      const tgFromBody = body.telegramUserId?.trim();
      if (tgFromBody) {
        await db
          .update(orders)
          .set({ telegramUserId: tgFromBody, updatedAt: new Date() })
          .where(eq(orders.id, order.id));
      }

      const orderForTicket = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
      const linkedTg = orderForTicket?.telegramUserId?.trim();

      if (linkedTg) {
        const prevCount = (
          await db.query.tickets.findMany({
            where: eq(tickets.orderId, order.id)
          })
        ).length;
        const username = body.telegramUsername?.trim().replace(/^@/, "") || undefined;
        try {
          const issueResult = await issueTicketsForApprovedOrder(orderRow.orderRef, linkedTg, {
            telegramUsername: username
          });
          issuedTickets = issueResult.tickets;
          const fresh = issueResult.newlyIssued;
          if (fresh.length > 0) {
            let anyFail = false;
            const qty = Math.max(1, orderRow.quantity);
            for (let i = 0; i < fresh.length; i++) {
              const t = fresh[i]!;
              const push = await pushTicketQrToTelegramUser({
                telegramUserId: linkedTg,
                orderRef: orderRow.orderRef,
                qrImageDataUrl: t.qrImageDataUrl,
                caption:
                  qty > 1
                    ? `Ticket ${prevCount + i + 1}/${qty} for order ${orderRow.orderRef}. Each QR is valid once.`
                    : undefined
              });
              if (!push.ok) {
                anyFail = true;
              }
              logReceiptVerify("http_receipt_ticket_notify", {
                orderRef: orderRow.orderRef,
                ticketId: t.id,
                pushOk: push.ok,
                ...(!push.ok ? { pushError: push.error } : {})
              });
            }
            ticketDelivery = anyFail ? "failed" : "pushed";
          } else {
            ticketDelivery = "skipped_existing";
          }
        } catch (err) {
          ticketDelivery = "failed";
          logReceiptVerify("http_receipt_ticket_issue_fail", {
            orderRef: orderRow.orderRef,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      } else {
        ticketDelivery = "no_telegram";
        logReceiptVerify("http_receipt_no_telegram_for_ticket", {
          orderRef: orderRow.orderRef,
          orderId: order.id
        });
      }

      orderRow = (await db.query.orders.findFirst({ where: eq(orders.id, order.id) }))!;
    }
  } else {
    logReceiptVerify("http_receipt_queue_manual", {
      orderId: order.id,
      orderRef: order.orderRef,
      ok: result.ok,
      notes: result.notes.slice(0, 300)
    });
  }

  const telegramOpenBotUrl = buildTelegramUserBotOrderDeepLink(orderRow.orderRef);

  const needTicketRecovery =
    ticketDelivery === "failed" ||
    ticketDelivery === "no_telegram" ||
    ticketDelivery === "skipped_existing";

  res.status(201).json({
    receiptSubmission: receiptRow,
    order: orderRow,
    verification: result,
    telegramOpenBotUrl,
    telegramNextStepHint:
      telegramOpenBotUrl != null
        ? "Open Telegram with this link and tap Start — your order ref is sent with /start so the bot can link your chat and issue your ticket QR codes."
        : null,
    ...(ticketDelivery !== "none" ? { ticketDelivery } : {}),
    ...(needTicketRecovery
      ? {
          ticketRecovery: {
            claimInUserBot: `/claim ${orderRow.orderRef}`,
            organizerAdminCommand: `/resendtickets ${orderRow.orderRef}`,
            summary:
              ticketDelivery === "skipped_existing"
                ? "Tickets are already created. In the Telegram user bot, run /claim with your order ref to receive the QR images (safe to repeat)."
                : ticketDelivery === "no_telegram"
                  ? "Link your Telegram account first (open the bot via the deep link if available), then run /claim with your order ref."
                  : "QR images could not be sent to Telegram automatically. In the user bot, run /claim with your order ref; if photos still do not arrive, ask an organizer to resend from the admin bot."
          }
        }
      : {}),
    ...(issuedTickets?.length
      ? {
          tickets: issuedTickets,
          ticket: issuedTickets[0]
        }
      : {})
  });
});

ordersRouter.get("/orders/:orderId/telegram-deep-link", async (req, res) => {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, String(req.params.orderId))
  });
  if (!order) {
    res.status(404).json({ error: "Order not found." });
    return;
  }
  const telegramOpenBotUrl = buildTelegramUserBotOrderDeepLink(order.orderRef);
  res.json({
    orderRef: order.orderRef,
    telegramOpenBotUrl,
    telegramNextStepHint:
      telegramOpenBotUrl != null
        ? "Open in Telegram and tap Start to link this order to your account."
        : null
  });
});
