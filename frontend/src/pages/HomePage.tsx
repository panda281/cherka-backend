import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EventCard } from "../components/EventCard";
import { requestEvents } from "../lib/api";
import { DEFAULT_HERO_UNSPLASH } from "../lib/unsplashPlaceholders";
import {
  formatEventDate,
  formatEventTimeRange,
  eventCategory,
  eventCoverImageUrl,
  isSoldOut,
  minPriceEtb,
  publishedEvents
} from "../lib/eventUtils";
import type { EventItem, OrderResponse } from "../types";
import { CATEGORIES } from "../types";

const defaultApiUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const userBotLink = import.meta.env.VITE_USER_BOT_LINK ?? "https://t.me/ticketr_user_demo_bot";

export function HomePage() {
  const apiBaseUrl = defaultApiUrl;
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [category, setCategory] = useState<string>("All");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [selectedTierId, setSelectedTierId] = useState("");
  const [buying, setBuying] = useState(false);
  const [orderResponse, setOrderResponse] = useState<OrderResponse | null>(null);
  const [receiptNo, setReceiptNo] = useState("");
  const [submittingReceipt, setSubmittingReceipt] = useState(false);
  const [message, setMessage] = useState("");

  const visible = useMemo(() => publishedEvents(events), [events]);

  const filtered = useMemo(() => {
    if (category === "All") return visible;
    return visible.filter((e) => eventCategory(e) === category);
  }, [visible, category]);

  const featured = visible[0] ?? null;
  const carousel = visible.slice(0, 8);

  function applyEventsPayload(payload: EventItem[]) {
    setEvents(payload);
    setSelectedEventId((prev) => {
      const pub = publishedEvents(payload);
      if (prev && pub.some((e) => e.id === prev)) return prev;
      return pub[0]?.id ?? "";
    });
  }

  async function refreshEvents() {
    setLoadingEvents(true);
    setMessage("");
    try {
      const payload = await requestEvents(apiBaseUrl);
      applyEventsPayload(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unexpected error.");
    } finally {
      setLoadingEvents(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingEvents(true);
      setMessage("");
      try {
        const payload = await requestEvents(apiBaseUrl);
        if (!cancelled) applyEventsPayload(payload);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Unexpected error.");
      } finally {
        if (!cancelled) setLoadingEvents(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

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

  const heroSoldOut = featured ? isSoldOut(featured) : false;
  const heroMin = featured ? minPriceEtb(featured) : null;

  return (
    <>
      <section id="featured" className="pzm-hero">
        {featured ? (
          <>
            <div className="pzm-hero__bg">
              <img
                src={eventCoverImageUrl(featured)}
                alt={featured.name}
                className="pzm-hero__bgImg"
                fetchPriority="high"
              />
              <div className="pzm-hero__scrim" />
            </div>
            <div className="pzm-hero__content">
              <span className="pzm-hero__eyebrow">Featured</span>
              <h1 className="pzm-hero__title">{featured.name}</h1>
              <p className="pzm-hero__desc">
                {featured.description?.trim() ||
                  `${formatEventDate(featured.startsAt)} · ${featured.location ?? "TBA"} — Get your tickets before they sell out.`}
              </p>
              <ul className="pzm-hero__facts">
                <li>{formatEventDate(featured.startsAt)}</li>
                <li>{formatEventTimeRange(featured.startsAt, featured.endsAt)}</li>
                <li>{featured.location ?? "Venue TBA"}</li>
              </ul>
              <div className="pzm-hero__actions">
                {heroSoldOut ? (
                  <span className="pzm-btn pzm-btn--light pzm-btn--lg" aria-disabled>
                    Sold Out
                  </span>
                ) : (
                  <>
                    <Link to={`/event/${featured.id}`} className="pzm-btn pzm-btn--light pzm-btn--lg">
                      Get Tickets
                    </Link>
                    {heroMin != null ? (
                      <span className="pzm-hero__from">From {heroMin.toLocaleString()} ETB</span>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="pzm-hero__bg">
              <img src={DEFAULT_HERO_UNSPLASH} alt="" className="pzm-hero__bgImg" fetchPriority="high" />
              <div className="pzm-hero__scrim" />
            </div>
            <div className="pzm-hero__content pzm-hero__content--empty">
              <span className="pzm-hero__eyebrow">Events</span>
              <h1 className="pzm-hero__title">No published events yet</h1>
              <p className="pzm-hero__desc">Check back soon for new experiences.</p>
            </div>
          </>
        )}
      </section>

      <section className="pzm-strip" aria-label="Categories">
        <div className="pzm-strip__inner">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`pzm-chip ${category === c ? "pzm-chip--active" : ""}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </section>

      <section className="pzm-section">
        <div className="pzm-section__head">
          <h2 className="pzm-section__title">Don&apos;t Miss Out</h2>
          <Link to="/#all" className="pzm-section__link">
            View all
          </Link>
        </div>
        <div className="pzm-carousel">
          {loadingEvents && !carousel.length ? (
            <p className="pzm-muted">Loading events…</p>
          ) : carousel.length === 0 ? (
            <p className="pzm-muted">No events to show.</p>
          ) : (
            carousel.map((e) => <EventCard key={e.id} event={e} featured />)
          )}
        </div>
      </section>

      <section id="all" className="pzm-section pzm-section--alt">
        <div className="pzm-section__head">
          <h2 className="pzm-section__title">All Events</h2>
          <button type="button" className="pzm-refresh" onClick={refreshEvents} disabled={loadingEvents}>
            {loadingEvents ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {filtered.length === 0 ? (
          <p className="pzm-muted">No events in this category.</p>
        ) : (
          <div className="pzm-grid">
            {filtered.map((e) => (
              <EventCard key={e.id} event={e} />
            ))}
          </div>
        )}
      </section>

      <section id="events" className="pzm-section">
        <div className="pzm-section__head">
          <h2 className="pzm-section__title">Buy tickets</h2>
          <p className="pzm-section__subtitle">Select an event and tier, pay via Telebirr, then submit your receipt.</p>
        </div>

        <div id="buy" className="pzm-buy">
          <div className="pzm-buy__form">
            <label className="pzm-field">
              <span>Event</span>
              <select
                value={selectedEventId}
                onChange={(event) => {
                  setSelectedEventId(event.target.value);
                  setSelectedTierId("");
                  setOrderResponse(null);
                }}
              >
                <option value="">Select event</option>
                {visible.map((eventItem) => (
                  <option key={eventItem.id} value={eventItem.id}>
                    {eventItem.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="pzm-field">
              <span>Tier</span>
              <select value={selectedTierId} onChange={(event) => setSelectedTierId(event.target.value)}>
                <option value="">Select tier</option>
                {selectedTiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.tierName} ({tier.tierCode}) — ETB {tier.price}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="pzm-btn pzm-btn--dark"
              onClick={buyTicket}
              disabled={buying || !selectedEventId || !selectedTierId}
            >
              {buying ? "Creating order…" : "Buy now"}
            </button>
          </div>

          {orderResponse ? (
            <div className="pzm-order">
              <h3 className="pzm-order__title">Payment instruction</h3>
              <p>
                <strong>Order ref:</strong> {orderResponse.order.orderRef}
              </p>
              <p>
                <strong>Pay to:</strong> {orderResponse.paymentInstruction.receiverName} (
                {orderResponse.paymentInstruction.receiverNumber})
              </p>
              <p>
                <strong>Exact amount:</strong> ETB {orderResponse.paymentInstruction.exactAmount}
              </p>
              <p>
                <strong>Note:</strong> {orderResponse.paymentInstruction.note}
              </p>
              <div className="pzm-order__receipt">
                <label className="pzm-field">
                  <span>Receipt number</span>
                  <input
                    value={receiptNo}
                    onChange={(event) => setReceiptNo(event.target.value)}
                    placeholder="Telebirr receipt number"
                  />
                </label>
                <button
                  type="button"
                  className="pzm-btn pzm-btn--outline"
                  onClick={submitReceiptFromLanding}
                  disabled={submittingReceipt}
                >
                  {submittingReceipt ? "Submitting…" : "Submit receipt"}
                </button>
              </div>
              <p className="pzm-order__hint">
                After payment, open{" "}
                <a href={userBotLink} target="_blank" rel="noreferrer">
                  User Bot
                </a>{" "}
                and use /status then /claim with your order ref.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {message ? <p className="pzm-toast">{message}</p> : null}
    </>
  );
}
