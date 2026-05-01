export type EventTier = {
  id: string;
  tierCode: string;
  tierName: string;
  price: string;
  active: boolean;
};

export type EventItem = {
  id: string;
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  location: string | null;
  category?: string | null;
  eventImageUrl?: string | null;
  status: string;
  tiers: EventTier[];
};

export type OrderResponse = {
  order: { id: string; orderRef: string; expectedAmount: string };
  paymentInstruction: {
    receiverNumber: string;
    receiverName: string;
    exactAmount: string;
    note: string;
  };
};

export const CATEGORIES = [
  "All",
  "Music",
  "Festivals",
  "Arts",
  "Exhibitions",
  "Sports",
  "Tech"
] as const;
