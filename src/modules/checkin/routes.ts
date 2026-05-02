import express from "express";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { config } from "../../config";
import { auditLogs, checkins, tickets } from "../../db/schema";
import { formatAuditActor, formatScanActor, requireScanAuth } from "../scanner/scanAuth";

const scanSchema = z.object({
  qrToken: z.string().min(10),
  scannerDeviceId: z.string().min(2).max(100)
});

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
    res.status(422).json({ result: "invalid", reason: "Invalid or expired ticket." });
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
      return { result: "invalid" as const, reason: "Ticket not found." };
    }

    if (ticket.status !== "unused") {
      await tx.insert(checkins).values({
        ticketId: ticket.id,
        scannerDeviceId: scanActor,
        result: "already_used",
        details: `Ticket first used at ${ticket.used_at?.toISOString() ?? "unknown"} by ${ticket.used_by_gate ?? "unknown"}.`
      });
      return {
        result: "already_used" as const,
        usedAt: ticket.used_at,
        usedByGate: ticket.used_by_gate
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

    return { result: "valid" as const };
  });

  res.json(outcome);
});
