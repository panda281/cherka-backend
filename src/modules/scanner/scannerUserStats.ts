import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { checkins } from "../../db/schema";

export type ScannerScanStats = {
  valid: number;
  alreadyUsed: number;
  invalid: number;
  total: number;
};

export async function getScannerUserScanStats(scannerUserId: string): Promise<ScannerScanStats> {
  const rows = await db
    .select({
      result: checkins.result,
      c: sql<number>`count(*)::int`
    })
    .from(checkins)
    .where(eq(checkins.scannerUserId, scannerUserId))
    .groupBy(checkins.result);

  const out: ScannerScanStats = { valid: 0, alreadyUsed: 0, invalid: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.c);
    out.total += n;
    if (row.result === "valid") out.valid = n;
    else if (row.result === "already_used") out.alreadyUsed = n;
    else if (row.result === "invalid") out.invalid = n;
  }
  return out;
}
