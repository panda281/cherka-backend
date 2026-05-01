import type { EventItem } from "../types";

export async function requestEvents(apiBaseUrl: string): Promise<EventItem[]> {
  const response = await fetch(`${apiBaseUrl}/events`);
  if (!response.ok) throw new Error("Failed to fetch events.");
  return (await response.json()) as EventItem[];
}
