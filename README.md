# Demo Ticketing API

Node.js + Express demo backend for:
- configurable events and pricing tiers (`vip`, `standard`, `vvip`, `student`, etc.)
- Telebirr receipt submission and manual verification queue
- Telegram claim flow with generated QR ticket
- one-time scanner check-in that voids a ticket after first valid scan

## Setup

1. Copy `.env.example` to `.env` and fill values.
2. Install deps:
   - `npm install`
3. Generate migrations:
   - `npm run db:generate`
4. Apply migrations:
   - `npm run db:migrate`
5. Start dev server:
   - `npm run dev`

## Docker Setup

1. Ensure `.env` exists (do not leave `PUBLIC_BASE_URL` empty for webhook registration).
2. Start app + postgres:
   - `docker compose up --build -d`
3. View logs:
   - `docker compose logs -f app`
4. Stop services:
   - `docker compose down`

Notes:
- API runs on `http://localhost:4000`
- Frontend landing page runs on `http://localhost:8080`
- Postgres runs on `localhost:5432`
- The app container runs migrations on startup (`npm run db:migrate && npm start`)
- Receipt uploads are persisted in local `./uploads`

## Core Endpoints

- `POST /admin/events`
- `POST /admin/events/:eventId/tiers`
- `PATCH /admin/events/:eventId/tiers/:tierId`
- `GET /events`
- `POST /orders`
- `POST /orders/:orderId/receipt` (multipart, optional `screenshot`)
- `GET /admin/receipt-submissions?status=verifying`
- `POST /admin/receipt-submissions/:receiptId/approve`
- `POST /admin/receipt-submissions/:receiptId/reject`
- `POST /telegram/admin/webhook`
- `POST /telegram/user/webhook`
- `POST /telegram/user/claim`
- `POST /telegram/setup-webhooks`
- `POST /checkin/scan`
- `GET /admin/metrics`

## Demo Receipt Verification Flow

`POST /orders/:orderId/receipt` stores receipt details and places order in `verifying`.
Admin reviews against:
- `https://transactioninfo.ethiotelecom.et/receipt/{receipt_no}`
- expected amount
- expected receiver number/name
- receipt uniqueness

On approval, user can claim ticket via UserBot `/claim ORDER_REF`.

## Two-Bot Setup

- `AdminBot`: event and tier management + receipt queue moderation
- `UserBot`: browse events, submit receipt references, claim QR tickets
- Env keys:
  - `TELEGRAM_ADMIN_BOT_TOKEN`
  - `TELEGRAM_USER_BOT_TOKEN`
  - `TELEGRAM_ADMIN_WEBHOOK_SECRET`
  - `TELEGRAM_USER_WEBHOOK_SECRET`
  - `TELEGRAM_SETUP_SECRET`
  - `ADMIN_TELEGRAM_IDS` (comma-separated numeric IDs)

To register both Telegram webhooks in one call after setting `PUBLIC_BASE_URL`:
- `POST /telegram/setup-webhooks`
- header: `x-setup-secret: <TELEGRAM_SETUP_SECRET>`

Telegram menu shortcuts:
- Admin: `/adminmenu`
- User: `/menu`

## One-Time QR Rules

Scanner must send `x-scanner-api-key`.
`POST /checkin/scan` validates JWT in QR and:
- first scan: marks ticket `used` and returns `valid`
- later scans: returns `already_used`
