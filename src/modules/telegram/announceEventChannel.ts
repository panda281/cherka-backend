import { and, eq } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db/client";
import { eventTiers, events } from "../../db/schema";
import { logReceiptVerify } from "../receipts/verifyLogging";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Public deep link: opens user bot with this event pre-selected for /buy-style flow. */
export function buildTelegramBuyEventDeepLink(eventId: string): string | null {
  const u = config.telegramUserBotUsername.trim().replace(/^@/, "");
  if (!u) return null;
  return `https://t.me/${u}?start=${encodeURIComponent(`buy_${eventId}`)}`;
}

function formatChannelCaption(
  event: typeof events.$inferSelect,
  tiers: { tierName: string; tierCode: string; price: string }[]
): string {
  const start = event.startsAt.toISOString().replace("T", " ").slice(0, 16);
  const end = event.endsAt.toISOString().replace("T", " ").slice(0, 16);
  const loc = event.location?.trim() ? escapeHtml(event.location) : "—";
  const tierLines =
    tiers.length === 0
      ? "No tiers yet."
      : tiers
          .map((t) => `• ${escapeHtml(t.tierName)} (${escapeHtml(t.tierCode)}) · ETB ${escapeHtml(String(t.price))}`)
          .join("\n");
  const buy = buildTelegramBuyEventDeepLink(event.id);
  const web = config.publicBaseUrl.trim();
  let footer = "";
  if (buy) {
    footer += `\n\n<a href="${escapeHtml(buy)}">Buy on Telegram</a>`;
  }
  if (web) {
    const base = web.replace(/\/$/, "");
    footer += `\nWeb: <a href="${escapeHtml(base)}">${escapeHtml(base)}</a>`;
  }
  footer += `\n\nEvent ID: <code>${escapeHtml(event.id)}</code>`;

  return (
    `<b>${escapeHtml(event.name)}</b>\n` +
    `📍 ${loc}\n` +
    `📅 ${escapeHtml(`${start} – ${end}`)}\n` +
    `📂 ${escapeHtml(event.category)}\n\n` +
    `<b>Tiers</b>\n${tierLines}` +
    footer
  );
}

export async function announcePublishedEventToChannel(
  eventId: string
): Promise<{ ok: true; messageId?: number } | { ok: false; error: string }> {
  const chatId = config.telegramEventsChannelChatId.trim();
  const token = config.telegramUserBotToken?.trim();
  if (!chatId || !token) {
    return { ok: false, error: "skipped_no_config" };
  }

  const eventItem = await db.query.events.findFirst({ where: eq(events.id, eventId) });
  if (!eventItem || eventItem.status !== "published") {
    return { ok: false, error: "not_published" };
  }

  const tiers = await db.query.eventTiers.findMany({
    where: and(eq(eventTiers.eventId, eventId), eq(eventTiers.active, true)),
    orderBy: [eventTiers.tierName]
  });

  const caption = formatChannelCaption(eventItem, tiers);
  const imageUrl = eventItem.eventImageUrl?.trim();

  async function sendText(text: string): Promise<{ ok: true; messageId?: number } | { ok: false; error: string }> {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false
      }),
      signal: AbortSignal.timeout(20000)
    });
    const json = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id: number } };
    if (!json.ok) {
      return { ok: false, error: json.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, messageId: json.result?.message_id };
  }

  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    const cap = caption.slice(0, 1024);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: imageUrl,
        caption: cap,
        parse_mode: "HTML"
      }),
      signal: AbortSignal.timeout(25000)
    });
    const json = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id: number } };
    if (json.ok) {
      logReceiptVerify("channel_event_announce_ok", { eventId, withImage: true });
      return { ok: true, messageId: json.result?.message_id };
    }
    logReceiptVerify("channel_event_announce_photo_fallback", {
      eventId,
      description: json.description ?? undefined
    });
  }

  const out = await sendText(`🎫 <b>New event</b>\n\n${caption}`);
  if (out.ok) {
    logReceiptVerify("channel_event_announce_ok", { eventId, withImage: false });
  }
  return out;
}

/** Fire-and-forget when an event transitions to <code>published</code>. */
export function scheduleChannelAnnounceWhenNewlyPublished(
  eventId: string,
  previousStatus: string | null | undefined
): void {
  if (previousStatus === "published") {
    return;
  }
  void announcePublishedEventToChannel(eventId).then((r) => {
    if (!r.ok && r.error !== "skipped_no_config" && r.error !== "not_published") {
      logReceiptVerify("channel_event_announce_fail", { eventId, error: r.error });
    }
  });
}
