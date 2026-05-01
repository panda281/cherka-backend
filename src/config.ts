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
  telegramAdminWebhookSecret: required("TELEGRAM_ADMIN_WEBHOOK_SECRET"),
  telegramUserWebhookSecret: required("TELEGRAM_USER_WEBHOOK_SECRET"),
  telegramSetupSecret: required("TELEGRAM_SETUP_SECRET"),
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  scannerApiKey: required("SCANNER_API_KEY")
};
