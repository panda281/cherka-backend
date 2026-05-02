import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { config } from "../../config";
import { auditLogs, scannerUsers } from "../../db/schema";
import type { ScannerRole } from "./scanAuth";
import { requireScanAuth, requireStaffRole } from "./scanAuth";
import { auditScannerUserAdmin } from "./scannerStaffAudit";
import { getScannerUserScanStats } from "./scannerUserStats";

function routeParamId(value: string | string[] | undefined): string {
  if (value == null) return "";
  return Array.isArray(value) ? String(value[0] ?? "") : String(value);
}

function httpAdminActor(req: express.Request): string {
  const a = req.scanAuth;
  if (!a) return "unknown";
  if (a.kind === "api_key") return "api_key:admin";
  return `scanner_user:${a.username}`;
}

const loginSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(1).max(200)
});

const createScannerUserSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(8).max(200),
  role: z.enum(["gate", "finance", "organizer_admin"]).optional()
});

const patchScannerUserSchema = z
  .object({
    active: z.boolean().optional(),
    role: z.enum(["gate", "finance", "organizer_admin"]).optional()
  })
  .refine((b) => b.active !== undefined || b.role !== undefined, {
    message: "Provide active and/or role."
  });

export const scannerAuthRouter = express.Router();

scannerAuthRouter.post(
  "/admin/scanner-users",
  requireScanAuth,
  requireStaffRole("organizer_admin"),
  async (req, res) => {
    const body = createScannerUserSchema.parse(req.body);
    const username = body.username.trim().toLowerCase();
    const role: ScannerRole = body.role ?? "organizer_admin";
    const passwordHash = await bcrypt.hash(body.password, 12);
    try {
      const [row] = await db
        .insert(scannerUsers)
        .values({ username, passwordHash, role, active: true })
        .returning({
          id: scannerUsers.id,
          username: scannerUsers.username,
          role: scannerUsers.role,
          active: scannerUsers.active,
          createdAt: scannerUsers.createdAt
        });
      await auditScannerUserAdmin({
        action: "scanner_user_created",
        scannerUserId: row.id,
        actorLabel: httpAdminActor(req),
        metadata: { username: row.username, role: row.role, channel: "http" }
      });
      res.status(201).json(row);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        res.status(409).json({ error: "A scanner user with this username already exists." });
        return;
      }
      throw e;
    }
  }
);

scannerAuthRouter.get(
  "/admin/scanner-users",
  requireScanAuth,
  requireStaffRole("organizer_admin"),
  async (_req, res) => {
    const rows = await db.query.scannerUsers.findMany({
      columns: { id: true, username: true, role: true, active: true, createdAt: true },
      orderBy: [asc(scannerUsers.username)]
    });
    const rowsWithScans = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        scans: await getScannerUserScanStats(r.id)
      }))
    );
    res.json({ rows: rowsWithScans });
  }
);

scannerAuthRouter.get(
  "/admin/scanner-users/:userId",
  requireScanAuth,
  requireStaffRole("organizer_admin"),
  async (req, res) => {
    const userId = routeParamId(req.params.userId);
    const user = await db.query.scannerUsers.findFirst({
      where: eq(scannerUsers.id, userId),
      columns: {
        id: true,
        username: true,
        role: true,
        active: true,
        createdAt: true,
        updatedAt: true
      }
    });
    if (!user) {
      res.status(404).json({ error: "Scanner user not found." });
      return;
    }
    const scans = await getScannerUserScanStats(userId);
    const recentAudit = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.entityType, "scanner_user"), eq(auditLogs.entityId, userId)),
      orderBy: [desc(auditLogs.createdAt)],
      limit: 30
    });
    res.json({ user, scans, recentAudit });
  }
);

scannerAuthRouter.patch(
  "/admin/scanner-users/:userId",
  requireScanAuth,
  requireStaffRole("organizer_admin"),
  async (req, res) => {
    const userId = routeParamId(req.params.userId);
    const body = patchScannerUserSchema.parse(req.body);
    const existing = await db.query.scannerUsers.findFirst({
      where: eq(scannerUsers.id, userId)
    });
    if (!existing) {
      res.status(404).json({ error: "Scanner user not found." });
      return;
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.active !== undefined) patch.active = body.active;
    if (body.role !== undefined) patch.role = body.role;
    const [updated] = await db.update(scannerUsers).set(patch).where(eq(scannerUsers.id, userId)).returning({
      id: scannerUsers.id,
      username: scannerUsers.username,
      role: scannerUsers.role,
      active: scannerUsers.active,
      createdAt: scannerUsers.createdAt,
      updatedAt: scannerUsers.updatedAt
    });
    const actor = httpAdminActor(req);
    if (body.active === true && existing.active === false) {
      await auditScannerUserAdmin({
        action: "scanner_user_enabled",
        scannerUserId: userId,
        actorLabel: actor,
        metadata: { username: existing.username }
      });
    } else if (body.active === false && existing.active === true) {
      await auditScannerUserAdmin({
        action: "scanner_user_disabled",
        scannerUserId: userId,
        actorLabel: actor,
        metadata: { username: existing.username }
      });
    }
    if (body.role !== undefined && body.role !== existing.role) {
      await auditScannerUserAdmin({
        action: "scanner_user_role_changed",
        scannerUserId: userId,
        actorLabel: actor,
        metadata: { username: existing.username, from: existing.role, to: body.role }
      });
    }
    res.json(updated);
  }
);

scannerAuthRouter.post("/scanner/auth/login", async (req, res) => {
  const body = loginSchema.parse(req.body);
  const username = body.username.trim().toLowerCase();

  const user = await db.query.scannerUsers.findFirst({
    where: eq(scannerUsers.username, username)
  });

  const ok = user ? await bcrypt.compare(body.password, user.passwordHash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  if (!user.active) {
    res.status(403).json({ error: "This scanner account is disabled. Contact an organizer." });
    return;
  }

  const expiresInSec = Math.floor(config.scannerSessionDays * 24 * 60 * 60);
  const role: ScannerRole = user.role;
  const token = jwt.sign(
    { typ: "scanner", sub: user.id, username: user.username, role },
    config.jwtSecret,
    { expiresIn: `${config.scannerSessionDays}d` }
  );

  res.json({
    token,
    expiresIn: expiresInSec,
    username: user.username,
    role,
    active: user.active
  });
});

scannerAuthRouter.get("/scanner/auth/me", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token." });
    return;
  }
  const raw = auth.slice(7).trim();
  if (!raw) {
    res.status(401).json({ error: "Missing bearer token." });
    return;
  }
  try {
    const payload = jwt.verify(raw, config.jwtSecret) as {
      typ?: string;
      sub?: string;
      username?: string;
      role?: ScannerRole;
    };
    if (payload.typ !== "scanner" || !payload.sub) {
      res.status(401).json({ error: "Invalid session." });
      return;
    }
    const dbUser = await db.query.scannerUsers.findFirst({
      where: eq(scannerUsers.id, payload.sub),
      columns: { username: true, role: true, active: true }
    });
    if (dbUser?.active === false) {
      res.status(403).json({ error: "This scanner account is disabled. Contact an organizer." });
      return;
    }
    const role: ScannerRole =
      dbUser?.role ??
      (payload.role === "gate" || payload.role === "finance" || payload.role === "organizer_admin"
        ? payload.role
        : "organizer_admin");
    res.json({
      id: payload.sub,
      username: dbUser?.username ?? payload.username,
      role,
      active: dbUser?.active ?? true
    });
  } catch {
    res.status(401).json({ error: "Session expired or invalid." });
  }
});
