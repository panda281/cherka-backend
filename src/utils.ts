import crypto from "node:crypto";
import { config } from "./config";

export function buildOrderRef(): string {
  return `ORD-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
}

export function buildReceiptUrl(receiptNo: string): string {
  return `https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(receiptNo)}`;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * `https://t.me/<user_bot>?start=<orderRef>` — opens the user bot with payload so /start links chat id + order ref.
 * Returns null if `TELEGRAM_USER_BOT_USERNAME` is not set. Telegram limits `start` payload length (keep order refs ≤ 64 chars).
 */
export function buildTelegramUserBotOrderDeepLink(orderRef: string): string | null {
  const bot = config.telegramUserBotUsername;
  const ref = orderRef.trim();
  if (!bot || !ref) return null;
  if (ref.length > 64) return null;
  return `https://t.me/${bot}?start=${encodeURIComponent(ref)}`;
}
