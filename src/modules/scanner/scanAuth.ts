import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config";

export type ScanAuth =
  | { kind: "api_key" }
  | { kind: "scanner_user"; userId: string; username: string };

declare module "express-serve-static-core" {
  interface Request {
    scanAuth?: ScanAuth;
  }
}

/**
 * Accepts either `x-scanner-api-key` (legacy) or `Authorization: Bearer` with
 * a scanner session JWT from `POST /scanner/auth/login`.
 */
export function requireScanAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-scanner-api-key"];
  if (apiKey === config.scannerApiKey) {
    req.scanAuth = { kind: "api_key" };
    return next();
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
        };
        if (payload.typ === "scanner" && payload.sub && payload.username) {
          req.scanAuth = {
            kind: "scanner_user",
            userId: payload.sub,
            username: payload.username
          };
          return next();
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
