import { db } from "../../db/client";
import { auditLogs } from "../../db/schema";

export type ScannerStaffAuditAction =
  | "scanner_user_created"
  | "scanner_user_disabled"
  | "scanner_user_enabled"
  | "scanner_user_role_changed";

export async function auditScannerUserAdmin(params: {
  action: ScannerStaffAuditAction;
  scannerUserId: string;
  actorLabel: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogs).values({
    action: params.action,
    actor: params.actorLabel.slice(0, 120),
    entityType: "scanner_user",
    entityId: params.scannerUserId,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null
  });
}
