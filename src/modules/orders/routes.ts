import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { eventTiers, orders, receiptSubmissions } from "../../db/schema";
import { config } from "../../config";
import { buildOrderRef, buildReceiptUrl, sha256 } from "../../utils";
import { getVerifier } from "../receipts/verifier";
import { rateLimit } from "../../middleware/rateLimit";

const uploadDir = path.resolve("uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

const createOrderSchema = z.object({
  eventId: z.string().uuid(),
  tierId: z.string().uuid(),
  payerPhone: z.string().optional()
});

const receiptBodySchema = z.object({
  receiptNo: z.string().min(6),
  verifierMode: z.enum(["manual", "parser"]).optional()
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
      payerPhone: payload.payerPhone
    })
    .returning();

  res.status(201).json({
    order: inserted[0],
    paymentInstruction: {
      receiverNumber: config.telebirrReceiver,
      receiverName: config.telebirrReceiverName,
      exactAmount: tier.price,
      note: `Use order reference ${inserted[0].orderRef}`
    }
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

  const verifier = getVerifier(body.verifierMode ?? "manual");
  const result = await verifier.verify({
    receiptNo: body.receiptNo,
    expectedAmount: Number(order.expectedAmount),
    receiverNumber: config.telebirrReceiver,
    receiverName: config.telebirrReceiverName
  });

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

  const updatedOrder = await db
    .update(orders)
    .set({ status: "verifying", updatedAt: new Date() })
    .where(eq(orders.id, order.id))
    .returning();

  res.status(201).json({
    receiptSubmission: insertedReceipt[0],
    order: updatedOrder[0],
    verification: result
  });
});
