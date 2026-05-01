export const EVENT_CATEGORIES = ["Music", "Festivals", "Arts", "Exhibitions", "Sports", "Tech"] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const DEFAULT_EVENT_CATEGORY: EventCategory = "Music";

export function parseEventCategory(input: string): EventCategory | null {
  const t = input.trim();
  return EVENT_CATEGORIES.find((c) => c.toLowerCase() === t.toLowerCase()) ?? null;
}
