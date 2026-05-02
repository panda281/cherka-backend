import { config } from "../../config";
import { logReceiptVerify } from "../receipts/verifyLogging";

/**
 * Push a ticket QR image to a Telegram user via the user bot (direct Bot API).
 * Used when HTTP/API flow issues a ticket — avoids coupling to Telegraf runtime.
 */
export async function pushTicketQrToTelegramUser(params: {
  telegramUserId: string;
  orderRef: string;
  qrImageDataUrl: string;
  caption?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = config.telegramUserBotToken?.trim();
  if (!token) {
    return { ok: false, error: "TELEGRAM_USER_BOT_TOKEN not configured" };
  }
  const chatId = params.telegramUserId.trim();
  if (!chatId) {
    return { ok: false, error: "empty chat id" };
  }
  const b64 = params.qrImageDataUrl.includes(",") ? params.qrImageDataUrl.split(",")[1] : params.qrImageDataUrl;
  if (!b64) {
    return { ok: false, error: "invalid qr image data" };
  }
  const buf = Buffer.from(b64, "base64");
  const caption =
    params.caption ?? `Ticket for order ${params.orderRef}. This QR can be used once.`;

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("photo", new Blob([buf], { type: "image/png" }), "ticket.png");

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000)
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (!json.ok) {
      logReceiptVerify("ticket_push_fail", {
        orderRef: params.orderRef,
        chatId,
        description: json.description
      });
      return { ok: false, error: json.description ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logReceiptVerify("ticket_push_exception", { orderRef: params.orderRef, error: msg });
    return { ok: false, error: msg };
  }
}
