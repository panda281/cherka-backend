import type { EventItem } from "../types";

type RawEvent = EventItem & {
  event_image_url?: string | null;
};

function normalizeEvent(raw: RawEvent): EventItem {
  const eventImageUrl = (raw.eventImageUrl ?? raw.event_image_url) ?? null;
  return {
    ...(raw as unknown as EventItem),
    eventImageUrl
  };
}

export async function requestEvents(apiBaseUrl: string): Promise<EventItem[]> {
  const response = await fetch(`${apiBaseUrl}/events`);
  if (!response.ok) throw new Error("Failed to fetch events.");
  const rows = (await response.json()) as RawEvent[];
  return rows.map(normalizeEvent);
}
