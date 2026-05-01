import express from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Markup, Telegraf } from "telegraf";
import { config } from "../../config";
import { db } from "../../db/client";
import { eventTiers, events, orders, receiptSubmissions, tickets } from "../../db/schema";
import { buildReceiptUrl } from "../../utils";
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
  step:
    | "name"
    | "startsAt"
    | "endsAt"
    | "location"
    | "description"
    | "eventImageUrl"
    | "ticketTemplateImageUrl"
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
  eventImageUrl?: string;
  ticketTemplateImageUrl?: string;
  tiers: TierDraft[];
  draftTier?: Partial<TierDraft>;
};

const adminCreateState = new Map<string, AdminCreateState>();

if (config.telegramAdminBotToken) {
  adminBot = new Telegraf(config.telegramAdminBotToken);

  const adminMenu = Markup.inlineKeyboard([
    [Markup.button.callback("Create New Event", "admin_create_event_start")],
    [Markup.button.callback("Event List", "admin_event_list")],
    [Markup.button.callback("View Verify Queue", "admin_verifyqueue")],
    [Markup.button.callback("Show Commands", "admin_show_commands")]
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

  adminBot.action("admin_create_event_start", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    adminCreateState.set(String(ctx.from.id), { step: "name", tiers: [] });
    await ctx.reply("Creating new event.\nStep 1/10: send event name.");
  });

  adminBot.action("admin_event_list", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const rows = await db.query.events.findMany({
      orderBy: [desc(events.startsAt)],
      limit: 20
    });
    if (!rows.length) {
      await ctx.reply("No events yet.");
      return;
    }
    const keyboard = rows.map((eventItem) => [
      Markup.button.callback(eventItem.name.slice(0, 50), `admin_event_detail:${eventItem.id}`)
    ]);
    await ctx.reply("Select event:", Markup.inlineKeyboard(keyboard));
  });

  adminBot.action(/admin_event_detail:(.+)/, async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    const eventId = ctx.match[1];
    const eventItem = await db.query.events.findFirst({
      where: eq(events.id, eventId)
    });
    if (!eventItem) {
      await ctx.reply("Event not found.");
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
            return `- ${tier.tierName} (${tier.tierCode}) ETB ${tier.price} | sold ${sold}`;
          })
          .join("\n")
      : "No tiers configured.";

    await ctx.reply(
      `Event: ${eventItem.name}\nStatus: ${eventItem.status}\nStart: ${eventItem.startsAt.toISOString()}\nEnd: ${eventItem.endsAt.toISOString()}\nLocation: ${eventItem.location ?? "-"}\nEvent image: ${eventItem.eventImageUrl ?? "-"}\nTicket template image: ${eventItem.ticketTemplateImageUrl ?? "-"}\n\nTiers:\n${tiersText}`
    );
  });

  adminBot.action("admin_verifyqueue", async (ctx) => {
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

  adminBot.action("admin_show_commands", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.answerCbQuery("Unauthorized");
      return;
    }
    await ctx.answerCbQuery();
    await ctx.reply(
      "Commands:\n/adminmenu\n/newevent name|startsAtISO|endsAtISO|location|description\n/addtier eventId|tierCode|tierName|price|capacity(optional)\n/eventlist\n/verifyqueue\n/approve receiptId\n/reject receiptId reason"
    );
  });

  adminBot.command("eventlist", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const rows = await db.query.events.findMany({
      orderBy: [desc(events.startsAt)],
      limit: 20
    });
    if (!rows.length) {
      await ctx.reply("No events yet.");
      return;
    }
    const keyboard = rows.map((eventItem) => [
      Markup.button.callback(eventItem.name.slice(0, 50), `admin_event_detail:${eventItem.id}`)
    ]);
    await ctx.reply("Select event:", Markup.inlineKeyboard(keyboard));
  });

  adminBot.command("newevent", async (ctx) => {
    if (!isAdminUser(String(ctx.from.id))) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const payload = getText(ctx).replace("/newevent", "").trim();
    const [name, startsAt, endsAt, location, description] = payload.split("|").map((item) => item.trim());
    if (!name || !startsAt || !endsAt) {
      await ctx.reply("Usage: /newevent name|startsAtISO|endsAtISO|location|description");
      return;
    }
    const [created] = await db
      .insert(events)
      .values({
        name,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        location,
        description,
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
    const receiptId = args[0];
    if (!receiptId) {
      await ctx.reply("Usage: /approve receiptId");
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
    const receiptId = args[0];
    const reason = args.slice(1).join(" ") || "Rejected from admin bot.";
    if (!receiptId) {
      await ctx.reply("Usage: /reject receiptId reason");
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
    if (!state) {
      await next();
      return;
    }
    const text = getText(ctx).trim();
    if (!text) {
      await ctx.reply("Please send text value.");
      return;
    }

    if (state.step === "name") {
      state.name = text;
      state.step = "startsAt";
      await ctx.reply("Step 2/10: send start date in ISO format (example 2026-12-31T17:00:00Z).");
      return;
    }
    if (state.step === "startsAt") {
      if (Number.isNaN(Date.parse(text))) {
        await ctx.reply("Invalid date format. Send ISO date.");
        return;
      }
      state.startsAt = text;
      state.step = "endsAt";
      await ctx.reply("Step 3/10: send end date in ISO format.");
      return;
    }
    if (state.step === "endsAt") {
      if (Number.isNaN(Date.parse(text))) {
        await ctx.reply("Invalid date format. Send ISO date.");
        return;
      }
      state.endsAt = text;
      state.step = "location";
      await ctx.reply("Step 4/10: send location.");
      return;
    }
    if (state.step === "location") {
      state.location = text;
      state.step = "description";
      await ctx.reply("Step 5/10: send description.");
      return;
    }
    if (state.step === "description") {
      state.description = text;
      state.step = "eventImageUrl";
      await ctx.reply("Step 6/10: send event image URL or type skip.");
      return;
    }
    if (state.step === "eventImageUrl") {
      state.eventImageUrl = text.toLowerCase() === "skip" ? undefined : text;
      state.step = "ticketTemplateImageUrl";
      await ctx.reply("Step 7/10: send ticket template image URL or type skip.");
      return;
    }
    if (state.step === "ticketTemplateImageUrl") {
      state.ticketTemplateImageUrl = text.toLowerCase() === "skip" ? undefined : text;
      state.step = "tierAsk";
      await ctx.reply("Step 8/10: add a tier now? reply yes or no.");
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
      await ctx.reply("Step 9/10: type confirm to create event, or /cancel.");
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
}

if (config.telegramUserBotToken) {
  userBot = new Telegraf(config.telegramUserBotToken);

  const userMenu = Markup.inlineKeyboard([
    [Markup.button.callback("Browse Events", "user_buy")],
    [Markup.button.callback("Submit Receipt Help", "user_submit_help")],
    [Markup.button.callback("Claim Ticket Help", "user_claim_help")],
    [Markup.button.callback("My Tickets", "user_myticket")]
  ]);

  userBot.start(async (ctx) => {
    await ctx.reply("Welcome. Open menu with /menu", userMenu);
  });

  userBot.command("menu", async (ctx) => {
    await ctx.reply("User quick actions:", userMenu);
  });

  userBot.action("user_buy", async (ctx) => {
    await ctx.answerCbQuery();
    const activeEvents = await db.query.events.findMany({
      where: inArray(events.status, ["published"]),
      orderBy: [desc(events.startsAt)]
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
      return `${eventItem.name}\nEventID: ${eventItem.id}\nTiers: ${tiersForEvent || "none"}`;
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
      orderBy: [desc(events.startsAt)]
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
      return `${eventItem.name}\nEventID: ${eventItem.id}\nTiers: ${tiersForEvent || "none"}`;
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
    await db.insert(receiptSubmissions).values({
      orderId: order.id,
      receiptNo,
      receiptUrl: buildReceiptUrl(receiptNo),
      verificationStatus: "verifying",
      verificationNotes: "Submitted from user bot."
    });
    await db.update(orders).set({ status: "verifying", updatedAt: new Date() }).where(eq(orders.id, order.id));
    await ctx.reply("Receipt submitted. Please wait for admin verification.");
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
    await ctx.reply(`Order ${orderRef} status: ${order.status}`);
  });

  userBot.command("claim", async (ctx) => {
    const args = getArgs(getText(ctx));
    const orderRef = args[0];
    if (!orderRef) {
      await ctx.reply("Usage: /claim ORDER_REF");
      return;
    }
    try {
      const ticket = await issueTicketForApprovedOrder(orderRef, String(ctx.from.id));
      await ctx.replyWithPhoto({ source: Buffer.from(ticket.qrImageDataUrl.split(",")[1], "base64") }, {
        caption: `Ticket issued for order ${orderRef}. This QR can be used once.`
      });
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

  await adminBot.handleUpdate(req.body);
  res.json({ ok: true });
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

  await userBot.handleUpdate(req.body);
  res.json({ ok: true });
});

telegramRouter.post("/telegram/user/claim", async (req, res) => {
  const orderRef = String(req.body.orderRef ?? "");
  const telegramUserId = String(req.body.telegramUserId ?? "");
  if (!orderRef || !telegramUserId) {
    res.status(400).json({ error: "orderRef and telegramUserId are required." });
    return;
  }

  try {
    const ticket = await issueTicketForApprovedOrder(orderRef, telegramUserId);
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
