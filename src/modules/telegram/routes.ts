import express from "express";
import bcrypt from "bcryptjs";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { config } from "../../config";
import { DEFAULT_EVENT_CATEGORY, EVENT_CATEGORIES, parseEventCategory } from "../../constants/eventCategories";
import { db } from "../../db/client";
import {
  auditLogs,
  eventTiers,
  events,
  orders,
  privacyAcceptances,
  promoCodes,
  receiptSubmissions,
  scannerUsers,
  tickets
} from "../../db/schema";
import type { ScannerRole } from "../scanner/scanAuth";
import { auditScannerUserAdmin } from "../scanner/scannerStaffAudit";
import { getScannerUserScanStats } from "../scanner/scannerUserStats";
import { effectiveUnitPriceEtb } from "../pricing/effectiveUnitPrice";
import { buildReceiptUrl } from "../../utils";
import { approveReceiptSubmission } from "../receipts/approveSubmission";
import { releaseReceiptSubmissionForResubmit } from "../receipts/releaseSubmission";
import { reverifyReceiptWithTelebirrApi } from "../receipts/reverifySubmission";
import { logReceiptVerify } from "../receipts/verifyLogging";
import { resolveReceiptVerification } from "../receipts/verifier";
import { issueTicketsForApprovedOrder } from "../tickets/service";
import { pushAllTicketQrsForOrder } from "./ticketPhotoDelivery";
import {
  announcePublishedEventToChannel,
  scheduleChannelAnnounceWhenNewlyPublished
} from "./announceEventChannel";
import { getEventTicketSalesReport } from "../events/salesReport";
import { createPromoBatch, deletePromoById, MAX_PROMOS_PER_REQUEST, updatePromoById } from "../promo/service";

export const telegramRouter = express.Router();

function incomingWebhookSecret(req: express.Request): string {
  const raw = req.headers["x-telegram-bot-api-secret-token"];
  if (raw == null) return "";
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" ? first.trim() : "";
}

let adminBot: Telegraf | null = null;
let userBot: Telegraf | null = null;

async function setWebhook(token: string, url: string, secret: string): Promise<{ ok: boolean; description?: string }> {
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: secret })
  });
  if (!response.ok) {
    return { ok: false, description: `HTTP ${response.status}` };
  }
  const body = (await response.json()) as { ok: boolean; description?: string };
  return body;
}

function getText(ctx: { message?: { text?: string } }): string {
  return ctx.message?.text ?? "";
}

function getArgs(text: string): string[] {
  return text.split(" ").slice(1).filter(Boolean);
}

/** Escape text for Telegram Bot API MarkdownV2 (outside pre/code). */
function escapeMarkdownV2(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/>/g, "\\>")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
}

/** Escape payload inside MarkdownV2 inline `code` (only \\ and \\`). */
function escapeMarkdownV2InlineCode(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

/** Telegram text messages cannot use real colors; emoji hints unused / used / void. */
function formatTicketStatusMarkdownV2(status: string): string {
  const emoji = status === "unused" ? "🟢" : status === "used" ? "🔵" : "🔴";
  return `${emoji} *"${escapeMarkdownV2(status)}"*`;
}

function formatBrowseEventBlock(
  eventItem: {
    id: string;
    name: string;
    location: string | null;
    startsAt: Date;
    endsAt: Date;
    category: string;
    featured: boolean;
  },
  tiersForEvent: {
    tierName: string;
    tierCode: string;
    price: string;
    earlyBirdPrice: string | null;
    earlyBirdEndsAt: Date | null;
  }[],
  at: Date = new Date()
): string {
  const title = eventItem.featured
    ? `✨ *${escapeMarkdownV2(eventItem.name)}*`
    : `*${escapeMarkdownV2(eventItem.name)}*`;
  const loc = escapeMarkdownV2(eventItem.location?.trim() ? eventItem.location : "-");
  const start = eventItem.startsAt.toISOString().replace("T", " ").slice(0, 16);
  const end = eventItem.endsAt.toISOString().replace("T", " ").slice(0, 16);
  const rangeCode = `\`${escapeMarkdownV2InlineCode(`${start} – ${end}`)}\``;
  const cat = escapeMarkdownV2(eventItem.category);
  const tierLines =
    tiersForEvent.length === 0
      ? escapeMarkdownV2("No tiers available.")
      : tiersForEvent
          .map((tier) => {
            const eff = effectiveUnitPriceEtb(tier, at);
            const reg = Number(tier.price);
            const code = `\`${escapeMarkdownV2InlineCode(tier.tierCode)}\``;
            const earlyOn =
              tier.earlyBirdEndsAt != null &&
              tier.earlyBirdPrice != null &&
              at.getTime() < tier.earlyBirdEndsAt.getTime() &&
              eff < reg - 1e-9;
            const priceStr = escapeMarkdownV2(eff.toFixed(2));
            const suffix =
              earlyOn && tier.earlyBirdEndsAt != null
                ? ` \\(${escapeMarkdownV2("early bird")} ${escapeMarkdownV2("until")} ${`\`${escapeMarkdownV2InlineCode(tier.earlyBirdEndsAt.toISOString().replace("T", " ").slice(0, 16))}\``}\\, ${escapeMarkdownV2("then")} ETB ${escapeMarkdownV2(reg.toFixed(2))}\\)`
                : "";
            return `• ${escapeMarkdownV2(tier.tierName)} \\(${code}\\) · ETB ${priceStr}${suffix}`;
          })
          .join("\n");
  const idCode = `\`${escapeMarkdownV2InlineCode(eventItem.id)}\``;
  return (
    `${title}\n` +
    `${escapeMarkdownV2("Event Location:")} ${loc}\n` +
    `${escapeMarkdownV2("Event Date:")} ${rangeCode}\n` +
    `${escapeMarkdownV2("Category:")} ${cat}\n` +
    `${escapeMarkdownV2("Tiers:")}\n${tierLines}\n` +
    `${escapeMarkdownV2("Event ID:")} ${idCode}`
  );
}

async function privacyAcceptedForUserBot(tgId: string): Promise<boolean> {
  const row = await db.query.privacyAcceptances.findFirst({
    where: eq(privacyAcceptances.telegramUserId, tgId)
  });
  return row != null && row.policyVersion === config.privacyPolicyVersion;
}

async function replyUserBotPrivacyGate(ctx: Context): Promise<void> {
  const lines = [
    "Before you browse events, pay, or link tickets to this bot, please confirm you understand what we store.",
    "",
    "We process: your Telegram user ID; order references; Telebirr receipt references and verification notes;",
    "ticket QR records and check-in events; and append-only sales ledger lines (amounts, tier, event snapshots).",
    "Retention follows operational and legal needs for the organizer; contact them for deletion requests where applicable.",
    ""
  ];
  if (config.privacyPolicyUrl) {
    lines.push(`Full policy: ${config.privacyPolicyUrl}`, "");
  }
  lines.push(`Policy version: ${config.privacyPolicyVersion}`, "", 'Tap “I accept” to continue.');
  await ctx.reply(
    lines.join("\n"),
    Markup.inlineKeyboard([[Markup.button.callback("I accept", telegramCallbackData("p_ok"))]])
  );
}

async function replyPublishedEventsBrowse(ctx: Context): Promise<void> {
  const uid = ctx.from?.id;
  if (uid == null) {
    await ctx.reply("Could not resolve your Telegram account.");
    return;
  }
  if (!(await privacyAcceptedForUserBot(String(uid)))) {
    await replyUserBotPrivacyGate(ctx);
    return;
  }
  const activeEvents = await db.query.events.findMany({
    where: inArray(events.status, ["published"]),
    orderBy: [desc(events.featured), desc(events.startsAt)]
  });
  if (!activeEvents.length) {
    await ctx.reply("No published events found.");
    return;
  }
  const eventIds = activeEvents.map((e) => e.id);
  const tierRows = await db.query.eventTiers.findMany({
    where: and(inArray(eventTiers.eventId, eventIds), eq(eventTiers.active, true)),
    orderBy: [eventTiers.tierName]
  });
  const blocks = activeEvents.map((eventItem) => {
    const tiersForEvent = tierRows.filter((t) => t.eventId === eventItem.id);
    return formatBrowseEventBlock(eventItem, tiersForEvent);
  });
  const replyOpts = { parse_mode: "MarkdownV2" as const };
  const header =
    `*${escapeMarkdownV2("Browse events")}*\n` +
    `_${escapeMarkdownV2(`${activeEvents.length} published · use Event ID on the web or /buy to refresh`)}_\n\n`;
  const budgetFirst = Math.max(500, 3900 - header.length);
  const budgetRest = 3900;
  let remaining = blocks;
  let first = true;
  while (remaining.length > 0) {
    const budget = first ? budgetFirst : budgetRest;
    const chunk: string[] = [];
    let len = 0;
    while (remaining.length > 0) {
      const next = remaining[0]!;
      const add = chunk.length > 0 ? 2 + next.length : next.length;
      if (len + add > budget && chunk.length > 0) {
        break;
      }
      if (len + add > budget && chunk.length === 0) {
        chunk.push(next);
        remaining = remaining.slice(1);
        break;
      }
      chunk.push(next);
      remaining = remaining.slice(1);
      len += add;
    }
    const body = chunk.join("\n\n");
    await ctx.reply(first ? header + body : body, replyOpts);
    first = false;
  }
}

async function replyMyTicketsPage(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) {
    await ctx.reply("Could not resolve your Telegram account.");
    return;
  }
  const tgId = String(from.id);
  if (!(await privacyAcceptedForUserBot(tgId))) {
    await replyUserBotPrivacyGate(ctx);
    return;
  }
  const rows = await db
    .select({
      eventName: events.name,
      startsAt: events.startsAt,
      location: events.location,
      tierCode: eventTiers.tierCode,
      tierName: eventTiers.tierName,
      orderRef: orders.orderRef,
      ticketStatus: tickets.status,
      usedAt: tickets.usedAt
    })
    .from(tickets)
    .innerJoin(orders, eq(tickets.orderId, orders.id))
    .innerJoin(events, eq(orders.eventId, events.id))
    .innerJoin(eventTiers, eq(orders.tierId, eventTiers.id))
    .where(eq(tickets.telegramUserId, tgId))
    .orderBy(desc(tickets.createdAt))
    .limit(15);
  const replyOpts = { parse_mode: "MarkdownV2" as const };
  if (!rows.length) {
    await ctx.reply(`_${escapeMarkdownV2("No tickets found.")}_`, replyOpts);
    return;
  }
  const header = `*${escapeMarkdownV2(`Your tickets (${rows.length})`)}*\n\n\n`;
  const lines = rows.map((r) => {
    const eventDate = r.startsAt.toISOString().replace("T", " ").slice(0, 16);
    const eventDateCode = `\`${escapeMarkdownV2InlineCode(eventDate)}\``;
    const locationLine = escapeMarkdownV2(r.location?.trim() ? r.location : "-");
    let extra = "";
    if (r.ticketStatus === "used" && r.usedAt) {
      const usedStr = r.usedAt.toISOString().replace("T", " ").slice(0, 16);
      extra = `\n${escapeMarkdownV2("Checked in:")} ${`\`${escapeMarkdownV2InlineCode(usedStr)}\``}`;
    }
    const tierCodePart = `\`${escapeMarkdownV2InlineCode(r.tierCode)}\``;
    const orderRef = `\`${escapeMarkdownV2InlineCode(r.orderRef)}\``;
    const ticketLine = `${escapeMarkdownV2(r.tierName)} \\(${tierCodePart}\\) · ${orderRef}`;
    return (
      `${escapeMarkdownV2("Event name:")} ${escapeMarkdownV2(r.eventName)}\n` +
      `${escapeMarkdownV2("Event Location:")} ${locationLine}\n` +
      `${escapeMarkdownV2("Event Date:")} ${eventDateCode}\n` +
      `${escapeMarkdownV2("Ticket :")} ${ticketLine}\n` +
      `${escapeMarkdownV2("Ticket Status:")} ${formatTicketStatusMarkdownV2(r.ticketStatus)}${extra}`
    );
  });
  await ctx.reply(header + lines.join("\n\n"), replyOpts);
}

const RECEIPT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Telegram limits callback_data to 64 bytes (UTF-8). https://core.telegram.org/bots/api#inlinekeyboardbutton */
const CB_UUID = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";

const textEncoder = new TextEncoder();

function telegramCallbackData(payload: string): string {
  const n = textEncoder.encode(payload).length;
  if (n > 64) {
    throw new Error(`callback_data exceeds 64 UTF-8 bytes (got ${n}): ${payload.slice(0, 80)}`);
  }
  return payload;
}

/** Admin menu / nav: nw | lst | vq | cmd. Event: evd eat eem edo + UUID. Tier: t_edit t_tgl t_f. Event fields: e_f. User menu: user_buy … */

const TIER_FIELD_BY_CODE: Record<string, AdminTierEditState["field"]> = {
  c: "tierCode",
  n: "tierName",
  p: "price",
  k: "capacity",
  b: "earlyBirdPrice",
  w: "earlyBirdEndsAt"
};

const EVENT_FIELD_BY_CODE: Record<string, AdminEditState["field"]> = {
  n: "name",
  s: "startsAt",
  e: "endsAt",
  l: "location",
  d: "description",
  c: "category",
  t: "status",
  i: "eventImageUrl",
  m: "ticketTemplateImageUrl",
  f: "featured"
};

/** Accepts raw UUID or copy-paste from verify queue like `receiptId=<uuid>`. */
function parseReceiptIdArg(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const keyVal = /^receiptId=(.+)$/i.exec(t);
  const candidate = (keyVal ? keyVal[1] : t).trim();
  return RECEIPT_UUID_RE.test(candidate) ? candidate : null;
}

function isAdminUser(telegramUserId: string): boolean {
  return config.adminTelegramIds.includes(telegramUserId);
}

type TierDraft = {
  tierCode: string;
  tierName: string;
  price: number;
  capacity: number | null;
  earlyBirdPrice?: number;
  earlyBirdEndsAt?: string;
};

type AdminCreateState = {
  mode: "create";
  step:
    | "name"
    | "startsAt"
    | "endsAt"
    | "location"
    | "description"
    | "category"
    | "eventImageUrl"
    | "ticketTemplateImageUrl"
    | "featuredAsk"
    | "tierAsk"
    | "tierCode"
    | "tierName"
    | "tierPrice"
    | "earlyBirdPrice"
    | "earlyBirdEnds"
    | "tierCapacity"
    | "confirm";
  name?: string;
  startsAt?: string;
  endsAt?: string;
  location?: string;
  description?: string;
  category?: string;
  eventImageUrl?: string;
  ticketTemplateImageUrl?: string;
  featured?: boolean;
  tiers: TierDraft[];
  draftTier?: Partial<TierDraft>;
};

