import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  telebirrReceiver: required("TELEBIRR_RECEIVER"),
  telebirrReceiverName: required("TELEBIRR_RECEIVER_NAME"),
  jwtSecret: required("JWT_SECRET"),
  telegramAdminBotToken: process.env.TELEGRAM_ADMIN_BOT_TOKEN ?? "",
  telegramUserBotToken: process.env.TELEGRAM_USER_BOT_TOKEN ?? "",
  /** Public @username of the user ticket bot (no @). Used for `t.me/...?start=ORDER_REF` after web checkout. */
  telegramUserBotUsername: (process.env.TELEGRAM_USER_BOT_USERNAME ?? "").trim().replace(/^@/, ""),
  telegramAdminWebhookSecret: required("TELEGRAM_ADMIN_WEBHOOK_SECRET"),
  telegramUserWebhookSecret: required("TELEGRAM_USER_WEBHOOK_SECRET"),
  telegramSetupSecret: required("TELEGRAM_SETUP_SECRET"),
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  scannerApiKey: required("SCANNER_API_KEY"),
  /** Full POST URL, e.g. http://host:8001/api/verify/verify-telebirr/ — when set, receipt submission runs this unless verifierMode=manual */
  /** POST JSON `{ "receipt_no": "..." }` — full URL including path, no spaces (e.g. …8001/api/verify/verify-telebirr/). */
  receiptVerifyTelebirrUrl: (process.env.RECEIPT_VERIFY_TELEBIRR_URL ?? "")
    .trim()
    .replace(/\s+/g, ""),
  receiptVerifyTimeoutMs: Number(process.env.RECEIPT_VERIFY_TIMEOUT_MS ?? 15000),
  /** If true, auto-approve only checks amount (not `credited_party_name`). Less safe — demo only. */
  receiptVerifySkipReceiverCheck: process.env.RECEIPT_VERIFY_SKIP_RECEIVER_CHECK === "true",
  /** Scanner web login JWT lifetime (same secret as tickets but different payload shape) */
  scannerSessionDays: Number(process.env.SCANNER_SESSION_DAYS ?? "3"),
  /** t.me/+… or https://t.me/… — sent in a DM after successful check-in (requires TELEGRAM_USER_BOT_TOKEN) */
  ticketrCommunityChannelUrl: (process.env.TICKETR_COMMUNITY_CHANNEL_URL ?? "").trim()
};
