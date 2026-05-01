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
  tiers: EventTier[];
};

const defaultApiUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

function App() {
  const apiBaseUrl = defaultApiUrl;
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [message, setMessage] = useState("");

  async function fetchEvents() {
    setLoadingEvents(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/events`);
      if (!response.ok) throw new Error("Failed to fetch events.");
      const payload = (await response.json()) as EventItem[];
      setEvents(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unexpected error.");
    } finally {
      setLoadingEvents(false);
    }
  }

  useEffect(() => {
    fetchEvents().catch(() => undefined);
  }, []);

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
            <h3>All-in-one flow</h3>
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

      <section className="card cta">
        <h2>Ready to launch your next event?</h2>
        <p>Share your event on this landing page, collect payment proof, and deliver verified tickets via Telegram.</p>
        <a href="#events" className="primaryBtn">
          Start with Current Events
        </a>
      </section>

      {message ? <p className="message">{message}</p> : null}
    </main>
  );
}

export default App;
