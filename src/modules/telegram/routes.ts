import express from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { config } from "../../config";
import { DEFAULT_EVENT_CATEGORY, EVENT_CATEGORIES, parseEventCategory } from "../../constants/eventCategories";
import { db } from "../../db/client";
import { eventTiers, events, orders, receiptSubmissions, tickets } from "../../db/schema";
import { buildReceiptUrl } from "../../utils";
import { approveReceiptSubmission } from "../receipts/approveSubmission";
import { logReceiptVerify } from "../receipts/verifyLogging";
import { resolveReceiptVerification } from "../receipts/verifier";
import { issueTicketForApprovedOrder } from "../tickets/service";

export const telegramRouter = express.Router();

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
  k: "capacity"
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
  step: "tierCode" | "tierName" | "tierPrice" | "tierCapacity";
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
  field: "tierCode" | "tierName" | "price" | "capacity";
  step: "value";
};
const adminTierAddState = new Map<string, AdminTierAddState>();
const adminEditState = new Map<string, AdminEditState>();
const adminTierEditState = new Map<string, AdminTierEditState>();

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
            return `- ${tier.tierName} (${tier.tierCode}) ETB ${tier.price} | sold ${sold} | ${tier.active ? "active" : "inactive"}`;
          })
          .join("\n")
      : "No tiers configured.";

    const [issuedRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .innerJoin(orders, eq(tickets.orderId, orders.id))
      .where(eq(orders.eventId, eventId));
    const issuedCount = issuedRow?.n ?? 0;

    const detailBody = `Event: ${eventItem.name}\nCategory: ${eventItem.category}\nFeatured: ${eventItem.featured ? "yes (shown first on lists)" : "no"}\nStatus: ${eventItem.status}\nStart: ${eventItem.startsAt.toISOString()}\nEnd: ${eventItem.endsAt.toISOString()}\nLocation: ${eventItem.location ?? "-"}\nEvent image: ${eventItem.eventImageUrl ?? "-"}\nTicket template image: ${eventItem.ticketTemplateImageUrl ?? "-"}\n\nTiers:\n${tiersText}\n\nIssued tickets: ${issuedCount} — use the “Ticket holders” button below for the full list.`;

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
          Markup.button.callback("Add Tier", telegramCallbackData(`eat:${eventId}`)),
          Markup.button.callback("Edit Event", telegramCallbackData(`eem:${eventId}`))
        ],
        [Markup.button.callback("Ticket holders", telegramCallbackData(`sls:${eventId}`))],
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
      const title = `${prefix}${eventItem.name}`.slice(0, 56);
      return [Markup.button.callback(title, telegramCallbackData(`evd:${eventItem.id}`))];
    });
    await adminBot!.telegram.sendMessage(
      chatId,
      `Events — ${label} (${rows.length}). Featured [F] sort first. Tap filter or open an event.`,
      Markup.inlineKeyboard([...filterRows, ...eventRows])
    );
  }

  const adminMenu = Markup.inlineKeyboard([
    [Markup.button.callback("Create New Event", telegramCallbackData("nw"))],
    [Markup.button.callback("Event List", telegramCallbackData("lst"))],
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
        [Markup.button.callback("Back", telegramCallbackData(`evd:${eventId}`))]
      ])
    );
  });

  adminBot.action(new RegExp(`^t_f:${CB_UUID}:([cnkp])$`), async (ctx) => {
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
    await ctx.reply(`Send new value for ${field}. For capacity you can send skip for unlimited.`);
  });

  adminBot.action(new RegExp(`^eem:${CB_UUID}$`), async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    await ctx.reply(
      "Choose field to edit:",
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
        [Markup.button.callback("Done", telegramCallbackData(`edo:${eventId}`))]
      ])
    );
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
    const text = queue
      .map((item) => `receiptId=${item.id}\norderId=${item.orderId}\nreceiptNo=${item.receiptNo}`)
      .join("\n\n");
    await ctx.reply(text);
  });

  adminBot.action("cmd", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply(
      "Commands:\n/adminmenu\n/newevent name|…|category(optional)|featured yes/no(optional)\nEvent List: category filter buttons\n/addtier eventId|…\n/verifyqueue\n/approve /reject …"
    );
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
    const text = queue
      .map((item) => `receiptId=${item.id}\norderId=${item.orderId}\nreceiptNo=${item.receiptNo}`)
      .join("\n\n");
    await ctx.reply(text);
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

  adminBot.on("text", async (ctx, next) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await next();
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
        tierState.step = "tierCapacity";
        await ctx.reply("Step D: send capacity or type skip.");
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
      if (editState.field === "status" && !["draft", "published", "closed"].includes(text)) {
        await ctx.reply("Status must be draft, published, or closed.");
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (editState.field === "startsAt" || editState.field === "endsAt") {
        patch[editState.field] = new Date(text);
      } else {
        patch[editState.field] = value;
      }
      await db.update(events).set(patch).where(eq(events.id, editState.eventId));
      adminEditState.delete(String(ctx.from.id));
      await ctx.reply("Event updated.");
      await sendEventDetail(ctx.chat!.id, editState.eventId);
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
        .map((tier) => `- ${tier.tierName} (${tier.tierCode}) ETB ${tier.price} cap ${tier.capacity ?? "unlimited"}`)
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
      state.step = "tierCapacity";
      await ctx.reply("Tier step D: send capacity number, or type skip.");
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
            capacity: tier.capacity,
            active: true
          }))
        );
        return eventRow;
      });
      adminCreateState.delete(String(ctx.from.id));
      await ctx.reply(`Event created successfully.\nID: ${created.id}\nName: ${created.name}`);
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

  const userMenu = Markup.inlineKeyboard([
    [Markup.button.callback("Browse Events", telegramCallbackData("user_buy"))],
    [Markup.button.callback("Submit Receipt Help", telegramCallbackData("user_submit_help"))],
    [Markup.button.callback("Claim Ticket Help", telegramCallbackData("user_claim_help"))],
    [Markup.button.callback("My Tickets", telegramCallbackData("user_myticket"))]
  ]);

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

  async function replyWithIssuedTicket(
    ctx: Context,
    orderRef: string,
    ticket: Awaited<ReturnType<typeof issueTicketForApprovedOrder>>
  ) {
    await ctx.replyWithPhoto({ source: Buffer.from(ticket.qrImageDataUrl.split(",")[1], "base64") }, {
      caption: `Ticket issued for order ${orderRef}. This QR can be used once.`
    });
  }

  async function tryAutoClaimApprovedWithoutTicket(ctx: Context): Promise<boolean> {
    const tgId = String(ctx.from?.id ?? "");
    if (!tgId) return false;
    const row = await db
      .select({ orderRef: orders.orderRef })
      .from(orders)
      .leftJoin(tickets, eq(tickets.orderId, orders.id))
      .where(and(eq(orders.telegramUserId, tgId), eq(orders.status, "approved"), isNull(tickets.id)))
      .limit(1);
    const first = row[0];
    if (!first) return false;
    try {
      const ticket = await issueTicketForApprovedOrder(first.orderRef, tgId, {
        telegramUsername: ctx.from?.username
      });
      await replyWithIssuedTicket(ctx, first.orderRef, ticket);
      await ctx.reply(
        "/start claimed your ticket automatically — this Telegram account is linked to that order.",
        userMenu
      );
      return true;
    } catch {
      return false;
    }
  }

  userBot.start(async (ctx) => {
    const tgId = String(ctx.from?.id ?? "");
    const deepRef = orderRefFromDeepLink(ctx);
    if (deepRef) {
      await db.update(orders).set({ telegramUserId: tgId, updatedAt: new Date() }).where(eq(orders.orderRef, deepRef));
      try {
        const ticket = await issueTicketForApprovedOrder(deepRef, tgId, {
          telegramUsername: ctx.from?.username
        });
        await replyWithIssuedTicket(ctx, deepRef, ticket);
        await ctx.reply(
          "Tip: share a deep link with ?start=" + deepRef + " so guests open the bot and get this QR in one step.",
          userMenu
        );
        return;
      } catch (e) {
        await ctx.reply(e instanceof Error ? e.message : "Could not issue ticket yet.", userMenu);
        return;
      }
    }
    if (await tryAutoClaimApprovedWithoutTicket(ctx)) {
      return;
    }
    await ctx.reply(
      "Welcome. Use /menu for shortcuts.\n\nAfter you submit a receipt from this chat, your account is linked — sending /start later can claim your ticket automatically once approved.",
      userMenu
    );
  });

  userBot.command("menu", async (ctx) => {
    await ctx.reply("User quick actions:", userMenu);
  });

  userBot.action("user_buy", async (ctx) => {
    await ctx.answerCbQuery();
    const activeEvents = await db.query.events.findMany({
      where: inArray(events.status, ["published"]),
      orderBy: [desc(events.featured), desc(events.startsAt)]
    });
    if (!activeEvents.length) {
      await ctx.reply("No published events found.");
      return;
    }
    const eventIds = activeEvents.map((eventItem) => eventItem.id);
    const tierRows = await db.query.eventTiers.findMany({
      where: and(inArray(eventTiers.eventId, eventIds), eq(eventTiers.active, true))
    });
    const lines = activeEvents.map((eventItem) => {
      const tiersForEvent = tierRows
        .filter((tier) => tier.eventId === eventItem.id)
        .map((tier) => `${tier.tierName} (${tier.tierCode}) - ETB ${tier.price}`)
        .join(", ");
      const feat = eventItem.featured ? "[Featured] " : "";
      return `${feat}${eventItem.name}\nEventID: ${eventItem.id}\nTiers: ${tiersForEvent || "none"}`;
    });
    await ctx.reply(lines.join("\n\n"));
  });

  userBot.action("user_submit_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Use:\n/submit ORDER_REF RECEIPT_NO\nExample:\n/submit ORD-ABCD12 129393939");
  });

  userBot.action("user_claim_help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Use:\n/claim ORDER_REF\nExample:\n/claim ORD-ABCD12");
  });

  userBot.action("user_myticket", async (ctx) => {
    await ctx.answerCbQuery();
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

  userBot.command("buy", async (ctx) => {
    const activeEvents = await db.query.events.findMany({
      where: inArray(events.status, ["published"]),
      orderBy: [desc(events.featured), desc(events.startsAt)]
    });
    if (!activeEvents.length) {
      await ctx.reply("No published events found.");
      return;
    }
    const eventIds = activeEvents.map((eventItem) => eventItem.id);
    const tierRows = await db.query.eventTiers.findMany({
      where: and(inArray(eventTiers.eventId, eventIds), eq(eventTiers.active, true))
    });
    const lines = activeEvents.map((eventItem) => {
      const tiersForEvent = tierRows
        .filter((tier) => tier.eventId === eventItem.id)
        .map((tier) => `${tier.tierName} (${tier.tierCode}) - ETB ${tier.price}`)
        .join(", ");
      const feat = eventItem.featured ? "[Featured] " : "";
      return `${feat}${eventItem.name}\nEventID: ${eventItem.id}\nTiers: ${tiersForEvent || "none"}`;
    });
    await ctx.reply(lines.join("\n\n"));
  });

  userBot.command("submit", async (ctx) => {
    const args = getArgs(getText(ctx));
    const orderRef = args[0];
    const receiptNo = args[1];
    if (!orderRef || !receiptNo) {
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
        "This receipt number was already submitted. If that was a mistake, contact support with a different receipt."
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
        const ticket = await issueTicketForApprovedOrder(orderRef, String(ctx.from!.id), {
          telegramUsername: ctx.from?.username
        });
        logReceiptVerify("telegram_submit_qr_ok", { orderRef, ticketId: ticket.id });
        await replyWithIssuedTicket(ctx, orderRef, ticket);
        await ctx.reply("Receipt auto-approved — your QR is above. Use /menu for more.", userMenu);
        return;
      } catch (err) {
        logReceiptVerify("telegram_submit_qr_fail", {
          orderRef,
          error: err instanceof Error ? err.message : String(err)
        });
        await ctx.reply(
          [
            "Receipt auto-verified, but the QR could not be issued yet. Try: /claim " + orderRef,
            "",
            verifyResult.notes
          ].join("\n"),
          userMenu
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
          ? "You can claim your ticket: /claim " + orderRef
          : order.status === "verifying"
            ? "Waiting for admin to verify your receipt. Try again later with /status"
            : order.status === "rejected"
              ? "This order was rejected. Contact the organizer if you believe this is wrong."
              : "Complete payment and submit receipt with /submit " + orderRef + " RECEIPT_NO"
      ].join("\n")
    );
  });

  userBot.command("claim", async (ctx) => {
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
      const ticket = await issueTicketForApprovedOrder(orderRef, String(ctx.from.id), {
        telegramUsername: ctx.from?.username
      });
      await replyWithIssuedTicket(ctx, orderRef, ticket);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Unable to claim ticket.");
    }
  });

  userBot.command("myticket", async (ctx) => {
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

  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== config.telegramAdminWebhookSecret) {
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

  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== config.telegramUserWebhookSecret) {
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
    const ticket = await issueTicketForApprovedOrder(orderRef, telegramUserId, { telegramUsername });
    res.json({ ticket });
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
