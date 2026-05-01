import { useEffect, useState } from "react";
import "./App.css";

type EventTier = {
  id: string;
  tierCode: string;
  tierName: string;
  price: string;
  active: boolean;
};

type EventItem = {
  id: string;
  name: string;
  startsAt: string;
  location: string | null;
  eventImageUrl?: string | null;
  tiers: EventTier[];
};

type OrderResponse = {
  order: { id: string; orderRef: string; expectedAmount: string };
  paymentInstruction: {
    receiverNumber: string;
    receiverName: string;
    exactAmount: string;
    note: string;
  };
};

const defaultApiUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const userBotLink = import.meta.env.VITE_USER_BOT_LINK ?? "https://t.me/ticketr_user_demo_bot";

function App() {
  const apiBaseUrl = defaultApiUrl;
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [selectedTierId, setSelectedTierId] = useState("");
  const [buying, setBuying] = useState(false);
  const [orderResponse, setOrderResponse] = useState<OrderResponse | null>(null);
  const [receiptNo, setReceiptNo] = useState("");
  const [submittingReceipt, setSubmittingReceipt] = useState(false);
  const [message, setMessage] = useState("");

  async function fetchEvents() {
    setLoadingEvents(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/events`);
      if (!response.ok) throw new Error("Failed to fetch events.");
      const payload = (await response.json()) as EventItem[];
      setEvents(payload);
      if (payload.length && !selectedEventId) {
        setSelectedEventId(payload[0].id);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unexpected error.");
    } finally {
      setLoadingEvents(false);
    }
  }

  useEffect(() => {
    fetchEvents().catch(() => undefined);
  }, []);

  const selectedEvent = events.find((eventItem) => eventItem.id === selectedEventId) ?? null;
  const selectedTiers = selectedEvent?.tiers.filter((tier) => tier.active) ?? [];

  async function buyTicket() {
    if (!selectedEventId || !selectedTierId) {
      setMessage("Select event and tier to continue.");
      return;
    }
    setBuying(true);
    setMessage("");
    setOrderResponse(null);
    try {
      const response = await fetch(`${apiBaseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: selectedEventId, tierId: selectedTierId })
      });
      if (!response.ok) {
        throw new Error("Could not create order. Try again.");
      }
      const payload = (await response.json()) as OrderResponse;
      setOrderResponse(payload);
      setReceiptNo("");
      setMessage("Order created. Complete payment, then submit receipt below.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unexpected error.");
    } finally {
      setBuying(false);
    }
  }

  async function submitReceiptFromLanding() {
    if (!orderResponse?.order.id) {
      setMessage("Create an order first.");
      return;
    }
    if (!receiptNo.trim()) {
      setMessage("Enter receipt number before submitting.");
      return;
    }
    setSubmittingReceipt(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("receiptNo", receiptNo.trim());
      const response = await fetch(`${apiBaseUrl}/orders/${orderResponse.order.id}/receipt`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        throw new Error("Failed to submit receipt.");
      }
      setMessage("Receipt submitted successfully. Open User Bot and use /status then /claim with your order ref.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unexpected error.");
    } finally {
      setSubmittingReceipt(false);
    }
  }

  return (
    <main className="container">
      <header className="hero">
        <nav className="topNav">
          <span className="brand">Ticketr Events</span>
          <a href="#events">Explore Events</a>
        </nav>
        <div className="heroContent">
          <div>
            <h1>Plan unforgettable events with instant digital ticketing</h1>
            <p>
              Launch public events, manage premium tier pricing, and admit attendees using secure one-time QR entry.
            </p>
            <div className="heroActions">
              <a href="#events" className="primaryBtn">
                View Upcoming Events
              </a>
              <a href="#why" className="secondaryBtn">
                Why Ticketr
              </a>
            </div>
          </div>
          <div className="heroStat">
            <h3>Futuristic Event Stack</h3>
            <ul>
              <li>Tiered pricing (VIP, VVIP, Standard, Student)</li>
              <li>Telegram ticket delivery</li>
              <li>One-time scan validation</li>
            </ul>
          </div>
        </div>
      </header>

      <section id="why" className="card featureGrid">
        <article>
          <h2>Beautiful Event Publishing</h2>
          <p>Create and present events with clear dates, locations, and premium experiences.</p>
        </article>
        <article>
          <h2>Secure Receipt Verification</h2>
          <p>Users pay using Telebirr and get approved before they can claim a live ticket QR.</p>
        </article>
        <article>
          <h2>Fraud-Resistant Entry</h2>
          <p>Each QR ticket can be scanned once, preventing duplicate entry at the gate.</p>
        </article>
      </section>

      <section id="events" className="card">
        <div className="sectionTitle">
          <h2>Upcoming Events</h2>
          <p>Discover currently published experiences and available ticket tiers.</p>
        </div>
        <button onClick={fetchEvents} disabled={loadingEvents}>
          {loadingEvents ? "Refreshing..." : "Refresh Events"}
        </button>
        {events.length === 0 ? (
          <p className="empty">No published events available yet.</p>
        ) : (
          <div className="eventCards">
            {events.map((eventItem) => (
              <article key={eventItem.id} className="eventCard">
                {eventItem.eventImageUrl ? <img src={eventItem.eventImageUrl} alt={eventItem.name} className="eventImage" /> : null}
                <h3>{eventItem.name}</h3>
                <p>{new Date(eventItem.startsAt).toLocaleString()} · {eventItem.location ?? "TBA"}</p>
                <div className="tierWrap">
                  {eventItem.tiers.filter((tier) => tier.active).map((tier) => (
                    <span key={tier.id} className="tierTag">
                      {tier.tierName} - ETB {tier.price}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section id="buy" className="card buyPanel">
        <div className="sectionTitle">
          <h2>Buy Ticket</h2>
          <p>Select your event and preferred tier, then pay to receive your order reference.</p>
        </div>

        <div className="buyForm">
          <label>
            Event
            <select
              value={selectedEventId}
              onChange={(event) => {
                setSelectedEventId(event.target.value);
                setSelectedTierId("");
                setOrderResponse(null);
              }}
            >
              <option value="">Select event</option>
              {events.map((eventItem) => (
                <option key={eventItem.id} value={eventItem.id}>
                  {eventItem.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Tier
            <select value={selectedTierId} onChange={(event) => setSelectedTierId(event.target.value)}>
              <option value="">Select tier</option>
              {selectedTiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.tierName} ({tier.tierCode}) - ETB {tier.price}
                </option>
              ))}
            </select>
          </label>

          <button onClick={buyTicket} disabled={buying || !selectedEventId || !selectedTierId}>
            {buying ? "Creating order..." : "Buy Now"}
          </button>
        </div>

        {orderResponse ? (
          <div className="orderCard">
            <h3>Payment Instruction</h3>
            <p><strong>Order Ref:</strong> {orderResponse.order.orderRef}</p>
            <p>
              <strong>Pay To:</strong> {orderResponse.paymentInstruction.receiverName} ({orderResponse.paymentInstruction.receiverNumber})
            </p>
            <p><strong>Exact Amount:</strong> ETB {orderResponse.paymentInstruction.exactAmount}</p>
            <p><strong>Note:</strong> {orderResponse.paymentInstruction.note}</p>
            <div className="receiptInline">
              <label>
                Receipt Number
                <input
                  value={receiptNo}
                  onChange={(event) => setReceiptNo(event.target.value)}
                  placeholder="Enter Telebirr receipt number"
                />
              </label>
              <button onClick={submitReceiptFromLanding} disabled={submittingReceipt}>
                {submittingReceipt ? "Submitting..." : "Submit Receipt"}
              </button>
            </div>
            <p>
              After payment, open <a href={userBotLink} target="_blank" rel="noreferrer">User Bot</a> and submit receipt, then claim with your order ref.
            </p>
          </div>
        ) : null}
      </section>

      <section className="card cta">
        <h2>Ready to launch your next event?</h2>
        <p>Share your event on this landing page, collect payment proof, and deliver verified tickets via Telegram.</p>
        <a href="#buy" className="primaryBtn">
          Get Your Ticket
        </a>
      </section>

      {message ? <p className="message">{message}</p> : null}
    </main>
  );
}

export default App;
