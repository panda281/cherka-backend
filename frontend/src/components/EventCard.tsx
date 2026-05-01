import { Link } from "react-router-dom";
import type { EventItem } from "../types";
import { formatEventDate, eventCategory, isSoldOut, minPriceEtb } from "../lib/eventUtils";

type Props = {
  event: EventItem;
  featured?: boolean;
};

export function EventCard({ event, featured }: Props) {
  const soldOut = isSoldOut(event);
  const minPrice = minPriceEtb(event);
  const category = eventCategory(event);
  const locationLabel = event.location?.trim() || "TBA";

  return (
    <article className={`pzm-card ${featured ? "pzm-card--featured" : ""}`}>
      <Link to={`/event/${event.id}`} className="pzm-card__mediaLink">
        <div className="pzm-card__media">
          {event.eventImageUrl ? (
            <img src={event.eventImageUrl} alt={event.name} className="pzm-card__img" />
          ) : (
            <div className="pzm-card__placeholder" aria-hidden />
          )}
          <span className="pzm-card__badge">{category}</span>
          {soldOut ? <span className="pzm-card__soldOut">Sold Out</span> : null}
        </div>
      </Link>
      <div className="pzm-card__body">
        <Link to={`/event/${event.id}`} className="pzm-card__titleLink">
          <h3 className="pzm-card__title">{event.name}</h3>
        </Link>
        <p className="pzm-card__meta">
          {formatEventDate(event.startsAt)}
          <span className="pzm-card__dot" />
          {locationLabel}
        </p>
        <div className="pzm-card__row">
          {minPrice != null ? (
            <span className="pzm-card__price">From {minPrice.toLocaleString()} ETB</span>
          ) : (
            <span className="pzm-card__price pzm-card__price--muted">—</span>
          )}
          {soldOut ? (
            <span className="pzm-btn pzm-btn--ghost pzm-btn--sm" aria-disabled="true">
              Sold Out
            </span>
          ) : (
            <Link to={`/event/${event.id}`} className="pzm-btn pzm-btn--dark pzm-btn--sm">
              Get Tickets
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
