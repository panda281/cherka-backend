import { Link, Outlet } from "react-router-dom";

export function Layout() {
  return (
    <div className="pzm-root">
      <header className="pzm-header">
        <div className="pzm-header__inner">
          <Link to="/" className="pzm-logo">
            Ticketr
          </Link>
          <nav className="pzm-nav" aria-label="Main">
            <Link to="/#events">Explore Events</Link>
            <Link to="/#featured">Featured</Link>
            <Link to="/#all">All Events</Link>
          </nav>
        </div>
      </header>
      <Outlet />
      <footer className="pzm-footer">
        <div className="pzm-footer__inner">
          <div>
            <strong className="pzm-footer__brand">Ticketr</strong>
            <p className="pzm-footer__tagline">Discover events. Secure tickets. Instant QR check-in.</p>
          </div>
          <div className="pzm-footer__cols">
            <div>
              <span className="pzm-footer__heading">Browse</span>
              <Link to="/#events">Upcoming</Link>
              <Link to="/#all">All events</Link>
            </div>
            <div>
              <span className="pzm-footer__heading">Support</span>
              <a href="#buy">Buy tickets</a>
            </div>
          </div>
        </div>
        <p className="pzm-footer__copy">© {new Date().getFullYear()} Ticketr</p>
      </footer>
    </div>
  );
}
