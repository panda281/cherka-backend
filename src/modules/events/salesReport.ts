import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { events, ticketSaleLedger, tickets } from "../../db/schema";

export type EventTicketSalesReport = {
  event: { id: string; name: string };
  dataSource: "ticket_sale_ledger";
  summary: {
    totalTicketsIssued: number;
    totalRevenueEtb: string;
    byTier: {
      tierId: string;
      tierCode: string;
      tierName: string;
      listPriceEtb: string;
      ticketsSold: number;
      revenueEtb: string;
    }[];
  };
  ticketLines?: {
    ticketId: string;
    orderRef: string;
    tierCode: string;
    tierName: string;
    buyerTelegramId: string;
    buyerUsername: string | null;
    ticketStatus: string;
    issuedAt: Date;
    orderQuantity: number;
    orderTotalEtb: string;
    revenueForThisTicketEtb: string;
    ledgerSource: string;
  }[];
};

function csvEscape(value: string | null | undefined): string {
  if (value == null || value === "") return "";
  const t = String(value);
  if (/[",\n\r]/.test(t)) {
    return `"${t.replace(/"/g, '""')}"`;
  }
  return t;
}

/** Immutable ledger rows for an event (tax / organizer export). */
export async function getEventLedgerRows(eventId: string) {
  return db
    .select()
    .from(ticketSaleLedger)
    .where(eq(ticketSaleLedger.eventId, eventId))
    .orderBy(desc(ticketSaleLedger.recordedAt));
}

export function ledgerRowsToCsv(rows: (typeof ticketSaleLedger.$inferSelect)[]): string {
  const headers = [
    "recorded_at",
    "event_id",
    "event_name_snapshot",
    "tier_code_snapshot",
    "tier_name_snapshot",
    "list_unit_price_etb",
    "order_ref",
    "ticket_id",
    "order_id",
    "order_quantity",
    "order_total_etb",
    "line_allocated_etb",
    "currency",
    "buyer_telegram_user_id",
    "buyer_telegram_username",
    "source"
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.recordedAt.toISOString(),
        r.eventId,
        csvEscape(r.eventNameSnapshot),
        csvEscape(r.tierCodeSnapshot),
        csvEscape(r.tierNameSnapshot),
        String(r.listUnitPriceEtb),
        r.orderRef,
        r.ticketId,
        r.orderId,
        String(r.orderQuantity),
        String(r.orderTotalEtb),
        String(r.lineAllocatedEtb),
        r.currency,
        r.buyerTelegramUserId,
        csvEscape(r.buyerTelegramUsername),
        r.source
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

/**
 * Sales from append-only `ticket_sale_ledger` (run DB migration + backfill for historical tickets).
 */
export async function getEventTicketSalesReport(
  eventId: string,
  detailLimit: number | null
): Promise<EventTicketSalesReport | null> {
  const eventItem = await db.query.events.findFirst({ where: eq(events.id, eventId) });
  if (!eventItem) {
    return null;
  }

  const byTierRows = await db
    .select({
      tierId: ticketSaleLedger.tierId,
      tierCode: ticketSaleLedger.tierCodeSnapshot,
      tierName: ticketSaleLedger.tierNameSnapshot,
      listPrice: ticketSaleLedger.listUnitPriceEtb,
      ticketsSold: sql<number>`count(*)::int`,
      revenueEtb: sql<string>`coalesce(sum(${ticketSaleLedger.lineAllocatedEtb}::numeric), 0)::text`
    })
    .from(ticketSaleLedger)
    .where(eq(ticketSaleLedger.eventId, eventId))
    .groupBy(
      ticketSaleLedger.tierId,
      ticketSaleLedger.tierCodeSnapshot,
      ticketSaleLedger.tierNameSnapshot,
      ticketSaleLedger.listUnitPriceEtb
    );

  const totalTickets = byTierRows.reduce((s, r) => s + Number(r.ticketsSold), 0);
  const totalRevenue = byTierRows.reduce((s, r) => s + Number(r.revenueEtb), 0);

  const byTier = byTierRows.map((r) => ({
    tierId: r.tierId,
    tierCode: r.tierCode,
    tierName: r.tierName,
    listPriceEtb: String(r.listPrice),
    ticketsSold: Number(r.ticketsSold),
    revenueEtb: Number(r.revenueEtb).toFixed(2)
  }));

  let ticketLines: EventTicketSalesReport["ticketLines"];
  if (detailLimit != null && detailLimit > 0) {
    const rows = await db
      .select({
        l: ticketSaleLedger,
        ticketStatus: tickets.status
      })
      .from(ticketSaleLedger)
      .innerJoin(tickets, eq(ticketSaleLedger.ticketId, tickets.id))
      .where(eq(ticketSaleLedger.eventId, eventId))
      .orderBy(desc(ticketSaleLedger.recordedAt))
      .limit(detailLimit);

    ticketLines = rows.map((r) => ({
      ticketId: r.l.ticketId,
      orderRef: r.l.orderRef,
      tierCode: r.l.tierCodeSnapshot,
      tierName: r.l.tierNameSnapshot,
      buyerTelegramId: r.l.buyerTelegramUserId,
      buyerUsername: r.l.buyerTelegramUsername,
      ticketStatus: r.ticketStatus,
      issuedAt: r.l.recordedAt,
      orderQuantity: r.l.orderQuantity,
      orderTotalEtb: String(r.l.orderTotalEtb),
      revenueForThisTicketEtb: Number(r.l.lineAllocatedEtb).toFixed(2),
      ledgerSource: r.l.source
    }));
  }

  return {
    event: { id: eventItem.id, name: eventItem.name },
    dataSource: "ticket_sale_ledger",
    summary: {
      totalTicketsIssued: totalTickets,
      totalRevenueEtb: totalRevenue.toFixed(2),
      byTier
    },
    ...(ticketLines ? { ticketLines } : {})
  };
}
