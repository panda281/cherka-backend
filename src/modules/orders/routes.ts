import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { eventTiers, orders, receiptSubmissions, tickets } from "../../db/schema";
import { config } from "../../config";
import { buildOrderRef, buildReceiptUrl, buildTelegramUserBotOrderDeepLink, sha256 } from "../../utils";
import { approveReceiptSubmission } from "../receipts/approveSubmission";
import { logReceiptVerify } from "../receipts/verifyLogging";
import { resolveReceiptVerification } from "../receipts/verifier";
import { pushTicketQrToTelegramUser } from "../telegram/pushTicketPhoto";
import { issueTicketForApprovedOrder } from "../tickets/service";
import { rateLimit } from "../../middleware/rateLimit";

const uploadDir = path.resolve("uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

const createOrderSchema = z.object({
  eventId: z.string().uuid(),
  tierId: z.string().uuid(),
  payerPhone: z.string().optional(),
  telegramUserId: z.string().min(1).optional()
});

const receiptBodySchema = z.object({
  receiptNo: z.string().min(6),
  verifierMode: z.enum(["manual", "parser"]).optional(),
  /** Telegram numeric user id — link buyer so a ticket row is created and /myticket works */
  telegramUserId: z.string().min(1).optional(),
  telegramUsername: z.string().optional()
});

export const ordersRouter = express.Router();

ordersRouter.post("/orders", async (req, res) => {
  const payload = createOrderSchema.parse(req.body);
  const tier = await db.query.eventTiers.findFirst({
    where: and(eq(eventTiers.id, payload.tierId), eq(eventTiers.eventId, payload.eventId), eq(eventTiers.active, true))
  });

  if (!tier) {
    res.status(404).json({ error: "Active tier not found for event." });
    return;
  }

  const inserted = await db
    .insert(orders)
    .values({
      eventId: payload.eventId,
      tierId: payload.tierId,
      orderRef: buildOrderRef(),
      expectedAmount: String(tier.price),
      payerPhone: payload.payerPhone,
      telegramUserId: payload.telegramUserId?.trim() || undefined
    })
    .returning();

  const telegramOpenBotUrl = buildTelegramUserBotOrderDeepLink(inserted[0].orderRef);

  res.status(201).json({
    order: inserted[0],
    paymentInstruction: {
      receiverNumber: config.telebirrReceiver,
      receiverName: config.telebirrReceiverName,
      exactAmount: tier.price,
      note: `Use order reference ${inserted[0].orderRef}`
    },
    telegramOpenBotUrl,
    telegramNextStepHint:
      telegramOpenBotUrl != null
        ? "After paying and submitting your receipt on the web, open this link and tap Start in Telegram to receive your ticket."
        : null
  });
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

  let ticketRow: Awaited<ReturnType<typeof issueTicketForApprovedOrder>> | null = null;
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
        const hadTicket = await db.query.tickets.findFirst({ where: eq(tickets.orderId, order.id) });
        const username = body.telegramUsername?.trim().replace(/^@/, "") || undefined;
        try {
          ticketRow = await issueTicketForApprovedOrder(orderRow.orderRef, linkedTg, {
            telegramUsername: username
          });
          if (!hadTicket) {
            const push = await pushTicketQrToTelegramUser({
              telegramUserId: linkedTg,
              orderRef: orderRow.orderRef,
              qrImageDataUrl: ticketRow.qrImageDataUrl
            });
            if (push.ok) {
              ticketDelivery = "pushed";
            } else {
              ticketDelivery = "failed";
            }
            logReceiptVerify("http_receipt_ticket_notify", {
              orderRef: orderRow.orderRef,
              ticketId: ticketRow.id,
              pushOk: push.ok,
              ...(!push.ok ? { pushError: push.error } : {})
            });
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

  res.status(201).json({
    receiptSubmission: receiptRow,
    order: orderRow,
    verification: result,
    telegramOpenBotUrl,
    telegramNextStepHint:
      telegramOpenBotUrl != null
        ? "Open Telegram with this link and tap Start — your order ref is sent with /start so the bot can link your chat and issue the ticket."
        : null,
    ...(ticketDelivery !== "none" ? { ticketDelivery } : {}),
    ...(ticketRow ? { ticket: ticketRow } : {})
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
