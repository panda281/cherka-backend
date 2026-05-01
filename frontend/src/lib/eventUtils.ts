import type { EventItem } from "../types";

export function inferCategory(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("fest")) return "Festivals";
  if (n.includes("exhibit") || n.includes("gallery")) return "Exhibitions";
  if (n.includes("sport") || n.includes("marathon") || n.includes("match")) return "Sports";
  if (n.includes("tech") || n.includes("hackathon") || n.includes("summit")) return "Tech";
  if (n.includes("art") && !n.includes("party")) return "Arts";
  return "Music";
}

/** Prefer stored category from API; fall back to name heuristic for older rows. */
export function eventCategory(event: EventItem): string {
  const c = event.category?.trim();
  if (c) return c;
  return inferCategory(event.name);
}

export function publishedEvents(events: EventItem[]): EventItem[] {
  return events.filter((e) => e.status === "published");
}

export function activeTiersOf(event: EventItem) {
  return event.tiers.filter((t) => t.active);
}

export function isSoldOut(event: EventItem): boolean {
  return activeTiersOf(event).length === 0;
}

export function minPriceEtb(event: EventItem): number | null {
  const tiers = activeTiersOf(event);
  if (!tiers.length) return null;
  return Math.min(...tiers.map((t) => Number.parseFloat(t.price)));
}

export function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

export function formatEventTimeRange(startIso: string, endIso: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const s = new Date(startIso).toLocaleTimeString(undefined, opts);
  const e = new Date(endIso).toLocaleTimeString(undefined, opts);
  return `${s} – ${e}`;
}
