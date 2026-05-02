import { config } from "../../config";

/**
 * After a successful gate scan, DM the guest on the user bot (same bot they used for tickets).
 * Fire-and-forget — does not block the HTTP response.
 */
export function sendPostCheckinThankYouTelegram(telegramUserId: string): void {
  const token = config.telegramUserBotToken.trim();
  const channelUrl = config.ticketrCommunityChannelUrl.trim();
  if (!token || !channelUrl || !telegramUserId.trim()) {
    return;
  }

  const text = [
    "Thank you for choosing Ticketr.",
    "",
    "Please join our channel — we post new events and pictures from previous events:",
    channelUrl
  ].join("\n");

  void fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramUserId.trim(),
      text,
      disable_web_page_preview: false
    }),
    signal: AbortSignal.timeout(12_000)
  }).catch((err) => {
    console.error("[post-checkin-thank-you]", err instanceof Error ? err.message : err);
  });
}
