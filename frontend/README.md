# Ticketr Frontend

Separate frontend landing page project for the event planning site.

It shows:
- hero section
- platform value highlights
- published events and pricing tiers from backend API

## Run locally

1. Copy `.env.example` to `.env`
2. Set `VITE_API_BASE_URL` to your deployed API (or `http://localhost:4000`)
3. Install and run:
   - `npm install`
   - `npm run dev`

## Production build

- `npm run build`
- `npm run preview`

## Docker

Build and run frontend only:
- `docker build -t ticketr-frontend --build-arg VITE_API_BASE_URL=http://localhost:4000 .`
- `docker run -p 8080:80 ticketr-frontend`

Or from project root run all services:
- `docker compose up --build -d`