const adminCreateState = new Map<string, AdminCreateState>();
type AdminTierAddState = {
  eventId: string;
  step: "tierCode" | "tierName" | "tierPrice" | "earlyBirdPrice" | "earlyBirdEnds" | "tierCapacity";
  draftTier: Partial<TierDraft>;
};
type AdminEditState = {
  eventId: string;
  step: "value";
  field:
    | "name"
    | "startsAt"
    | "endsAt"
    | "location"
    | "description"
    | "category"
    | "status"
    | "eventImageUrl"
    | "ticketTemplateImageUrl"
    | "featured";
};
type AdminTierEditState = {
  eventId: string;
  tierId: string;
  field: "tierCode" | "tierName" | "price" | "capacity" | "earlyBirdPrice" | "earlyBirdEndsAt";
  step: "value";
};
const adminTierAddState = new Map<string, AdminTierAddState>();
const adminEditState = new Map<string, AdminEditState>();
const adminTierEditState = new Map<string, AdminTierEditState>();

type AdminScannerUserAddState = {
  step: "username" | "password" | "rolePick";
  username?: string;
  password?: string;
};
const adminScannerUserAddState = new Map<string, AdminScannerUserAddState>();

type AdminPromoCreateState = {
  step:
    | "name"
    | "count"
    | "event"
    | "dtype"
    | "dvalue"
    | "maxUses"
    | "validFrom"
    | "validUntil";
  discountType?: "percent" | "fixed_total";
  name?: string;
  count?: number;
  eventId?: string | null;
  discountValue?: number;
  maxUses?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
};

type AdminPromoEditState = {
  promoId: string;
  field: "name" | "discount" | "maxUses" | "event" | "validFrom" | "validUntil";
};

const adminPromoCreateState = new Map<string, AdminPromoCreateState>();
const adminPromoEditState = new Map<string, AdminPromoEditState>();

