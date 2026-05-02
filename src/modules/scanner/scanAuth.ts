import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db/client";
import { scannerUsers } from "../../db/schema";

export type ScannerRole = "gate" | "finance" | "organizer_admin";

const ROLE_RANK: Record<ScannerRole, number> = {
  gate: 1,
  finance: 2,
  organizer_admin: 3
};

export type ScanAuth =
  | { kind: "api_key" }
  | { kind: "scanner_user"; userId: string; username: string; role: ScannerRole };

export function effectiveScannerRole(auth: ScanAuth): ScannerRole {
  if (auth.kind === "api_key") {
    return "organizer_admin";
  }
  return auth.role;
}

export function requireStaffRole(minRole: ScannerRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.scanAuth;
    if (!auth) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    const effective = effectiveScannerRole(auth);
    if (ROLE_RANK[effective] < ROLE_RANK[minRole]) {
      res.status(403).json({ error: `This action requires staff role “${minRole}” or higher.` });
      return;
    }
    next();
  };
}

declare module "express-serve-static-core" {
  interface Request {
    scanAuth?: ScanAuth;
  }
}

/**
 * Accepts either `x-scanner-api-key` (legacy) or `Authorization: Bearer` with
 * a scanner session JWT from `POST /scanner/auth/login`.
 */
export async function requireScanAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-scanner-api-key"];
  if (apiKey === config.scannerApiKey) {
    req.scanAuth = { kind: "api_key" };
    next();
    return;
  }

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) {
      try {
        const payload = jwt.verify(token, config.jwtSecret) as {
          typ?: string;
          sub?: string;
          username?: string;
          role?: ScannerRole;
        };
        if (payload.typ === "scanner" && payload.sub && payload.username) {
          const row = await db.query.scannerUsers.findFirst({
            where: eq(scannerUsers.id, payload.sub),
            columns: { active: true }
          });
          if (!row?.active) {
            res.status(403).json({
              result: "invalid",
              reason: "Scanner account is disabled. Contact an organizer."
            });
            return;
          }
          const role: ScannerRole =
            payload.role === "gate" || payload.role === "finance" || payload.role === "organizer_admin"
              ? payload.role
              : "organizer_admin";
          req.scanAuth = {
            kind: "scanner_user",
            userId: payload.sub,
            username: payload.username,
            role
          };
          next();
          return;
        }
      } catch {
        /* fall through to 401 */
      }
    }
  }

  res.status(401).json({ result: "invalid", reason: "Authentication required. Log in or send x-scanner-api-key." });
}

export function formatScanActor(deviceId: string, auth: ScanAuth | undefined): string {
  if (auth?.kind === "scanner_user") {
    return `${auth.username}@${deviceId}`.slice(0, 100);
  }
  return deviceId.slice(0, 100);
}

export function formatAuditActor(deviceId: string, auth: ScanAuth | undefined): string {
  if (auth?.kind === "scanner_user") {
    return `scanner_user:${auth.username}`.slice(0, 120);
  }
  return `api_key:${deviceId}`.slice(0, 120);
}
