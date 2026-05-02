import express from "express";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { config } from "../../config";
import { auditLogs, checkins, tickets } from "../../db/schema";
import { formatAuditActor, formatScanActor, requireScanAuth } from "../scanner/scanAuth";
import { sendPostCheckinThankYouTelegram } from "../telegram/postScanThankYou";

const scanSchema = z.object({
  qrToken: z.string().min(10),
  scannerDeviceId: z.string().min(2).max(100)
});

type ScanGuestPayload = {
  holder: string;
  ticketType: string;
  eventName: string;
};

type ScanTransactionResult =
  | { result: "invalid"; message: string }
  | { result: "already_used"; guest: ScanGuestPayload | null; message: string }
  | {
      result: "valid";
      guest: ScanGuestPayload | null;
      message: string;
      /** Server-only: DM thank-you after response */
      notifyTelegramUserId?: string;
    };

async function loadGuestPayload(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ticketId: string
): Promise<{ guest: ScanGuestPayload; telegramUserId: string } | null> {
  const rows = await tx.execute(sql`
    SELECT t.telegram_username, t.telegram_user_id, et.tier_name, e.name AS event_name
    FROM tickets t
    INNER JOIN orders o ON o.id = t.order_id
    INNER JOIN event_tiers et ON et.id = o.tier_id
    INNER JOIN events e ON e.id = o.event_id
    WHERE t.id = ${ticketId}
  `);
  const r = rows.rows[0] as
    | {
        telegram_username: string | null;
        telegram_user_id: string;
        tier_name: string;
        event_name: string;
      }
    | undefined;
  if (!r) return null;
  const holder =
    r.telegram_username && r.telegram_username.trim().length > 0
      ? `@${r.telegram_username.trim().replace(/^@/, "")}`
      : "Guest";
  return {
    guest: {
      holder,
      ticketType: r.tier_name,
      eventName: r.event_name
    },
    telegramUserId: String(r.telegram_user_id).trim()
  };
}

export const checkinRouter = express.Router();

checkinRouter.post("/checkin/scan", requireScanAuth, async (req, res) => {
  const body = scanSchema.parse(req.body);
  const scanActor = formatScanActor(body.scannerDeviceId, req.scanAuth);
  const auditActor = formatAuditActor(body.scannerDeviceId, req.scanAuth);
  let decoded: { jti: string } | null = null;
  try {
    decoded = jwt.verify(body.qrToken, config.jwtSecret) as { jti: string };
  } catch {
    await db.insert(checkins).values({
      scannerDeviceId: scanActor,
      result: "invalid",
      details: "Invalid ticket signature."
    });
    res.status(422).json({
      result: "invalid",
      message: "This QR code is not valid or has expired. Ask the guest to open their ticket again."
    });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    const row = await tx.execute(sql`
      SELECT id, status, used_at, used_by_gate
      FROM tickets
      WHERE token_jti = ${decoded!.jti}
      FOR UPDATE
    `);

    const ticket = row.rows[0] as
      | { id: string; status: "unused" | "used" | "void"; used_at: Date | null; used_by_gate: string | null }
      | undefined;

    if (!ticket) {
      return {
        result: "invalid" as const,
        message: "We could not find this ticket. It may be for another event."
      };
    }

    const enriched = await loadGuestPayload(tx, ticket.id);
    const guest = enriched?.guest ?? null;

    if (ticket.status !== "unused") {
      await tx.insert(checkins).values({
        ticketId: ticket.id,
        scannerDeviceId: scanActor,
        result: "already_used",
        details: `Ticket first used at ${ticket.used_at?.toISOString() ?? "unknown"} by ${ticket.used_by_gate ?? "unknown"}.`
      });
      return {
        result: "already_used" as const,
        guest,
        message: "This ticket was already scanned. Entry is not allowed again."
      };
    }

    await tx
      .update(tickets)
      .set({ status: "used", usedAt: new Date(), usedByGate: scanActor, updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    await tx.insert(checkins).values({
      ticketId: ticket.id,
      scannerDeviceId: scanActor,
      result: "valid",
      details: "First successful scan."
    });
    await tx.insert(auditLogs).values({
      action: "ticket_scanned",
      actor: auditActor,
      entityType: "ticket",
      entityId: ticket.id,
      metadata: JSON.stringify({ result: "valid", scannerDeviceId: body.scannerDeviceId })
    });

    const result: ScanTransactionResult = {
      result: "valid",
      guest,
      message: "Valid ticket. You may enter."
    };
    if (enriched?.telegramUserId) {
      (result as Extract<ScanTransactionResult, { result: "valid" }>).notifyTelegramUserId =
        enriched.telegramUserId;
    }
    return result;
  });

  if (outcome.result === "valid" && outcome.notifyTelegramUserId) {
    sendPostCheckinThankYouTelegram(outcome.notifyTelegramUserId);
  }

  const publicBody =
    outcome.result === "valid"
      ? { result: outcome.result, guest: outcome.guest, message: outcome.message }
      : outcome;
  res.json(publicBody);
});