if (config.telegramAdminBotToken) {
  adminBot = new Telegraf(config.telegramAdminBotToken);

  async function sendEventDetail(chatId: number, eventId: string) {
    const eventItem = await db.query.events.findFirst({
      where: eq(events.id, eventId)
    });
    if (!eventItem) {
      await adminBot!.telegram.sendMessage(chatId, "Event not found.");
      return;
    }
    const tiers = await db.query.eventTiers.findMany({
      where: eq(eventTiers.eventId, eventId),
      orderBy: [eventTiers.tierName]
    });
    const soldRows = await db
      .select({
        tierId: orders.tierId,
        sold: sql<number>`count(*)::int`
      })
      .from(tickets)
      .innerJoin(orders, eq(tickets.orderId, orders.id))
      .where(eq(orders.eventId, eventId))
      .groupBy(orders.tierId);
    const soldMap = new Map(soldRows.map((item) => [item.tierId, item.sold]));
    const tiersText = tiers.length
      ? tiers
          .map((tier) => {
            const sold = soldMap.get(tier.id) ?? 0;
            const eff = effectiveUnitPriceEtb(tier);
            const eb =
              tier.earlyBirdPrice != null && tier.earlyBirdEndsAt != null
                ? ` early ${tier.earlyBirdPrice} until ${tier.earlyBirdEndsAt.toISOString().slice(0, 16)} →`
                : "";
            return `- ${tier.tierName} (${tier.tierCode})${eb} list ETB ${tier.price} · now ETB ${eff.toFixed(2)} | sold ${sold} | ${tier.active ? "active" : "inactive"}`;
          })
          .join("\n")
      : "No tiers configured.";

    const [issuedRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .innerJoin(orders, eq(tickets.orderId, orders.id))
      .where(eq(orders.eventId, eventId));
    const issuedCount = issuedRow?.n ?? 0;

    const detailBody = `Event: ${eventItem.name}\nCategory: ${eventItem.category}\nFeatured: ${eventItem.featured ? "yes (shown first on lists)" : "no"}\nStatus: ${eventItem.status} — published = on sale (web + Telegram browse); closed/draft = disabled (no new orders, check-in still works)\nStart: ${eventItem.startsAt.toISOString()}\nEnd: ${eventItem.endsAt.toISOString()}\nLocation: ${eventItem.location ?? "-"}\nEvent image: ${eventItem.eventImageUrl ?? "-"}\nTicket template image: ${eventItem.ticketTemplateImageUrl ?? "-"}\n\nTiers:\n${tiersText}\n\nIssued tickets: ${issuedCount} — use the “Ticket holders” button below for the full list.`;

    const tierButtons = tiers.flatMap((tier) => [
      [
        Markup.button.callback(`Edit ${tier.tierCode}`, telegramCallbackData(`t_edit:${tier.id}`)),
        Markup.button.callback(
          tier.active ? `Deactivate ${tier.tierCode}` : `Activate ${tier.tierCode}`,
          telegramCallbackData(`t_tgl:${tier.id}`)
        )
      ]
    ]);

    await adminBot!.telegram.sendMessage(
      chatId,
      detailBody,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Publish (on sale)", telegramCallbackData(`e_st:${eventId}:pub`)),
          Markup.button.callback("Close sales", telegramCallbackData(`e_st:${eventId}:clo`))
        ],
        [Markup.button.callback("Draft (hidden)", telegramCallbackData(`e_st:${eventId}:dra`))],
        [
          Markup.button.callback("Add Tier", telegramCallbackData(`eat:${eventId}`)),
          Markup.button.callback("Edit Event", telegramCallbackData(`eem:${eventId}`))
        ],
        [Markup.button.callback("Ticket holders", telegramCallbackData(`sls:${eventId}`))],
        [Markup.button.callback("Post to channel again", telegramCallbackData(`e_pch:${eventId}`))],
        ...tierButtons,
        [Markup.button.callback("Back to Event List", telegramCallbackData("lst"))]
      ])
    );
  }

  async function sendEventTicketHoldersList(chatId: number, eventId: string) {
    const eventItem = await db.query.events.findFirst({
      where: eq(events.id, eventId)
    });
    if (!eventItem) {
      await adminBot!.telegram.sendMessage(chatId, "Event not found.");
      return;
    }
    const issuedRows = await db
      .select({
        tierCode: eventTiers.tierCode,
        tierName: eventTiers.tierName,
        orderRef: orders.orderRef,
        telegramUserId: tickets.telegramUserId,
        telegramUsername: tickets.telegramUsername,
        ticketStatus: tickets.status
      })
      .from(tickets)
      .innerJoin(orders, eq(tickets.orderId, orders.id))
      .innerJoin(eventTiers, eq(orders.tierId, eventTiers.id))
      .where(eq(orders.eventId, eventId))
      .orderBy(desc(tickets.createdAt));
    if (!issuedRows.length) {
      await adminBot!.telegram.sendMessage(chatId, `No issued tickets yet for “${eventItem.name}”.`);
      return;
    }
    const header = `Ticket holders — ${eventItem.name}\n${issuedRows.length} issued (tier · order ref · buyer @username / id · status)\n`;
    const lines = issuedRows.map((r) => {
      const buyer =
        r.telegramUsername && r.telegramUsername.length > 0
          ? `@${r.telegramUsername} (${r.telegramUserId})`
          : r.telegramUserId;
      return `${r.tierName} (${r.tierCode}) · ${r.orderRef} · ${buyer} · ${r.ticketStatus}`;
    });
    const full = `${header}${lines.join("\n")}`;
    let offset = 0;
    while (offset < full.length) {
      let end = Math.min(offset + 3800, full.length);
      if (end < full.length) {
        const cut = full.lastIndexOf("\n", end);
        if (cut > offset) end = cut;
      }
      await adminBot!.telegram.sendMessage(chatId, full.slice(offset, end).trimEnd());
      offset = end + 1;
    }
  }

  function parseElfCategoryToken(token: string): { label: string; category: string | null } {
    const t = token.trim();
    if (!t || t === "All") return { label: "All categories", category: null };
    const parsed = parseEventCategory(t);
    if (parsed) return { label: parsed, category: parsed };
    const exact = EVENT_CATEGORIES.find((c) => c === t);
    if (exact) return { label: exact, category: exact };
    return { label: "All categories", category: null };
  }

  function buildCategoryFilterRows() {
    const allBtn = Markup.button.callback("All", telegramCallbackData("elf:All"));
    const catBtns = EVENT_CATEGORIES.map((c) =>
      Markup.button.callback(c, telegramCallbackData(`elf:${c}`))
    );
    return [
      [allBtn, catBtns[0]!, catBtns[1]!, catBtns[2]!],
      [catBtns[3]!, catBtns[4]!, catBtns[5]!]
    ];
  }

  async function sendAdminEventList(chatId: number, elfToken: string) {
    const { label, category } = parseElfCategoryToken(elfToken);
    const rows = await db.query.events.findMany({
      where: category ? eq(events.category, category) : undefined,
      orderBy: [desc(events.featured), desc(events.startsAt)],
      limit: 25
    });
    const filterRows = buildCategoryFilterRows();
    if (!rows.length) {
      await adminBot!.telegram.sendMessage(
        chatId,
        `No events in “${label}”. Pick another category below.`,
        Markup.inlineKeyboard(filterRows)
      );
      return;
    }
    const eventRows = rows.map((eventItem) => {
      const prefix = eventItem.featured ? "[F] " : "";
      const statusTag =
        eventItem.status === "published" ? "" : eventItem.status === "closed" ? "[closed] " : "[draft] ";
      const title = `${statusTag}${prefix}${eventItem.name}`.slice(0, 56);
      return [Markup.button.callback(title, telegramCallbackData(`evd:${eventItem.id}`))];
    });
    await adminBot!.telegram.sendMessage(
      chatId,
      `Events — ${label} (${rows.length}). Featured [F] sort first. Tap filter or open an event.`,
      Markup.inlineKeyboard([...filterRows, ...eventRows])
    );
  }

  async function sendScannerStaffList(chatId: number): Promise<void> {
    const rows = await db.query.scannerUsers.findMany({
      orderBy: [asc(scannerUsers.username)],
      limit: 25,
      columns: { id: true, username: true, role: true, active: true }
    });
    if (!rows.length) {
      await adminBot!.telegram.sendMessage(
        chatId,
        "No scanner staff yet. Tap “Add scanner user”.",
        Markup.inlineKeyboard([
          [Markup.button.callback("Add scanner user", telegramCallbackData("su_n"))],
          [Markup.button.callback("Back to menu", telegramCallbackData("adm"))]
        ])
      );
      return;
    }
    const lines = rows.map(
      (r) => `${r.active ? "●" : "○"} ${r.username} · ${r.role}${r.active ? "" : " (disabled)"}`
    );
    const buttons = rows.map((r) => [
      Markup.button.callback(
        `${r.active ? "" : "[off] "}${r.username}`.slice(0, 58),
        telegramCallbackData(`su_v:${r.id}`)
      )
    ]);
    await adminBot!.telegram.sendMessage(
      chatId,
      `Scanner staff (${rows.length})\n${lines.join("\n")}`,
      Markup.inlineKeyboard([
        ...buttons,
        [
          Markup.button.callback("Add scanner user", telegramCallbackData("su_n")),
          Markup.button.callback("Back to menu", telegramCallbackData("adm"))
        ]
      ])
    );
  }

  async function sendScannerUserDetail(chatId: number, userId: string): Promise<void> {
    const user = await db.query.scannerUsers.findFirst({
      where: eq(scannerUsers.id, userId),
      columns: { id: true, username: true, role: true, active: true, createdAt: true }
    });
    if (!user) {
      await adminBot!.telegram.sendMessage(chatId, "Scanner user not found.");
      return;
    }
    const scans = await getScannerUserScanStats(userId);
    const recent = await db.query.auditLogs.findMany({
      where: and(eq(auditLogs.entityType, "scanner_user"), eq(auditLogs.entityId, userId)),
      orderBy: [desc(auditLogs.createdAt)],
      limit: 8
    });
    const auditLines =
      recent.length === 0
        ? "(no admin history yet)"
        : recent
            .map(
              (a) =>
                `${a.createdAt.toISOString().replace("T", " ").slice(0, 16)} · ${a.action} · ${a.actor}`
            )
            .join("\n");
    const body = [
      `Scanner: ${user.username}`,
      `Role: ${user.role} · ${user.active ? "active" : "DISABLED"}`,
      `Created: ${user.createdAt.toISOString()}`,
      "",
      "Check-ins (this login identity):",
      `· Valid (guests admitted): ${scans.valid}`,
      `· Already used: ${scans.alreadyUsed}`,
      `· Invalid QR: ${scans.invalid}`,
      `· Total attempts: ${scans.total}`,
      "",
      "Recent admin actions:",
      auditLines
    ].join("\n");
    const row1 = user.active
      ? [Markup.button.callback("Disable", telegramCallbackData(`su_d:${userId}`))]
      : [Markup.button.callback("Enable", telegramCallbackData(`su_e:${userId}`))];
    await adminBot!.telegram.sendMessage(
      chatId,
      body,
      Markup.inlineKeyboard([
        row1,
        [
          Markup.button.callback("Role: gate", telegramCallbackData(`su_rg:${userId}`)),
          Markup.button.callback("finance", telegramCallbackData(`su_rf:${userId}`))
        ],
        [Markup.button.callback("Role: organizer_admin", telegramCallbackData(`su_ro:${userId}`))],
        [
          Markup.button.callback("Refresh stats", telegramCallbackData(`su_s:${userId}`)),
          Markup.button.callback("Staff list", telegramCallbackData("su_l"))
        ]
      ])
    );
  }

  function parseEventIdOrGlobalForPromo(text: string): { ok: true; eventId: string | null } | { ok: false } {
    const raw = text.trim();
    const t = raw.toLowerCase();
    if (t === "global" || t === "all" || t === "-" || t === "none") return { ok: true, eventId: null };
    if (RECEIPT_UUID_RE.test(raw)) return { ok: true, eventId: raw };
    return { ok: false };
  }

  async function sendPromoList(chatId: number): Promise<void> {
    const rows = await db.query.promoCodes.findMany({
      orderBy: [desc(promoCodes.createdAt)],
      limit: 25
    });
    if (!rows.length) {
      await adminBot!.telegram.sendMessage(
        chatId,
        "No promo codes yet. Tap Create batch.",
        Markup.inlineKeyboard([
          [Markup.button.callback("Create batch", telegramCallbackData("pm_cr"))],
          [Markup.button.callback("Back to menu", telegramCallbackData("adm"))]
        ])
      );
      return;
    }
    const eventIds = [...new Set(rows.map((r) => r.eventId).filter(Boolean))] as string[];
    const evRows =
      eventIds.length > 0
        ? await db.query.events.findMany({
            where: inArray(events.id, eventIds),
            columns: { id: true, name: true }
          })
        : [];
    const evMap = new Map(evRows.map((e) => [e.id, e.name]));
    const lines = rows.map((r) => {
      const ev = r.eventId ? (evMap.get(r.eventId) ?? `${r.eventId.slice(0, 8)}…`) : "global";
      const disc = r.discountType === "percent" ? `${r.discountValue}%` : `−${r.discountValue} ETB`;
      const use = r.maxUses != null ? `${r.usesCount}/${r.maxUses}` : `${r.usesCount}/∞`;
      const act = r.active ? "on" : "off";
      return `${r.code} · ${disc} · uses ${use} · ${act}\n${ev} · ${r.name.slice(0, 48)}`;
    });
    const buttons = rows.map((r) => [
      Markup.button.callback(
        `${r.active ? "" : "○ "}${r.code}`.slice(0, 58),
        telegramCallbackData(`pm_v:${r.id}`)
      )
    ]);
    await adminBot!.telegram.sendMessage(
      chatId,
      `Recent promos (up to 25):\n\n${lines.join("\n\n")}`,
      Markup.inlineKeyboard([
        ...buttons,
        [
          Markup.button.callback("Create batch", telegramCallbackData("pm_cr")),
          Markup.button.callback("Back to menu", telegramCallbackData("adm"))
        ]
      ])
    );
  }

  async function sendPromoDetail(chatId: number, promoId: string): Promise<void> {
    const r = await db.query.promoCodes.findFirst({
      where: eq(promoCodes.id, promoId)
    });
    if (!r) {
      await adminBot!.telegram.sendMessage(chatId, "Promo not found.");
      return;
    }
    let evLabel = "All events (global)";
    if (r.eventId) {
      const ev = await db.query.events.findFirst({
        where: eq(events.id, r.eventId),
        columns: { name: true }
      });
      evLabel = ev ? `${ev.name}` : r.eventId;
    }
    const disc =
      r.discountType === "percent" ? `${r.discountValue}% off` : `ETB ${r.discountValue} off order`;
    const use = r.maxUses != null ? `${r.usesCount} / ${r.maxUses}` : `${r.usesCount} / ∞`;
    const vf = r.validFrom ? r.validFrom.toISOString() : "—";
    const vu = r.validUntil ? r.validUntil.toISOString() : "—";
    const body = [
      `Promo: ${r.name}`,
      `Code: ${r.code}`,
      `Discount: ${disc}`,
      `Event: ${evLabel}`,
      `Uses: ${use}`,
      `Active: ${r.active ? "yes" : "no"}`,
      `Valid from: ${vf}`,
      `Valid until: ${vu}`,
      "",
      `id: ${r.id}`
    ].join("\n");
    await adminBot!.telegram.sendMessage(
      chatId,
      body,
      Markup.inlineKeyboard([
        [Markup.button.callback(r.active ? "Deactivate" : "Activate", telegramCallbackData(`pm_a:${r.id}`))],
        [
          Markup.button.callback("Rename", telegramCallbackData(`pm_en:${r.id}`)),
          Markup.button.callback("Discount", telegramCallbackData(`pm_ed:${r.id}`))
        ],
        [
          Markup.button.callback("Max uses", telegramCallbackData(`pm_mu:${r.id}`)),
          Markup.button.callback("Event scope", telegramCallbackData(`pm_ev:${r.id}`))
        ],
        [
          Markup.button.callback("Valid from", telegramCallbackData(`pm_vf:${r.id}`)),
          Markup.button.callback("Valid until", telegramCallbackData(`pm_vu:${r.id}`))
        ],
        [
          Markup.button.callback("Delete", telegramCallbackData(`pm_dl:${r.id}`)),
          Markup.button.callback("Browse list", telegramCallbackData("pm_ls"))
        ]
      ])
    );
  }

  const adminMenu = Markup.inlineKeyboard([
    [Markup.button.callback("Create New Event", telegramCallbackData("nw"))],
    [Markup.button.callback("Event List", telegramCallbackData("lst"))],
    [Markup.button.callback("Promo codes", telegramCallbackData("pm_m"))],
    [Markup.button.callback("Scanner staff", telegramCallbackData("su_l"))],
    [Markup.button.callback("View Verify Queue", telegramCallbackData("vq"))],
    [Markup.button.callback("Show Commands", telegramCallbackData("cmd"))]
  ]);

  adminBot.start(async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    await ctx.reply("Admin bot ready. Open menu with /adminmenu");
  });

  adminBot.command("adminmenu", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    await ctx.reply("Admin quick actions:", adminMenu);
  });

  adminBot.action("nw", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    adminCreateState.set(String(ctx.from.id), { mode: "create", step: "name", tiers: [] });
    await ctx.reply("Creating new event.\nStep 1/12: send event name.");
  });

  adminBot.action("lst", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await sendAdminEventList(ctx.chat!.id, "All");
  });

  adminBot.action(new RegExp(`^elf:(.+)$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const token = ctx.match![1];
    await sendAdminEventList(ctx.chat!.id, token);
  });

  adminBot.action(new RegExp(`^evd:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    await sendEventDetail(ctx.chat!.id, eventId);
  });

  adminBot.action(new RegExp(`^e_st:${CB_UUID}:(pub|clo|dra)$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    const eventId = ctx.match[1];
    const code = ctx.match[2];
    const status = code === "pub" ? "published" : code === "clo" ? "closed" : "draft";
    const prev = await db.query.events.findFirst({
      where: eq(events.id, eventId),
      columns: { status: true }
    });
    const [row] = await db.update(events).set({ status, updatedAt: new Date() }).where(eq(events.id, eventId)).returning();
    if (!row) {
      await ctx.answerCbQuery("Event not found");
      return;
    }
    await ctx.answerCbQuery(`Set to ${status}`);
    await sendEventDetail(ctx.chat!.id, eventId);
    if (status === "published" && prev?.status !== "published") {
      scheduleChannelAnnounceWhenNewlyPublished(eventId, prev?.status);
    }
  });

  adminBot.action(new RegExp(`^e_pch:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    const result = await announcePublishedEventToChannel(eventId);
    if (!result.ok) {
      const msg =
        result.error === "skipped_no_config"
          ? "Channel posting is not configured. Set TELEGRAM_EVENTS_CHANNEL_CHAT_ID (and TELEGRAM_USER_BOT_TOKEN); the user bot must be a channel admin."
          : result.error === "not_published"
            ? "Only published events can be posted. Publish the event first."
            : `Could not post: ${result.error}`;
      await ctx.reply(msg);
      return;
    }
    await ctx.reply(
      `Posted to the events channel again for event ${eventId}${result.messageId != null ? ` (message_id ${result.messageId})` : ""}.`
    );
  });

  adminBot.action(new RegExp(`^sls:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    await sendEventTicketHoldersList(ctx.chat!.id, eventId);
  });

  adminBot.action(new RegExp(`^eat:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    adminTierAddState.set(String(ctx.from.id), { eventId, step: "tierCode", draftTier: {} });
    await ctx.reply("Add tier to this event.\nStep A: send tier code.");
  });

  adminBot.action(new RegExp(`^t_tgl:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const tierId = ctx.match[1];
    const tier = await db.query.eventTiers.findFirst({
      where: eq(eventTiers.id, tierId)
    });
    if (!tier) {
      await ctx.reply("Tier not found.");
      return;
    }
    const eventId = tier.eventId;
    await db
      .update(eventTiers)
      .set({ active: !tier.active, updatedAt: new Date() })
      .where(eq(eventTiers.id, tier.id));
    await ctx.reply(`Tier ${tier.tierCode} is now ${tier.active ? "inactive" : "active"}.`);
    await sendEventDetail(ctx.chat!.id, eventId);
  });

  adminBot.action(new RegExp(`^t_edit:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const tierId = ctx.match[1];
    const tier = await db.query.eventTiers.findFirst({
      where: eq(eventTiers.id, tierId)
    });
    if (!tier) {
      await ctx.reply("Tier not found.");
      return;
    }
    const eventId = tier.eventId;
    await ctx.reply(
      "Choose tier field to edit:",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Code", telegramCallbackData(`t_f:${tierId}:c`)),
          Markup.button.callback("Name", telegramCallbackData(`t_f:${tierId}:n`))
        ],
        [
          Markup.button.callback("Price", telegramCallbackData(`t_f:${tierId}:p`)),
          Markup.button.callback("Capacity", telegramCallbackData(`t_f:${tierId}:k`))
        ],
        [
          Markup.button.callback("Early $", telegramCallbackData(`t_f:${tierId}:b`)),
          Markup.button.callback("Early end", telegramCallbackData(`t_f:${tierId}:w`))
        ],
        [Markup.button.callback("Back", telegramCallbackData(`evd:${eventId}`))]
      ])
    );
  });

  adminBot.action(new RegExp(`^t_f:${CB_UUID}:([cnkpbw])$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const tierId = ctx.match[1];
    const code = ctx.match[2];
    const field = TIER_FIELD_BY_CODE[code];
    if (!field) {
      await ctx.reply("Invalid field.");
      return;
    }
    const tier = await db.query.eventTiers.findFirst({
      where: eq(eventTiers.id, tierId)
    });
    if (!tier) {
      await ctx.reply("Tier not found.");
      return;
    }
    adminTierEditState.set(String(ctx.from.id), {
      eventId: tier.eventId,
      tierId,
      field,
      step: "value"
    });
    const hint =
      field === "capacity"
        ? " For capacity you can send skip for unlimited."
        : field === "earlyBirdEndsAt"
          ? " Send ISO datetime (e.g. 2026-06-01T17:00:00Z) or skip to clear."
          : field === "earlyBirdPrice"
            ? " Send ETB amount or skip to clear early bird."
            : "";
    await ctx.reply(`Send new value for ${field}.${hint}`);
  });

  adminBot.action(new RegExp(`^eem:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    await ctx.reply(
      "Choose an event field (name, dates, images, featured, status, etc.).\n\n" +
        "Early-bird pricing is per ticket tier, not here: tap Done, then Edit vip / Edit standard → Early $ and Early end.\n\n" +
        "Promo codes: Admin menu → Promo codes (or HTTP /admin/promo-codes with x-scanner-api-key).",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Name", telegramCallbackData(`e_f:${eventId}:n`)),
          Markup.button.callback("Start Date", telegramCallbackData(`e_f:${eventId}:s`))
        ],
        [
          Markup.button.callback("End Date", telegramCallbackData(`e_f:${eventId}:e`)),
          Markup.button.callback("Location", telegramCallbackData(`e_f:${eventId}:l`))
        ],
        [
          Markup.button.callback("Description", telegramCallbackData(`e_f:${eventId}:d`)),
          Markup.button.callback("Category", telegramCallbackData(`e_f:${eventId}:c`))
        ],
        [
          Markup.button.callback("Status", telegramCallbackData(`e_f:${eventId}:t`)),
          Markup.button.callback("Event Image URL", telegramCallbackData(`e_f:${eventId}:i`))
        ],
        [Markup.button.callback("Ticket Template URL", telegramCallbackData(`e_f:${eventId}:m`))],
        [Markup.button.callback("Featured (list order)", telegramCallbackData(`e_f:${eventId}:f`))],
        [Markup.button.callback("Where are early-bird & promos?", telegramCallbackData(`e_pricing_help:${eventId}`))],
        [Markup.button.callback("Done (back to event)", telegramCallbackData(`edo:${eventId}`))]
      ])
    );
  });

  adminBot.action(new RegExp(`^e_pricing_help:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    await ctx.reply(
      [
        "Early bird (per tier):",
        "1) Open the event detail screen (Event List → event, or tap Done below).",
        "2) Under Tiers, tap Edit {tierCode}.",
        "3) Early $ (ETB), then Early end (ISO datetime, e.g. 2026-06-01T17:00:00Z). Type skip on either to clear.",
        "",
        "Promo codes:",
        "Admin menu → Promo codes — create batch, browse, edit, delete.",
        "HTTP still works: POST/PATCH /admin/promo-codes with x-scanner-api-key."
      ].join("\n")
    );
    await sendEventDetail(ctx.chat!.id, eventId);
  });

  adminBot.action(new RegExp(`^e_f:${CB_UUID}:([a-z])$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    const code = ctx.match[2];
    const field = EVENT_FIELD_BY_CODE[code];
    if (!field) {
      await ctx.reply("Invalid field.");
      return;
    }
    adminEditState.set(String(ctx.from.id), { eventId, step: "value", field });
    await ctx.reply(
      field === "featured"
        ? "Featured events appear first on public /events and user Browse. Send yes or no."
        : field === "status"
          ? "Send status: published (on sale — web + Telegram), closed (disable new orders), or draft (hidden). Or use the buttons on the event screen."
          : `Send new value for ${field}. For image fields you can send URL, upload photo, or type skip.`
    );
  });

  adminBot.action(new RegExp(`^edo:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    adminEditState.delete(String(ctx.from.id));
    await sendEventDetail(ctx.chat!.id, ctx.match[1]);
  });

  adminBot.action("vq", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const queue = await db.query.receiptSubmissions.findMany({
      where: eq(receiptSubmissions.verificationStatus, "verifying"),
      orderBy: [desc(receiptSubmissions.createdAt)],
      limit: 10
    });
    if (!queue.length) {
      await ctx.reply("No receipts waiting verification.");
      return;
    }
    const text = [
      ...queue.map((item) => `receiptId=${item.id}\norderId=${item.orderId}\nreceiptNo=${item.receiptNo}`),
      "",
      "Re-run Telebirr on one: /reverify <receiptId>",
      "",
      "Wrong receipt locked the number? After /reject, use /releasereceipt <receiptId> to free it (or for verifying-only mistakes)."
    ].join("\n");
    await ctx.reply(text);
  });

  adminBot.action("cmd", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply(
      "Commands:\n/adminmenu\n/newevent name|…|category(optional)|featured yes/no(optional)\nEvent List: category filter buttons — open an event to Publish / Close sales / Draft\nWhen an event becomes published, it can auto-post to your channel (set TELEGRAM_EVENTS_CHANNEL_CHAT_ID; user bot must be channel admin). From an event’s detail screen you can also tap “Post to channel again”.\n/addtier eventId|… (no early-bird — use Edit tier on the event screen for Early $ / Early end)\n/resendtickets ORDER_REF — resend all QR images to buyer (admin only)\n/verifyqueue\n/approve /reject /reverify /releasereceipt /eventsales …\nPromo codes: admin menu → Promo codes (create/browse/edit/delete). Same rules as HTTP /admin/promo-codes for API clients.\nScanner staff: admin menu button — add/disable/enable gate logins, roles, scan counts & audit history."
    );
  });

  adminBot.action("pm_m", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply(
      "Promo codes — server generates each code string; you set name, count, discount, and optional limits.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Create batch", telegramCallbackData("pm_cr"))],
        [Markup.button.callback("Browse recent", telegramCallbackData("pm_ls"))],
        [Markup.button.callback("Back to menu", telegramCallbackData("adm"))]
      ])
    );
  });

  adminBot.action("pm_ls", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await sendPromoList(ctx.chat!.id);
  });

  adminBot.action("pm_cr", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    adminPromoCreateState.set(String(ctx.from.id), { step: "name" });
    await ctx.reply(
      "Create promo batch.\nStep 1: send campaign name (stored on each generated code).\n/cancel to abort."
    );
  });

  adminBot.action(/^pm_ct:([pf])$/, async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    const st = adminPromoCreateState.get(String(ctx.from.id));
    if (!st || st.step !== "dtype") {
      await ctx.answerCbQuery("No draft here");
      return;
    }
    const code = ctx.match![1];
    st.discountType = code === "p" ? "percent" : "fixed_total";
    st.step = "dvalue";
    await ctx.answerCbQuery();
    await ctx.reply(
      st.discountType === "percent"
        ? "Send percent discount (1–100)."
        : "Send fixed discount in ETB (subtracted from order subtotal, capped at subtotal)."
    );
  });

  adminBot.action(new RegExp(`^pm_v:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await sendPromoDetail(ctx.chat!.id, ctx.match![1]!);
  });

  adminBot.action(new RegExp(`^pm_a:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    const id = ctx.match![1]!;
    const row = await db.query.promoCodes.findFirst({ where: eq(promoCodes.id, id) });
    if (!row) {
      await ctx.answerCbQuery("Not found");
      return;
    }
    const result = await updatePromoById(id, { active: !row.active });
    await ctx.answerCbQuery(result.ok ? "Updated" : "Error");
    if (result.ok) {
      await sendPromoDetail(ctx.chat!.id, id);
    } else {
      await ctx.reply(result.error);
    }
  });

  adminBot.action(new RegExp(`^pm_en:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const id = ctx.match![1]!;
    adminPromoEditState.set(String(ctx.from.id), { promoId: id, field: "name" });
    await ctx.reply("Send new campaign name for this code.");
  });

  adminBot.action(new RegExp(`^pm_ed:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const id = ctx.match![1]!;
    adminPromoEditState.set(String(ctx.from.id), { promoId: id, field: "discount" });
    await ctx.reply("Send discount as one line:\npercent 15\nor\nfixed 99.5\n(percent = % off subtotal; fixed = ETB off whole order subtotal).");
  });

  adminBot.action(new RegExp(`^pm_mu:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const id = ctx.match![1]!;
    adminPromoEditState.set(String(ctx.from.id), { promoId: id, field: "maxUses" });
    await ctx.reply("Send max uses (positive integer), or unlimited");
  });

  adminBot.action(new RegExp(`^pm_ev:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const id = ctx.match![1]!;
    adminPromoEditState.set(String(ctx.from.id), { promoId: id, field: "event" });
    await ctx.reply("Send event UUID to restrict this code to one event, or global");
  });

  adminBot.action(new RegExp(`^pm_vf:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const id = ctx.match![1]!;
    adminPromoEditState.set(String(ctx.from.id), { promoId: id, field: "validFrom" });
    await ctx.reply("Send valid-from as ISO datetime, or skip");
  });

  adminBot.action(new RegExp(`^pm_vu:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const id = ctx.match![1]!;
    adminPromoEditState.set(String(ctx.from.id), { promoId: id, field: "validUntil" });
    await ctx.reply("Send valid-until as ISO datetime, or skip");
  });

  adminBot.action(new RegExp(`^pm_dl:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const id = ctx.match![1]!;
    await ctx.reply(
      "Delete this promo row permanently?",
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, delete", telegramCallbackData(`pm_dy:${id}`))],
        [Markup.button.callback("No", telegramCallbackData(`pm_v:${id}`))]
      ])
    );
  });

  adminBot.action(new RegExp(`^pm_dy:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    const id = ctx.match![1]!;
    const ok = await deletePromoById(id);
    await ctx.answerCbQuery(ok ? "Deleted" : "Not found");
    if (ok) {
      await ctx.reply("Promo removed.");
      await sendPromoList(ctx.chat!.id);
    } else {
      await ctx.reply("Promo not found (already deleted?).");
    }
  });

  adminBot.action("adm", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply("Admin quick actions:", adminMenu);
  });

  adminBot.action("su_l", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await sendScannerStaffList(ctx.chat!.id);
  });

  adminBot.action("su_n", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    adminScannerUserAddState.set(String(ctx.from.id), { step: "username" });
    await ctx.reply("New scanner user — send login username (lowercase, 2–64 chars: a-z 0-9 _ -). /cancel to abort.");
  });

  adminBot.action(new RegExp(`^su_v:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await sendScannerUserDetail(ctx.chat!.id, ctx.match![1]!);
  });

  adminBot.action(new RegExp(`^su_s:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const userId = ctx.match![1]!;
    const scans = await getScannerUserScanStats(userId);
    await ctx.reply(
      `Scan totals for this account:\n· Valid: ${scans.valid}\n· Already used: ${scans.alreadyUsed}\n· Invalid: ${scans.invalid}\n· Total: ${scans.total}\n\n(Counts use check-ins after this update; API-key scans are not tied to a user.)`
    );
  });

  adminBot.action(new RegExp(`^su_d:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    const userId = ctx.match![1]!;
    const actor = `admin_tg:${ctx.from?.id ?? "?"}`;
    const existing = await db.query.scannerUsers.findFirst({ where: eq(scannerUsers.id, userId) });
    if (!existing) {
      await ctx.answerCbQuery("Not found");
      return;
    }
    if (!existing.active) {
      await ctx.answerCbQuery("Already disabled");
      return;
    }
    await db.update(scannerUsers).set({ active: false, updatedAt: new Date() }).where(eq(scannerUsers.id, userId));
    await auditScannerUserAdmin({
      action: "scanner_user_disabled",
      scannerUserId: userId,
      actorLabel: actor,
      metadata: { username: existing.username, channel: "telegram_admin" }
    });
    await ctx.answerCbQuery("Disabled");
    await sendScannerUserDetail(ctx.chat!.id, userId);
  });

  adminBot.action(new RegExp(`^su_e:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    const userId = ctx.match![1]!;
    const actor = `admin_tg:${ctx.from?.id ?? "?"}`;
    const existing = await db.query.scannerUsers.findFirst({ where: eq(scannerUsers.id, userId) });
    if (!existing) {
      await ctx.answerCbQuery("Not found");
      return;
    }
    if (existing.active) {
      await ctx.answerCbQuery("Already active");
      return;
    }
    await db.update(scannerUsers).set({ active: true, updatedAt: new Date() }).where(eq(scannerUsers.id, userId));
    await auditScannerUserAdmin({
      action: "scanner_user_enabled",
      scannerUserId: userId,
      actorLabel: actor,
      metadata: { username: existing.username, channel: "telegram_admin" }
    });
    await ctx.answerCbQuery("Enabled");
    await sendScannerUserDetail(ctx.chat!.id, userId);
  });

  async function setScannerUserRoleTelegram(userId: string, role: ScannerRole, ctx: Context): Promise<void> {
    const actor = `admin_tg:${ctx.from?.id ?? "?"}`;
    const existing = await db.query.scannerUsers.findFirst({ where: eq(scannerUsers.id, userId) });
    if (!existing) {
      await ctx.answerCbQuery("Not found");
      return;
    }
    if (existing.role === role) {
      await ctx.answerCbQuery("Role unchanged");
      return;
    }
    await db.update(scannerUsers).set({ role, updatedAt: new Date() }).where(eq(scannerUsers.id, userId));
    await auditScannerUserAdmin({
      action: "scanner_user_role_changed",
      scannerUserId: userId,
      actorLabel: actor,
      metadata: {
        username: existing.username,
        from: existing.role,
        to: role,
        channel: "telegram_admin"
      }
    });
    await ctx.answerCbQuery(`Role → ${role}`);
    await sendScannerUserDetail(ctx.chat!.id, userId);
  }

  adminBot.action(new RegExp(`^su_rg:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await setScannerUserRoleTelegram(ctx.match![1]!, "gate", ctx);
  });

  adminBot.action(new RegExp(`^su_rf:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await setScannerUserRoleTelegram(ctx.match![1]!, "finance", ctx);
  });

  adminBot.action(new RegExp(`^su_ro:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await setScannerUserRoleTelegram(ctx.match![1]!, "organizer_admin", ctx);
  });

  adminBot.action(/^su_cr:([gfo])$/, async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    const st = adminScannerUserAddState.get(String(ctx.from.id));
    if (!st || st.step !== "rolePick" || !st.username || !st.password) {
      await ctx.answerCbQuery("Start from Scanner staff → Add user");
      return;
    }
    const code = ctx.match![1] as "g" | "f" | "o";
    const role: ScannerRole = code === "g" ? "gate" : code === "f" ? "finance" : "organizer_admin";
    const passwordHash = await bcrypt.hash(st.password, 12);
    const actor = `admin_tg:${ctx.from?.id ?? "?"}`;
    try {
      const [row] = await db
        .insert(scannerUsers)
        .values({ username: st.username, passwordHash, role, active: true })
        .returning({ id: scannerUsers.id, username: scannerUsers.username });
      adminScannerUserAddState.delete(String(ctx.from.id));
      await auditScannerUserAdmin({
        action: "scanner_user_created",
        scannerUserId: row.id,
        actorLabel: actor,
        metadata: { username: row.username, role, channel: "telegram_admin" }
      });
      await ctx.answerCbQuery("Created");
      await ctx.reply(`Scanner user created: ${row.username} (${role}).`);
      await sendScannerUserDetail(ctx.chat!.id, row.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.answerCbQuery(msg.includes("unique") ? "Username taken" : "Failed");
      if (msg.includes("unique") || msg.includes("duplicate")) {
        await ctx.reply("That username is already taken. /cancel then Add scanner user again.");
      }
      adminScannerUserAddState.delete(String(ctx.from.id));
    }
  });

  adminBot.command("resendtickets", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const args = getArgs(getText(ctx));
    const orderRef = args[0]?.trim();
    if (!orderRef) {
      await ctx.reply(
        "Usage: /resendtickets ORDER_REF\n\nSends every ticket QR image again to the buyer’s linked Telegram (same codes as before). Use when delivery failed or the guest lost the chat."
      );
      return;
    }
    const result = await pushAllTicketQrsForOrder({
      orderRef,
      actorLabel: `admin_tg:${ctx.from?.id ?? "?"}`
    });
    if (!result.ok) {
      await ctx.reply(`Could not resend: ${result.error}`);
      return;
    }
    let msg = `Sent ${result.pushed}/${result.total} ticket QR(s) to the buyer for ${result.orderRef}.`;
    if (result.warning) {
      msg += `\n\n${result.warning}`;
    }
    await ctx.reply(msg);
  });

  adminBot.command("eventlist", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    await sendAdminEventList(ctx.chat!.id, "All");
  });

  adminBot.command("newevent", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const payload = getText(ctx).replace("/newevent", "").trim();
    const [name, startsAt, endsAt, location, description, categoryRaw, featuredRaw] = payload
      .split("|")
      .map((item) => item.trim());
    if (!name || !startsAt || !endsAt) {
      await ctx.reply(
        "Usage: /newevent name|startsAtISO|endsAtISO|location|description|category(optional)|featured(optional yes/no)\nCategory: Music, Festivals, Arts, Exhibitions, Sports, Tech"
      );
      return;
    }
    let finalCategory = DEFAULT_EVENT_CATEGORY;
    if (categoryRaw) {
      const parsed = parseEventCategory(categoryRaw);
      if (!parsed) {
        await ctx.reply(`Invalid category. Use: ${EVENT_CATEGORIES.join(", ")}`);
        return;
      }
      finalCategory = parsed;
    }
    let featured = false;
    if (featuredRaw) {
      const fr = featuredRaw.toLowerCase();
      featured = ["yes", "y", "true", "1"].includes(fr);
      if (!featured && !["no", "n", "false", "0"].includes(fr)) {
        await ctx.reply("Featured must be yes or no (last field).");
        return;
      }
    }
    const [created] = await db
      .insert(events)
      .values({
        name,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        location,
        description,
        category: finalCategory,
        featured,
        status: "published"
      })
      .returning();
    await ctx.reply(`Event created: ${created.name}\nID: ${created.id}`);
    scheduleChannelAnnounceWhenNewlyPublished(created.id, undefined);
  });

  adminBot.command("cancel", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    adminCreateState.delete(String(ctx.from.id));
    adminTierAddState.delete(String(ctx.from.id));
    adminEditState.delete(String(ctx.from.id));
    adminTierEditState.delete(String(ctx.from.id));
    adminScannerUserAddState.delete(String(ctx.from.id));
    adminPromoCreateState.delete(String(ctx.from.id));
    adminPromoEditState.delete(String(ctx.from.id));
    await ctx.reply("Current wizard cancelled.");
  });

  adminBot.command("addtier", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const payload = getText(ctx).replace("/addtier", "").trim();
    const [eventId, tierCode, tierName, priceRaw, capacityRaw] = payload.split("|").map((item) => item.trim());
    if (!eventId || !tierCode || !tierName || !priceRaw) {
      await ctx.reply("Usage: /addtier eventId|tierCode|tierName|price|capacity(optional)");
      return;
    }
    const [created] = await db
      .insert(eventTiers)
      .values({
        eventId,
        tierCode: tierCode.toLowerCase(),
        tierName,
        price: Number(priceRaw).toFixed(2),
        capacity: capacityRaw ? Number(capacityRaw) : null,
        active: true
      })
      .returning();
    await ctx.reply(`Tier added: ${created.tierName} (${created.tierCode}) for event ${created.eventId}`);
  });

  adminBot.command("eventsales", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const args = getArgs(getText(ctx));
    const raw = args[0]?.trim() ?? "";
    const eventId = RECEIPT_UUID_RE.test(raw) ? raw : null;
    if (!eventId) {
      await ctx.reply(
        "Usage: /eventsales EVENT_UUID\n\nSummary from immutable sales ledger. Event List → event details for the id.\nExports: GET /admin/events/:eventId/sales-ledger (JSON) or …/sales-ledger.csv"
      );
      return;
    }
    const report = await getEventTicketSalesReport(eventId, 15);
    if (!report) {
      await ctx.reply("Event not found.");
      return;
    }
    const { summary, ticketLines } = report;
    const tierLines =
      summary.byTier.length > 0
        ? summary.byTier
            .map(
              (t) =>
                `${t.tierCode}: ${t.ticketsSold} sold · ETB ${t.revenueEtb} (list ${t.listPriceEtb})`
            )
            .join("\n")
        : "(no tickets issued yet)";
    const parts = [
      `Sales — ${report.event.name}`,
      `Total tickets: ${summary.totalTicketsIssued} · Revenue: ETB ${summary.totalRevenueEtb}`,
      "",
      tierLines
    ];
    if (ticketLines?.length) {
      parts.push(
        "",
        "Recent tickets:",
        ...ticketLines.map(
          (r) =>
            `${r.orderRef} · ${r.tierCode} · ${
              r.buyerUsername && r.buyerUsername.length > 0
                ? `@${r.buyerUsername.replace(/^@/, "")}`
                : r.buyerTelegramId
            } · ${r.ticketStatus} · ETB ${r.revenueForThisTicketEtb}`
        )
      );
    }
    await ctx.reply(parts.join("\n"));
  });

  adminBot.command("verifyqueue", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const queue = await db.query.receiptSubmissions.findMany({
      where: eq(receiptSubmissions.verificationStatus, "verifying"),
      orderBy: [desc(receiptSubmissions.createdAt)],
      limit: 10
    });
    if (!queue.length) {
      await ctx.reply("No receipts waiting verification.");
      return;
    }
    const text = [
      ...queue.map((item) => `receiptId=${item.id}\norderId=${item.orderId}\nreceiptNo=${item.receiptNo}`),
      "",
      "Re-run Telebirr on one: /reverify <receiptId>",
      "Wrong receipt number locking Telebirr? /releasereceipt <receiptId> (order must have no tickets)."
    ].join("\n");
    await ctx.reply(text);
  });

  adminBot.command("reverify", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const args = getArgs(getText(ctx));
    const receiptId = parseReceiptIdArg(args[0]);
    if (!receiptId) {
      await ctx.reply(
        "Usage: /reverify RECEIPT_UUID\nRuns the Telebirr verify API again for a receipt still in “verifying”. If it passes, the order is approved and the buyer gets the QR (when their Telegram is linked to the order).\n\nSame receipt ID format as /approve."
      );
      return;
    }
    await ctx.reply("Re-verifying with Telebirr API…");
    const result = await reverifyReceiptWithTelebirrApi({
      receiptId,
      verifiedBy: `admin_tg:${ctx.from.id}`
    });
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }
    let reply = `OK — order ${result.orderRef}\n${result.verificationNotes}`;
    if (!result.telegramUserId) {
      reply += "\n\nNo Telegram account linked on this order yet — the buyer should open the user bot and use /claim ORDER_REF (or submit receipt from Telegram to link).";
    } else if (!result.hasTicket) {
      reply += "\n\nTicket could not be created automatically; buyer can try /claim.";
    }
    await ctx.reply(reply);
    const toPush = result.hasTicket ? result.newlyIssuedTickets : [];
    if (toPush.length > 0 && result.telegramUserId && userBot) {
      try {
        const total = result.tickets.length;
        const offset = total - toPush.length;
        for (let i = 0; i < toPush.length; i++) {
          const row = toPush[i]!;
          await userBot.telegram.sendPhoto(
            result.telegramUserId,
            { source: Buffer.from(row.qrImageDataUrl.split(",")[1], "base64") },
            {
              caption:
                total > 1
                  ? `Ticket ${offset + i + 1}/${total} · order ${result.orderRef}. Payment verified — each QR once.`
                  : `Ticket for order ${result.orderRef}. Payment verified — this QR can be used once.`
            }
          );
        }
        await ctx.reply("QR code(s) sent to the buyer via the user bot.");
      } catch (err) {
        await ctx.reply(
          `Order approved and ticket(s) saved, but sending QR(s) to the user failed: ${err instanceof Error ? err.message : String(err)} (blocked bot / invalid chat).`
        );
      }
    } else if (result.hasTicket && toPush.length > 0 && result.telegramUserId && !userBot) {
      await ctx.reply("User bot token not configured — could not push QR. Tickets are stored; buyer can use /mytickets on the user bot.");
    }
  });

  adminBot.command("approve", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const args = getArgs(getText(ctx));
    const receiptId = parseReceiptIdArg(args[0]);
    if (!receiptId) {
      await ctx.reply(
        "Usage: /approve RECEIPT_UUID\nExample:\n/approve 64448a4a-6498-4a12-876b-e9234cf4bf2d\n\nYou can paste the line from /verifyqueue (receiptId=...) — it is accepted."
      );
      return;
    }
    const receipt = await db.query.receiptSubmissions.findFirst({ where: eq(receiptSubmissions.id, receiptId) });
    if (!receipt) {
      await ctx.reply("Receipt not found.");
      return;
    }
    await db
      .update(receiptSubmissions)
      .set({
        verificationStatus: "approved",
        verifiedBy: String(ctx.from.id),
        verificationNotes: "Approved from admin bot.",
        updatedAt: new Date()
      })
      .where(eq(receiptSubmissions.id, receiptId));
    await db.update(orders).set({ status: "approved", updatedAt: new Date() }).where(eq(orders.id, receipt.orderId));
    await ctx.reply(`Approved receipt ${receiptId}`);
  });

  adminBot.command("reject", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const args = getArgs(getText(ctx));
    const receiptId = parseReceiptIdArg(args[0]);
    const reason = args.slice(1).join(" ") || "Rejected from admin bot.";
    if (!receiptId) {
      await ctx.reply(
        "Usage: /reject RECEIPT_UUID reason\nExample: /reject 64448a4a-... wrong amount"
      );
      return;
    }
    const receipt = await db.query.receiptSubmissions.findFirst({ where: eq(receiptSubmissions.id, receiptId) });
    if (!receipt) {
      await ctx.reply("Receipt not found.");
      return;
    }
    await db
      .update(receiptSubmissions)
      .set({
        verificationStatus: "rejected",
        verifiedBy: String(ctx.from.id),
        verificationNotes: reason,
        updatedAt: new Date()
      })
      .where(eq(receiptSubmissions.id, receiptId));
    await db.update(orders).set({ status: "rejected", updatedAt: new Date() }).where(eq(orders.id, receipt.orderId));
    await ctx.reply(`Rejected receipt ${receiptId}`);
  });

  adminBot.command("releasereceipt", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const args = getArgs(getText(ctx));
    const receiptId = parseReceiptIdArg(args[0]);
    const notes = args.slice(1).join(" ").trim() || undefined;
    if (!receiptId) {
      await ctx.reply(
        [
          "Usage: /releasereceipt RECEIPT_UUID [note]",
          "Deletes the submission row so the same Telebirr receipt number can be submitted again.",
          "Order goes back to pending_receipt. Only for rejected or verifying — never if approved or tickets exist.",
          "Example: /releasereceipt 64448a4a-... typo fixed"
        ].join("\n")
      );
      return;
    }
    const result = await releaseReceiptSubmissionForResubmit({
      receiptId,
      actor: `admin_tg:${ctx.from?.id ?? "?"}`,
      notes
    });
    if (!result.ok) {
      await ctx.reply(`Cannot release: ${result.error}`);
      return;
    }
    await ctx.reply(
      `Released submission ${receiptId}. Receipt ${result.freedReceiptNo} is free to use again. Order reset to pending_receipt.`
    );
  });

  adminBot.on("text", async (ctx, next) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await next();
      return;
    }
    const scannerAdd = adminScannerUserAddState.get(String(ctx.from.id));
    if (scannerAdd) {
      const text = getText(ctx).trim();
      if (scannerAdd.step === "rolePick") {
        await ctx.reply("Choose a role with the buttons, or /cancel.");
        return;
      }
      if (!text) {
        await ctx.reply("Send a value or /cancel.");
        return;
      }
      if (scannerAdd.step === "username") {
        const u = text.toLowerCase();
        if (!/^[a-z0-9_-]{2,64}$/.test(u)) {
          await ctx.reply("Use 2–64 characters: a-z 0-9 _ -");
          return;
        }
        scannerAdd.username = u;
        scannerAdd.step = "password";
        await ctx.reply(
          `Username: ${u}\nSend password (min 8 characters). Delete this chat message later if others can read it.`
        );
        return;
      }
      if (scannerAdd.step === "password") {
        if (text.length < 8) {
          await ctx.reply("Password must be at least 8 characters.");
          return;
        }
        scannerAdd.password = text;
        scannerAdd.step = "rolePick";
        await ctx.reply(
          "Choose role:",
          Markup.inlineKeyboard([
            [Markup.button.callback("gate (scan only)", "su_cr:g")],
            [Markup.button.callback("finance (sales read)", "su_cr:f")],
            [Markup.button.callback("organizer_admin", "su_cr:o")]
          ])
        );
        return;
      }
    }

    const promoEdit = adminPromoEditState.get(String(ctx.from.id));
    if (promoEdit) {
      const textRaw = getText(ctx).trim();
      if (!textRaw) {
        await ctx.reply("Send a value or /cancel.");
        return;
      }
      const id = promoEdit.promoId;
      if (promoEdit.field === "name") {
        const result = await updatePromoById(id, { promoName: textRaw });
        adminPromoEditState.delete(String(ctx.from.id));
        if (!result.ok) {
          await ctx.reply(result.error);
          return;
        }
        await ctx.reply("Name updated.");
        await sendPromoDetail(ctx.chat!.id, id);
        return;
      }
      if (promoEdit.field === "discount") {
        const pt = /^percent\s+(\d+(?:\.\d+)?)$/i.exec(textRaw);
        const ft = /^fixed\s+(\d+(?:\.\d+)?)$/i.exec(textRaw);
        if (!pt && !ft) {
          await ctx.reply("Use exactly one line, e.g.\npercent 15\nor\nfixed 99.5");
          return;
        }
        const discountType = pt ? "percent" : "fixed_total";
        const discountValue = Number(pt ? pt[1] : ft![1]);
        if (discountType === "percent" && (discountValue > 100 || discountValue <= 0)) {
          await ctx.reply("Percent must be between 1 and 100.");
          return;
        }
        if (discountType === "fixed_total" && discountValue <= 0) {
          await ctx.reply("Fixed amount must be positive.");
          return;
        }
        const result = await updatePromoById(id, { discountType, discountValue });
        adminPromoEditState.delete(String(ctx.from.id));
        if (!result.ok) {
          await ctx.reply(result.error);
          return;
        }
        await ctx.reply("Discount updated.");
        await sendPromoDetail(ctx.chat!.id, id);
        return;
      }
      if (promoEdit.field === "maxUses") {
        const tl = textRaw.toLowerCase();
        let maxUses: number | null;
        if (tl === "unlimited" || tl === "none" || tl === "skip") {
          maxUses = null;
        } else {
          const n = Number.parseInt(textRaw, 10);
          if (Number.isNaN(n) || n < 1) {
            await ctx.reply("Send a positive integer or unlimited.");
            return;
          }
          maxUses = n;
        }
        const result = await updatePromoById(id, { maxUses });
        adminPromoEditState.delete(String(ctx.from.id));
        if (!result.ok) {
          await ctx.reply(result.error);
          return;
        }
        await ctx.reply("Max uses updated.");
        await sendPromoDetail(ctx.chat!.id, id);
        return;
      }
      if (promoEdit.field === "event") {
        const parsed = parseEventIdOrGlobalForPromo(textRaw);
        if (!parsed.ok) {
          await ctx.reply("Send global or a valid event UUID.");
          return;
        }
        if (parsed.eventId) {
          const ev = await db.query.events.findFirst({ where: eq(events.id, parsed.eventId) });
          if (!ev) {
            await ctx.reply("Event not found.");
            return;
          }
        }
        const result = await updatePromoById(id, { eventId: parsed.eventId });
        adminPromoEditState.delete(String(ctx.from.id));
        if (!result.ok) {
          await ctx.reply(result.error);
          return;
        }
        await ctx.reply("Event scope updated.");
        await sendPromoDetail(ctx.chat!.id, id);
        return;
      }
      const tl = textRaw.toLowerCase();
      let iso: string | null;
      if (tl === "skip" || tl === "none" || tl === "-") {
        iso = null;
      } else if (Number.isNaN(Date.parse(textRaw))) {
        await ctx.reply("Invalid date. Send ISO datetime or skip.");
        return;
      } else {
        iso = textRaw;
      }
      const patch =
        promoEdit.field === "validFrom"
          ? ({ validFrom: iso } as const)
          : ({ validUntil: iso } as const);
      const result = await updatePromoById(id, patch);
      adminPromoEditState.delete(String(ctx.from.id));
      if (!result.ok) {
        await ctx.reply(result.error);
        return;
      }
      await ctx.reply("Saved.");
      await sendPromoDetail(ctx.chat!.id, id);
      return;
    }

    const promoCreate = adminPromoCreateState.get(String(ctx.from.id));
    if (promoCreate) {
      if (promoCreate.step === "dtype") {
        await ctx.reply("Tap Percent or Fixed on the keyboard above.");
        return;
      }
      const text = getText(ctx).trim();
      if (!text) {
        await ctx.reply("Send a value or /cancel.");
        return;
      }
      if (promoCreate.step === "name") {
        promoCreate.name = text.slice(0, 200);
        promoCreate.step = "count";
        await ctx.reply(`Step 2: how many codes? (1–${MAX_PROMOS_PER_REQUEST})`);
        return;
      }
      if (promoCreate.step === "count") {
        const n = Number.parseInt(text, 10);
        if (Number.isNaN(n) || n < 1 || n > MAX_PROMOS_PER_REQUEST) {
          await ctx.reply(`Send an integer from 1 to ${MAX_PROMOS_PER_REQUEST}.`);
          return;
        }
        promoCreate.count = n;
        promoCreate.step = "event";
        await ctx.reply("Step 3: scope — send event UUID, or global");
        return;
      }
      if (promoCreate.step === "event") {
        const parsed = parseEventIdOrGlobalForPromo(text);
        if (!parsed.ok) {
          await ctx.reply("Send global or a valid event UUID.");
          return;
        }
        if (parsed.eventId) {
          const ev = await db.query.events.findFirst({ where: eq(events.id, parsed.eventId) });
          if (!ev) {
            await ctx.reply("Event not found.");
            return;
          }
        }
        promoCreate.eventId = parsed.eventId;
        promoCreate.step = "dtype";
        await ctx.reply(
          "Step 4: discount type.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback("Percent off", telegramCallbackData("pm_ct:p")),
              Markup.button.callback("Fixed ETB off order", telegramCallbackData("pm_ct:f"))
            ]
          ])
        );
        return;
      }
      if (promoCreate.step === "dvalue") {
        const dv = Number(text);
        if (!Number.isFinite(dv) || dv <= 0) {
          await ctx.reply("Send a positive number.");
          return;
        }
        if (promoCreate.discountType === "percent" && dv > 100) {
          await ctx.reply("Percent cannot exceed 100.");
          return;
        }
        promoCreate.discountValue = dv;
        promoCreate.step = "maxUses";
        await ctx.reply("Step 5: max uses per code — integer, or unlimited");
        return;
      }
      if (promoCreate.step === "maxUses") {
        const tl = text.toLowerCase();
        if (tl === "unlimited" || tl === "none" || tl === "skip") {
          promoCreate.maxUses = null;
        } else {
          const n = Number.parseInt(text, 10);
          if (Number.isNaN(n) || n < 1) {
            await ctx.reply("Send a positive integer or unlimited.");
            return;
          }
          promoCreate.maxUses = n;
        }
        promoCreate.step = "validFrom";
        await ctx.reply("Step 6: valid from — ISO datetime, or skip");
        return;
      }
      if (promoCreate.step === "validFrom") {
        const tl = text.toLowerCase();
        if (tl === "skip" || tl === "none" || tl === "-") {
          promoCreate.validFrom = null;
        } else if (Number.isNaN(Date.parse(text))) {
          await ctx.reply("Invalid date. ISO datetime or skip.");
          return;
        } else {
          promoCreate.validFrom = text;
        }
        promoCreate.step = "validUntil";
        await ctx.reply("Step 7: valid until — ISO datetime, or skip");
        return;
      }
      if (promoCreate.step === "validUntil") {
        const tl = text.toLowerCase();
        if (tl === "skip" || tl === "none" || tl === "-") {
          promoCreate.validUntil = null;
        } else if (Number.isNaN(Date.parse(text))) {
          await ctx.reply("Invalid date. ISO datetime or skip.");
          return;
        } else {
          promoCreate.validUntil = text;
        }
        const uid = String(ctx.from.id);
        const result = await createPromoBatch({
          promoName: promoCreate.name!,
          count: promoCreate.count!,
          eventId: promoCreate.eventId,
          discountType: promoCreate.discountType!,
          discountValue: promoCreate.discountValue!,
          maxUses: promoCreate.maxUses,
          validFrom: promoCreate.validFrom,
          validUntil: promoCreate.validUntil,
          active: true
        });
        adminPromoCreateState.delete(uid);
        if (!result.ok) {
          await ctx.reply(`Could not create: ${result.error}`);
          return;
        }
        const codesPreview = result.rows
          .slice(0, 12)
          .map((r) => r.code)
          .join(", ");
        const more = result.rows.length > 12 ? `\n… and ${result.rows.length - 12} more.` : "";
        await ctx.reply(
          `Created ${result.rows.length} code(s).\n${codesPreview}${more}\n\nAdmin menu → Promo codes → Browse recent for the list.`
        );
        return;
      }
      await ctx.reply("Unknown step. /cancel");
      return;
    }

    const state = adminCreateState.get(String(ctx.from.id));
    const tierState = adminTierAddState.get(String(ctx.from.id));
    const editState = adminEditState.get(String(ctx.from.id));
    const tierEditState = adminTierEditState.get(String(ctx.from.id));
    if (!state && !tierState && !editState && !tierEditState) {
      await next();
      return;
    }
    const text = getText(ctx).trim();
    if (!text) {
      await ctx.reply("Please send text value.");
      return;
    }

    if (tierState) {
      if (tierState.step === "tierCode") {
        tierState.draftTier.tierCode = text.toLowerCase();
        tierState.step = "tierName";
        await ctx.reply("Step B: send tier name.");
        return;
      }
      if (tierState.step === "tierName") {
        tierState.draftTier.tierName = text;
        tierState.step = "tierPrice";
        await ctx.reply("Step C: send tier price.");
        return;
      }
      if (tierState.step === "tierPrice") {
        const price = Number(text);
        if (Number.isNaN(price) || price <= 0) {
          await ctx.reply("Invalid price. Send positive number.");
          return;
        }
        tierState.draftTier.price = price;
        tierState.step = "earlyBirdPrice";
        await ctx.reply("Step D: early bird unit price (ETB), or type skip.");
        return;
      }
      if (tierState.step === "earlyBirdPrice") {
        if (text.toLowerCase() === "skip") {
          delete tierState.draftTier.earlyBirdPrice;
          delete tierState.draftTier.earlyBirdEndsAt;
          tierState.step = "tierCapacity";
          await ctx.reply("Step F: send capacity or type skip.");
          return;
        }
        const ebp = Number(text);
        if (Number.isNaN(ebp) || ebp <= 0) {
          await ctx.reply("Invalid early bird price. Send a positive number or skip.");
          return;
        }
        tierState.draftTier.earlyBirdPrice = ebp;
        tierState.step = "earlyBirdEnds";
        await ctx.reply("Step E: early bird ends at — send ISO datetime (e.g. 2026-06-01T17:00:00Z).");
        return;
      }
      if (tierState.step === "earlyBirdEnds") {
        if (Number.isNaN(Date.parse(text))) {
          await ctx.reply("Invalid date. Send ISO datetime.");
          return;
        }
        tierState.draftTier.earlyBirdEndsAt = text;
        tierState.step = "tierCapacity";
        await ctx.reply("Step F: send capacity or type skip.");
        return;
      }
      const capacity = text.toLowerCase() === "skip" ? null : Number(text);
      if (capacity !== null && (Number.isNaN(capacity) || capacity <= 0)) {
        await ctx.reply("Invalid capacity. Send positive number or skip.");
        return;
      }
      if (!tierState.draftTier.tierCode || !tierState.draftTier.tierName || !tierState.draftTier.price) {
        await ctx.reply("Tier draft invalid. /cancel and retry.");
        return;
      }
      await db.insert(eventTiers).values({
        eventId: tierState.eventId,
        tierCode: tierState.draftTier.tierCode,
        tierName: tierState.draftTier.tierName,
        price: tierState.draftTier.price.toFixed(2),
        earlyBirdPrice:
          tierState.draftTier.earlyBirdPrice != null
            ? tierState.draftTier.earlyBirdPrice.toFixed(2)
            : undefined,
        earlyBirdEndsAt: tierState.draftTier.earlyBirdEndsAt
          ? new Date(tierState.draftTier.earlyBirdEndsAt)
          : undefined,
        capacity,
        active: true
      });
      adminTierAddState.delete(String(ctx.from.id));
      await ctx.reply("Tier added.");
      await sendEventDetail(ctx.chat!.id, tierState.eventId);
      return;
    }

    if (editState) {
      if (editState.field === "featured") {
        const t = text.toLowerCase();
        const yes = ["yes", "y", "true", "1"].includes(t);
        const no = ["no", "n", "false", "0"].includes(t);
        if (!yes && !no) {
          await ctx.reply("Send yes or no.");
          return;
        }
        await db
          .update(events)
          .set({ featured: yes, updatedAt: new Date() })
          .where(eq(events.id, editState.eventId));
        adminEditState.delete(String(ctx.from.id));
        await ctx.reply(`Featured set to ${yes ? "on" : "off"}.`);
        await sendEventDetail(ctx.chat!.id, editState.eventId);
        return;
      }
      if (editState.field === "category") {
        const cat = parseEventCategory(text);
        if (!cat) {
          await ctx.reply(`Invalid category. Send one of: ${EVENT_CATEGORIES.join(", ")}`);
          return;
        }
        await db
          .update(events)
          .set({ category: cat, updatedAt: new Date() })
          .where(eq(events.id, editState.eventId));
        adminEditState.delete(String(ctx.from.id));
        await ctx.reply("Event updated.");
        await sendEventDetail(ctx.chat!.id, editState.eventId);
        return;
      }
      const value =
        editState.field === "eventImageUrl" || editState.field === "ticketTemplateImageUrl"
          ? text.toLowerCase() === "skip"
            ? null
            : text
          : text;
      if ((editState.field === "startsAt" || editState.field === "endsAt") && Number.isNaN(Date.parse(text))) {
        await ctx.reply("Invalid date. Send ISO date.");
        return;
      }
      const statusNorm = editState.field === "status" ? text.trim().toLowerCase() : text;
      if (editState.field === "status" && !["draft", "published", "closed"].includes(statusNorm)) {
        await ctx.reply("Status must be draft, published, or closed.");
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (editState.field === "startsAt" || editState.field === "endsAt") {
        patch[editState.field] = new Date(text);
      } else if (editState.field === "status") {
        patch.status = statusNorm;
      } else {
        patch[editState.field] = value;
      }
      const prevRow = await db.query.events.findFirst({
        where: eq(events.id, editState.eventId),
        columns: { status: true }
      });
      await db.update(events).set(patch).where(eq(events.id, editState.eventId));
      adminEditState.delete(String(ctx.from.id));
      await ctx.reply("Event updated.");
      await sendEventDetail(ctx.chat!.id, editState.eventId);
      if (editState.field === "status" && statusNorm === "published" && prevRow?.status !== "published") {
        scheduleChannelAnnounceWhenNewlyPublished(editState.eventId, prevRow?.status);
      }
      return;
    }

    if (tierEditState) {
      const tier = await db.query.eventTiers.findFirst({
        where: and(eq(eventTiers.id, tierEditState.tierId), eq(eventTiers.eventId, tierEditState.eventId))
      });
      if (!tier) {
        adminTierEditState.delete(String(ctx.from.id));
        await ctx.reply("Tier not found.");
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (tierEditState.field === "price") {
        const price = Number(text);
        if (Number.isNaN(price) || price <= 0) {
          await ctx.reply("Invalid price. Send positive number.");
          return;
        }
        patch.price = price.toFixed(2);
      } else if (tierEditState.field === "capacity") {
        const cap = text.toLowerCase() === "skip" ? null : Number(text);
        if (cap !== null && (Number.isNaN(cap) || cap <= 0)) {
          await ctx.reply("Invalid capacity. Send positive number or skip.");
          return;
        }
        patch.capacity = cap;
      } else if (tierEditState.field === "earlyBirdPrice") {
        if (text.toLowerCase() === "skip") {
          patch.earlyBirdPrice = null;
        } else {
          const ebp = Number(text);
          if (Number.isNaN(ebp) || ebp <= 0) {
            await ctx.reply("Invalid early bird price. Send a positive number or skip.");
            return;
          }
          patch.earlyBirdPrice = ebp.toFixed(2);
        }
      } else if (tierEditState.field === "earlyBirdEndsAt") {
        if (text.toLowerCase() === "skip") {
          patch.earlyBirdEndsAt = null;
        } else if (Number.isNaN(Date.parse(text))) {
          await ctx.reply("Invalid date. Send ISO datetime or skip.");
          return;
        } else {
          patch.earlyBirdEndsAt = new Date(text);
        }
      } else if (tierEditState.field === "tierCode") {
        patch.tierCode = text.toLowerCase();
      } else {
        patch.tierName = text;
      }
      await db.update(eventTiers).set(patch).where(eq(eventTiers.id, tier.id));
      adminTierEditState.delete(String(ctx.from.id));
      await ctx.reply("Tier updated.");
      await sendEventDetail(ctx.chat!.id, tierEditState.eventId);
      return;
    }

    if (!state) {
      await next();
      return;
    }

    if (state.step === "name") {
      state.name = text;
      state.step = "startsAt";
      await ctx.reply("Step 2/12: send start date in ISO format (example 2026-12-31T17:00:00Z).");
      return;
    }
    if (state.step === "startsAt") {
      if (Number.isNaN(Date.parse(text))) {
        await ctx.reply("Invalid date format. Send ISO date.");
        return;
      }
      state.startsAt = text;
      state.step = "endsAt";
      await ctx.reply("Step 3/12: send end date in ISO format.");
      return;
    }
    if (state.step === "endsAt") {
      if (Number.isNaN(Date.parse(text))) {
        await ctx.reply("Invalid date format. Send ISO date.");
        return;
      }
      state.endsAt = text;
      state.step = "location";
      await ctx.reply("Step 4/12: send location.");
      return;
    }
    if (state.step === "location") {
      state.location = text;
      state.step = "description";
      await ctx.reply("Step 5/12: send description.");
      return;
    }
    if (state.step === "description") {
      state.description = text;
      state.step = "category";
      await ctx.reply(
        `Step 6/12: send category. One of: ${EVENT_CATEGORIES.join(", ")} (default if unsure: Music).`
      );
      return;
    }
    if (state.step === "category") {
      const cat = parseEventCategory(text);
      if (!cat) {
        await ctx.reply(`Invalid category. Send one of: ${EVENT_CATEGORIES.join(", ")}`);
        return;
      }
      state.category = cat;
      state.step = "eventImageUrl";
      await ctx.reply("Step 7/12: send event image URL, upload a photo, or type skip.");
      return;
    }
    if (state.step === "eventImageUrl") {
      state.eventImageUrl = text.toLowerCase() === "skip" ? undefined : text;
      state.step = "ticketTemplateImageUrl";
      await ctx.reply("Step 8/12: send ticket template image URL, upload a photo, or type skip.");
      return;
    }
    if (state.step === "ticketTemplateImageUrl") {
      state.ticketTemplateImageUrl = text.toLowerCase() === "skip" ? undefined : text;
      state.step = "featuredAsk";
      await ctx.reply(
        "Step 9/12: feature this event (shown first in Browse + /events)? Send yes or no."
      );
      return;
    }
    if (state.step === "featuredAsk") {
      const t = text.toLowerCase();
      const yes = ["yes", "y", "true", "1"].includes(t);
      const no = ["no", "n", "false", "0"].includes(t);
      if (!yes && !no) {
        await ctx.reply("Send yes or no.");
        return;
      }
      state.featured = yes;
      state.step = "tierAsk";
      await ctx.reply("Step 10/12: add a tier now? reply yes or no.");
      return;
    }
    if (state.step === "tierAsk") {
      if (text.toLowerCase() === "yes") {
        state.draftTier = {};
        state.step = "tierCode";
        await ctx.reply("Tier step A: send tier code (vip, standard, vvip).");
        return;
      }
      if (text.toLowerCase() !== "no") {
        await ctx.reply("Reply yes or no.");
        return;
      }
      if (!state.tiers.length) {
        await ctx.reply("At least one tier is required. Reply yes to add tier.");
        return;
      }
      state.step = "confirm";
      const preview = `Preview:\nName: ${state.name}\nStart: ${state.startsAt}\nEnd: ${state.endsAt}\nLocation: ${state.location ?? "-"}\nDescription: ${state.description ?? "-"}\nCategory: ${state.category ?? DEFAULT_EVENT_CATEGORY}\nFeatured: ${state.featured ? "yes" : "no"}\nEvent image: ${state.eventImageUrl ?? "-"}\nTicket template image: ${state.ticketTemplateImageUrl ?? "-"}\nTiers:\n${state.tiers
        .map((tier) => {
          const eb =
            tier.earlyBirdPrice != null && tier.earlyBirdEndsAt
              ? ` early ${tier.earlyBirdPrice} until ${tier.earlyBirdEndsAt} ·`
              : "";
          return `- ${tier.tierName} (${tier.tierCode})${eb} door ETB ${tier.price} cap ${tier.capacity ?? "unlimited"}`;
        })
        .join("\n")}`;
      await ctx.reply(preview);
      await ctx.reply("Step 11/12: type confirm to create event, or /cancel.");
      return;
    }
    if (state.step === "tierCode") {
      state.draftTier = { ...(state.draftTier ?? {}), tierCode: text.toLowerCase() };
      state.step = "tierName";
      await ctx.reply("Tier step B: send tier display name.");
      return;
    }
    if (state.step === "tierName") {
      state.draftTier = { ...(state.draftTier ?? {}), tierName: text };
      state.step = "tierPrice";
      await ctx.reply("Tier step C: send price number (example 3000).");
      return;
    }
    if (state.step === "tierPrice") {
      const price = Number(text);
      if (Number.isNaN(price) || price <= 0) {
        await ctx.reply("Invalid price. Send a positive number.");
        return;
      }
      state.draftTier = { ...(state.draftTier ?? {}), price };
      state.step = "earlyBirdPrice";
      await ctx.reply("Tier step D: early bird unit price (ETB), or type skip.");
      return;
    }
    if (state.step === "earlyBirdPrice") {
      if (text.toLowerCase() === "skip") {
        const d = { ...(state.draftTier ?? {}) };
        delete d.earlyBirdPrice;
        delete d.earlyBirdEndsAt;
        state.draftTier = d;
        state.step = "tierCapacity";
        await ctx.reply("Tier step F: send capacity number, or type skip.");
        return;
      }
      const ebp = Number(text);
      if (Number.isNaN(ebp) || ebp <= 0) {
        await ctx.reply("Invalid early bird price. Send a positive number or skip.");
        return;
      }
      state.draftTier = { ...(state.draftTier ?? {}), earlyBirdPrice: ebp };
      state.step = "earlyBirdEnds";
      await ctx.reply("Tier step E: early bird ends at — send ISO datetime.");
      return;
    }
    if (state.step === "earlyBirdEnds") {
      if (Number.isNaN(Date.parse(text))) {
        await ctx.reply("Invalid date. Send ISO datetime.");
        return;
      }
      state.draftTier = { ...(state.draftTier ?? {}), earlyBirdEndsAt: text };
      state.step = "tierCapacity";
      await ctx.reply("Tier step F: send capacity number, or type skip.");
      return;
    }
    if (state.step === "tierCapacity") {
      const capacity = text.toLowerCase() === "skip" ? null : Number(text);
      if (capacity !== null && (Number.isNaN(capacity) || capacity <= 0)) {
        await ctx.reply("Invalid capacity. Send positive number or skip.");
        return;
      }
      const draft = state.draftTier;
      if (!draft?.tierCode || !draft.tierName || !draft.price) {
        await ctx.reply("Tier draft incomplete. Restart with /cancel then /adminmenu.");
        return;
      }
      state.tiers.push({
        tierCode: draft.tierCode,
        tierName: draft.tierName,
        price: draft.price,
        capacity
      });
      state.draftTier = undefined;
      state.step = "tierAsk";
      await ctx.reply("Tier added. Add another tier? reply yes or no.");
      return;
    }
    if (state.step === "confirm") {
      if (text.toLowerCase() !== "confirm") {
        await ctx.reply("Type confirm to finish, or /cancel.");
        return;
      }
      if (!state.name || !state.startsAt || !state.endsAt) {
        await ctx.reply("Draft missing required fields. Cancel and restart.");
        return;
      }
      const eventName = state.name;
      const startsAtIso = state.startsAt;
      const endsAtIso = state.endsAt;
      const created = await db.transaction(async (tx) => {
        const [eventRow] = await tx
          .insert(events)
          .values({
            name: eventName,
            startsAt: new Date(startsAtIso),
            endsAt: new Date(endsAtIso),
            location: state.location,
            description: state.description,
            category: state.category ?? DEFAULT_EVENT_CATEGORY,
            featured: state.featured ?? false,
            eventImageUrl: state.eventImageUrl,
            ticketTemplateImageUrl: state.ticketTemplateImageUrl,
            status: "published"
          })
          .returning();
        await tx.insert(eventTiers).values(
          state.tiers.map((tier) => ({
            eventId: eventRow.id,
            tierCode: tier.tierCode,
            tierName: tier.tierName,
            price: tier.price.toFixed(2),
            earlyBirdPrice:
              tier.earlyBirdPrice != null ? tier.earlyBirdPrice.toFixed(2) : undefined,
            earlyBirdEndsAt: tier.earlyBirdEndsAt ? new Date(tier.earlyBirdEndsAt) : undefined,
            capacity: tier.capacity,
            active: true
          }))
        );
        return eventRow;
      });
      adminCreateState.delete(String(ctx.from.id));
      await ctx.reply(`Event created successfully.\nID: ${created.id}\nName: ${created.name}`);
      scheduleChannelAnnounceWhenNewlyPublished(created.id, undefined);
      return;
    }
  });

  adminBot.on("photo", async (ctx, next) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await next();
      return;
    }
    const state = adminCreateState.get(String(ctx.from.id));
    const editState = adminEditState.get(String(ctx.from.id));
    if (!state) {
      if (!editState) {
        await next();
        return;
      }
    }
    if (editState && (editState.field === "eventImageUrl" || editState.field === "ticketTemplateImageUrl")) {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      if (!best) {
        await ctx.reply("Could not read photo. Try again.");
        return;
      }
      const fileUrl = (await ctx.telegram.getFileLink(best.file_id)).toString();
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      patch[editState.field] = fileUrl;
      await db.update(events).set(patch).where(eq(events.id, editState.eventId));
      adminEditState.delete(String(ctx.from.id));
      await ctx.reply("Event image updated from uploaded photo.");
      await sendEventDetail(ctx.chat!.id, editState.eventId);
      return;
    }
    if (!state || (state.step !== "eventImageUrl" && state.step !== "ticketTemplateImageUrl")) {
      await ctx.reply("Photo received, but wizard is not currently asking for an image.");
      return;
    }

    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    if (!best) {
      await ctx.reply("Could not read photo. Try again.");
      return;
    }
    const fileUrl = (await ctx.telegram.getFileLink(best.file_id)).toString();

    if (state.step === "eventImageUrl") {
      state.eventImageUrl = fileUrl;
      state.step = "ticketTemplateImageUrl";
      await ctx.reply("Event image saved from Telegram upload.");
      await ctx.reply("Step 8/12: now send ticket template image URL, upload a photo, or type skip.");
      return;
    }

    state.ticketTemplateImageUrl = fileUrl;
    state.step = "featuredAsk";
    await ctx.reply("Ticket template image saved from Telegram upload.");
    await ctx.reply("Step 9/12: feature this event? Send yes or no.");
  });
}

