import crypto from "node:crypto";

export function buildOrderRef(): string {
  return `ORD-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
}

export function buildReceiptUrl(receiptNo: string): string {
  return `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(receiptNo)}`;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
