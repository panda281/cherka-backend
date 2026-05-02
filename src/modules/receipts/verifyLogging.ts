/** Structured logs for Telebirr / receipt verification (grep: `[receipt-verify]`). */

export function logReceiptVerify(event: string, fields: Record<string, unknown>): void {
  const payload = { ts: new Date().toISOString(), event, ...fields };
  console.info("[receipt-verify]", JSON.stringify(payload));
}