if (config.telegramUserBotToken) {
  userBot = new Telegraf(config.telegramUserBotToken);

  userBot.action("p_ok", async (ctx) => {
    await ctx.answerCbQuery();
    const from = ctx.from;
    if (!from) return;
    await db
      .insert(privacyAcceptances)
      .values({
        telegramUserId: String(from.id),
        policyVersion: config.privacyPolicyVersion,
        acceptedAt: new Date()
      })
      .onConflictDoUpdate({
        target: privacyAcceptances.telegramUserId,
        set: {
          policyVersion: config.privacyPolicyVersion,
          acceptedAt: new Date()
        }
      });
    await ctx.reply(
      "Thank you. You can browse events, submit receipts, and claim tickets.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Browse Events", telegramCallbackData("user_buy"))],
        [Markup.button.callback("Submit Receipt Help", telegramCallbackData("user_submit_help"))],
        [Markup.button.callback("Claim Ticket Help", telegramCallbackData("user_claim_help"))],
        [Markup.button.callback("My Tickets", telegramCallbackData("user_myticket"))]
      ])
    );
  });

  const userMenu = Markup.inlineKeyboard([
    [Markup.button.callback("Browse Events", telegramCallbackData("user_buy"))],
    [Markup.button.callback("Submit Receipt Help", telegramCallbackData("user_submit_help"))],
    [Markup.button.callback("Claim Ticket Help", telegramCallbackData("user_claim_help"))],
    [Markup.button.callback("My Tickets", telegramCallbackData("user_myticket"))]
  ]);

  async function replyPublishedSingleEventForBuy(ctx: Context, eventId: string): Promise<void> {
    const eventItem = await db.query.events.findFirst({
      where: and(eq(events.id, eventId), eq(events.status, "published"))
    });
    if (!eventItem) {
      await ctx.reply("This event is not available for booking right now. Try /buy to see published events.", userMenu);
      return;
    }
    const tierRows = await db.query.eventTiers.findMany({
      where: and(eq(eventTiers.eventId, eventId), eq(eventTiers.active, true)),
      orderBy: [eventTiers.tierName]
    });
    const block = formatBrowseEventBlock(eventItem, tierRows);
    await ctx.reply(`*${escapeMarkdownV2("Book this event")}*\n\n${block}`, { parse_mode: "MarkdownV2" });
  }

  function orderRefFromDeepLink(ctx: Context): string | undefined {
    const p = (ctx as Context & { startPayload?: string }).startPayload?.trim();
    if (p) {
      try {
        return decodeURIComponent(p).trim();
      } catch {
        return p;
      }
    }
    const text = ctx.message && "text" in ctx.message ? String(ctx.message.text ?? "") : "";
    const m = /^\/start(?:@\w+)?\s+(\S+)/i.exec(text.trim());
    return m ? m[1].trim() : undefined;
  }

  async function replyWithIssuedTickets(
    ctx: Context,
    orderRef: string,
    ticketRows: Awaited<ReturnType<typeof issueTicketsForApprovedOrder>>["tickets"],
    totalQty: number,
    mode: "newOnly" | "allExisting" = "newOnly"
  ) {
    if (ticketRows.length === 0) {
      return;
    }
    const baseIndex = mode === "allExisting" ? 0 : totalQty - ticketRows.length;
    for (let i = 0; i < ticketRows.length; i++) {
      const ticket = ticketRows[i]!;
      const caption =
        totalQty > 1
          ? `Ticket ${baseIndex + i + 1}/${totalQty} for order ${orderRef}. Each QR can be used once.`
          : `Ticket issued for order ${orderRef}. This QR can be used once.`;
      await ctx.replyWithPhoto(
        { source: Buffer.from(ticket.qrImageDataUrl.split(",")[1], "base64") },
        { caption }
      );
    }
  }

  const fewerTicketsThanOrdered = sql`(SELECT COUNT(*)::int FROM ${tickets} WHERE ${tickets.orderId} = ${orders.id}) < ${orders.quantity}`;

  /**
   * Approved + paid (Telebirr) but order still has no Telegram link and no ticket yet — e.g. receipt submitted via web API.
   * If exactly one such order exists globally, link this chat (ctx.from.id) and issue the ticket.
   * If several exist, user must /claim with order ref (avoids wrong account grabbing someone else's ticket).
   */
  async function tryLinkChatAndClaimSingleUnlinkedApprovedOrder(ctx: Context): Promise<boolean> {
    const tgId = String(ctx.from?.id ?? "");
    if (!tgId) return false;

    const unlinked = await db
      .select({ orderRef: orders.orderRef })
      .from(orders)
      .leftJoin(tickets, eq(tickets.orderId, orders.id))
      .where(and(eq(orders.status, "approved"), isNull(orders.telegramUserId), isNull(tickets.id)));

    if (unlinked.length === 0) return false;
    if (unlinked.length > 1) {
      await ctx.reply(
        [
          "More than one order is waiting to be linked to Telegram.",
          "Use: /claim YOUR_ORDER_REF",
          "(Copy the order reference from your payment or confirmation page.)"
        ].join("\n")
      );
      return true;
    }

    const orderRef = unlinked[0]!.orderRef;
    await db.update(orders).set({ telegramUserId: tgId, updatedAt: new Date() }).where(eq(orders.orderRef, orderRef));
    try {
      const issued = await issueTicketsForApprovedOrder(orderRef, tgId, {
        telegramUsername: ctx.from?.username
      });
      const q = issued.tickets.length;
      await replyWithIssuedTickets(ctx, orderRef, issued.newlyIssued, q);
      return true;
    } catch (e) {
      await ctx.reply(e instanceof Error ? e.message : "Could not issue ticket yet.");
      return true;
    }
  }

  async function tryAutoClaimApprovedWithoutTicket(ctx: Context): Promise<boolean> {
    const tgId = String(ctx.from?.id ?? "");
    if (!tgId) return false;
    const row = await db
      .select({ orderRef: orders.orderRef })
      .from(orders)
      .where(
        and(
          eq(orders.telegramUserId, tgId),
          or(eq(orders.status, "approved"), eq(orders.status, "ticket_issued")),
          fewerTicketsThanOrdered
        )
      )
      .limit(1);
    const first = row[0];
    if (!first) return false;
    try {
      const issued = await issueTicketsForApprovedOrder(first.orderRef, tgId, {
        telegramUsername: ctx.from?.username
      });
      const q = issued.tickets.length;
      await replyWithIssuedTickets(ctx, first.orderRef, issued.newlyIssued, q);
      return true;
    } catch {
      return false;
    }
  }

  userBot.start(async (ctx) => {
    if (!ctx.from) {
      await ctx.reply("Could not resolve your Telegram account.");
      return;
    }
    const tgId = String(ctx.from.id);
    if (!(await privacyAcceptedForUserBot(tgId))) {
      await replyUserBotPrivacyGate(ctx);
      return;
    }
    const rawStart = orderRefFromDeepLink(ctx);
    if (rawStart?.toLowerCase().startsWith("buy_")) {
      const eventId = rawStart.slice(4).trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
        await replyPublishedSingleEventForBuy(ctx, eventId);
        return;
      }
      await ctx.reply("This event link is not valid. Try /buy to see current events.", userMenu);
      return;
    }
    const deepRef = rawStart;
    if (deepRef) {
      await db.update(orders).set({ telegramUserId: tgId, updatedAt: new Date() }).where(eq(orders.orderRef, deepRef));
      try {
        const issued = await issueTicketsForApprovedOrder(deepRef, tgId, {
          telegramUsername: ctx.from?.username
        });
        const q = issued.tickets.length;
        await replyWithIssuedTickets(ctx, deepRef, issued.newlyIssued, q);
        return;
      } catch (e) {
        await ctx.reply(e instanceof Error ? e.message : "Could not issue ticket yet.");
        return;
      }
    }
    if (await tryLinkChatAndClaimSingleUnlinkedApprovedOrder(ctx)) {
      return;
    }
    if (await tryAutoClaimApprovedWithoutTicket(ctx)) {
      return;
    }
    await ctx.reply(
      "Welcome. Use /menu for shortcuts.\n\nIf you paid on the web and your payment is already verified, tap /start again after approval or use /claim YOUR_ORDER_REF. If you submit a receipt from this chat, your account is linked automatically.",
      userMenu
    );
  });

  userBot.command("menu", async (ctx) => {
    if (!ctx.from || !(await privacyAcceptedForUserBot(String(ctx.from.id)))) {
      await replyUserBotPrivacyGate(ctx);
      return;
    }
    await ctx.reply("User quick actions:", userMenu);
  });

  userBot.command("privacy", async (ctx) => {
    await replyUserBotPrivacyGate(ctx);
  });

  userBot.action("user_buy", async (ctx) => {
    await ctx.answerCbQuery();
    await replyPublishedEventsBrowse(ctx);
  });

  userBot.action("user_submit_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Use:\n/submit ORDER_REF RECEIPT_NO\nExample:\n/submit ORD-ABCD12 129393939");
  });

  userBot.action("user_claim_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "Use:\n/claim ORDER_REF\nExample:\n/claim ORD-ABCD12\n\nAfter approval, this sends your QR ticket image(s). Run it again if the photos never arrived. If it still fails, ask the organizer for help."
    );
  });

  userBot.action("user_myticket", async (ctx) => {
    await ctx.answerCbQuery();
    await replyMyTicketsPage(ctx);
  });

  userBot.command("browse", async (ctx) => {
    await replyPublishedEventsBrowse(ctx);
  });

  userBot.command("mytickets", async (ctx) => {
    await replyMyTicketsPage(ctx);
  });

  userBot.command("buy", async (ctx) => {
    await replyPublishedEventsBrowse(ctx);
  });

  userBot.command("submit", async (ctx) => {
    if (!ctx.from || !(await privacyAcceptedForUserBot(String(ctx.from.id)))) {
      await replyUserBotPrivacyGate(ctx);
      return;
    }
    const args = getArgs(getText(ctx));
    const orderRef = args[0]?.trim();
    const receiptNo = args[1]?.trim() ?? "";
    if (!orderRef || receiptNo.length < 6) {
      await ctx.reply("Usage: /submit ORDER_REF RECEIPT_NO");
      return;
    }
    const order = await db.query.orders.findFirst({ where: eq(orders.orderRef, orderRef) });
    if (!order) {
      await ctx.reply("Order not found.");
      return;
    }
    await db
      .update(orders)
      .set({ telegramUserId: String(ctx.from!.id), updatedAt: new Date() })
      .where(eq(orders.id, order.id));
    const existingReceipt = await db.query.receiptSubmissions.findFirst({
      where: eq(receiptSubmissions.receiptNo, receiptNo)
    });
    if (existingReceipt) {
      await ctx.reply(
        "This Telebirr receipt was already used. Each receipt can only be submitted once — you cannot reuse it for another order after getting a ticket (or while it is tied to an existing submission)."
      );
      return;
    }
    const verifyResult = await resolveReceiptVerification({
      receiptNo,
      expectedAmount: Number(order.expectedAmount),
      receiverNumber: config.telebirrReceiver,
      receiverName: config.telebirrReceiverName
    });
    logReceiptVerify("telegram_submit_verifier_done", {
      orderRef,
      orderId: order.id,
      verifyOk: verifyResult.ok,
      mode: verifyResult.mode,
      notes: verifyResult.notes.slice(0, 400)
    });

    const [inserted] = await db
      .insert(receiptSubmissions)
      .values({
        orderId: order.id,
        receiptNo,
        receiptUrl: buildReceiptUrl(receiptNo),
        verificationStatus: "verifying",
        verificationNotes: verifyResult.notes
      })
      .returning();
    await db.update(orders).set({ status: "verifying", updatedAt: new Date() }).where(eq(orders.id, order.id));

    let autoApproved = false;
    if (verifyResult.ok) {
      const approved = await approveReceiptSubmission({
        receiptId: inserted.id,
        verifiedBy: "telebirr_verify_api",
        verificationNotes: verifyResult.notes,
        auditMetadata: { orderId: order.id, source: "telebirr_verify_api", channel: "telegram" }
      });
      autoApproved = approved.ok;
      logReceiptVerify("telegram_submit_auto_approve_db", {
        orderRef,
        receiptSubmissionId: inserted.id,
        approveOk: approved.ok,
        ...(!approved.ok && "error" in approved ? { approveError: approved.error } : {})
      });
    }

    if (autoApproved) {
      try {
        const issued = await issueTicketsForApprovedOrder(orderRef, String(ctx.from!.id), {
          telegramUsername: ctx.from?.username
        });
        const q = issued.tickets.length;
        logReceiptVerify("telegram_submit_qr_ok", {
          orderRef,
          ticketIds: issued.newlyIssued.map((t) => t.id)
        });
        await replyWithIssuedTickets(ctx, orderRef, issued.newlyIssued, q);
        return;
      } catch (err) {
        logReceiptVerify("telegram_submit_qr_fail", {
          orderRef,
          error: err instanceof Error ? err.message : String(err)
        });
        await ctx.reply(
          [
            "Receipt auto-verified, but the QR could not be issued yet. Try: /claim " + orderRef,
            "If that still fails, ask an organizer to run /resendtickets " + orderRef + " from the admin bot.",
            "",
            verifyResult.notes
          ].join("\n")
        );
        return;
      }
    }

    await ctx.reply(
      [
        "Receipt received and queued for admin verification.",
        `Order: ${orderRef}`,
        `Receipt: ${receiptNo}`,
        `Receipt link: ${buildReceiptUrl(receiptNo)}`,
        "",
        "Next steps:",
        "1) Check progress: /status " + orderRef,
        "2) After approval: /claim " + orderRef + " or just send /start (your account is linked).",
        "",
        "If auto-verify is configured but failed, check VERIFY logs — amount must match and Telebirr `credited_party_name` must match TELEBIRR_RECEIVER_NAME (case-insensitive)."
      ].join("\n"),
      userMenu
    );
  });

  userBot.command("status", async (ctx) => {
    if (!ctx.from || !(await privacyAcceptedForUserBot(String(ctx.from.id)))) {
      await replyUserBotPrivacyGate(ctx);
      return;
    }
    const args = getArgs(getText(ctx));
    const orderRef = args[0];
    if (!orderRef) {
      await ctx.reply("Usage: /status ORDER_REF");
      return;
    }
    const order = await db.query.orders.findFirst({ where: eq(orders.orderRef, orderRef) });
    if (!order) {
      await ctx.reply("Order not found.");
      return;
    }
    await db
      .update(orders)
      .set({ telegramUserId: String(ctx.from!.id), updatedAt: new Date() })
      .where(eq(orders.id, order.id));
    const latestReceipt = await db.query.receiptSubmissions.findFirst({
      where: eq(receiptSubmissions.orderId, order.id),
      orderBy: [desc(receiptSubmissions.createdAt)]
    });
    const receiptLine = latestReceipt
      ? `Latest receipt: ${latestReceipt.receiptNo} (${latestReceipt.verificationStatus})`
      : "No receipt submitted yet for this order.";
    await ctx.reply(
      [
        `Order ${orderRef}`,
        `Order status: ${order.status}`,
        receiptLine,
        "",
        order.status === "approved" || order.status === "ticket_issued"
          ? "Get your ticket QR images in this chat: /claim " +
            orderRef +
            " (you can run it again if photos did not arrive)."
          : order.status === "verifying"
            ? "Waiting for admin to verify your receipt. Try again later with /status"
            : order.status === "rejected"
              ? "This order was rejected. If it was a mistake (wrong receipt number), ask the organizer to release it so you can submit again."
              : "Complete payment and submit receipt with /submit " + orderRef + " RECEIPT_NO"
      ].join("\n")
    );
  });

  userBot.command("claim", async (ctx) => {
    if (!ctx.from || !(await privacyAcceptedForUserBot(String(ctx.from.id)))) {
      await replyUserBotPrivacyGate(ctx);
      return;
    }
    const args = getArgs(getText(ctx));
    const orderRef = args[0];
    if (!orderRef) {
      await ctx.reply("Usage: /claim ORDER_REF");
      return;
    }
    await db
      .update(orders)
      .set({ telegramUserId: String(ctx.from!.id), updatedAt: new Date() })
      .where(eq(orders.orderRef, orderRef));
    try {
      const issued = await issueTicketsForApprovedOrder(orderRef, String(ctx.from.id), {
        telegramUsername: ctx.from?.username
      });
      const q = issued.tickets.length;
      if (issued.newlyIssued.length > 0) {
        await replyWithIssuedTickets(ctx, orderRef, issued.newlyIssued, q, "newOnly");
      } else if (issued.tickets.length > 0) {
        await replyWithIssuedTickets(ctx, orderRef, issued.tickets, q, "allExisting");
      } else {
        await ctx.reply("No tickets for this order yet. If payment was approved, try again later or contact support.");
      }
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Unable to claim ticket.");
    }
  });

  userBot.command("myticket", async (ctx) => {
    if (!ctx.from || !(await privacyAcceptedForUserBot(String(ctx.from.id)))) {
      await replyUserBotPrivacyGate(ctx);
      return;
    }
    const list = await db.query.tickets.findMany({
      where: eq(tickets.telegramUserId, String(ctx.from.id)),
      orderBy: [desc(tickets.createdAt)],
      limit: 5
    });
    if (!list.length) {
      await ctx.reply("No tickets found.");
      return;
    }
    await ctx.reply(list.map((item) => `ticketId=${item.id}\nstatus=${item.status}`).join("\n\n"));
  });
}

telegramRouter.post("/telegram/admin/webhook", async (req, res) => {
  if (!adminBot) {
    res.status(503).json({ error: "Telegram admin bot token is not configured." });
    return;
  }

  if (incomingWebhookSecret(req) !== config.telegramAdminWebhookSecret) {
    res.status(401).json({ error: "Invalid webhook secret." });
    return;
  }

  try {
    await adminBot.handleUpdate(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[telegram admin webhook]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "handler_error" });
  }
});

telegramRouter.post("/telegram/user/webhook", async (req, res) => {
  if (!userBot) {
    res.status(503).json({ error: "Telegram user bot token is not configured." });
    return;
  }

  if (incomingWebhookSecret(req) !== config.telegramUserWebhookSecret) {
    res.status(401).json({ error: "Invalid webhook secret." });
    return;
  }

  try {
    await userBot.handleUpdate(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[telegram user webhook]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "handler_error" });
  }
});

telegramRouter.post("/telegram/user/claim", async (req, res) => {
  const orderRef = String(req.body.orderRef ?? "");
  const telegramUserId = String(req.body.telegramUserId ?? "");
  const telegramUsernameRaw = req.body.telegramUsername;
  const telegramUsername =
    telegramUsernameRaw != null && String(telegramUsernameRaw).trim() !== ""
      ? String(telegramUsernameRaw).trim().replace(/^@/, "")
      : undefined;
  if (!orderRef || !telegramUserId) {
    res.status(400).json({ error: "orderRef and telegramUserId are required." });
    return;
  }

  try {
    const issued = await issueTicketsForApprovedOrder(orderRef, telegramUserId, { telegramUsername });
    res.json({ tickets: issued.tickets, ticket: issued.tickets[0] ?? null, newlyIssued: issued.newlyIssued });
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : "Claim failed." });
  }
});

telegramRouter.post("/telegram/setup-webhooks", async (req, res) => {
  const setupSecret = req.headers["x-setup-secret"];
  if (setupSecret !== config.telegramSetupSecret) {
    res.status(401).json({ error: "Invalid setup secret." });
    return;
  }

  if (!config.publicBaseUrl) {
    res.status(400).json({ error: "PUBLIC_BASE_URL is required before setting webhooks." });
    return;
  }
  if (!config.telegramAdminBotToken || !config.telegramUserBotToken) {
    res.status(400).json({ error: "Both Telegram bot tokens are required." });
    return;
  }

  const adminWebhookUrl = `${config.publicBaseUrl}/telegram/admin/webhook`;
  const userWebhookUrl = `${config.publicBaseUrl}/telegram/user/webhook`;

  const [adminResult, userResult] = await Promise.all([
    setWebhook(config.telegramAdminBotToken, adminWebhookUrl, config.telegramAdminWebhookSecret),
    setWebhook(config.telegramUserBotToken, userWebhookUrl, config.telegramUserWebhookSecret)
  ]);

  res.json({
    adminWebhookUrl,
    userWebhookUrl,
    admin: adminResult,
    user: userResult
  });
});
