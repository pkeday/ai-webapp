# AI Web App Starter (Frontend + Backend + Scheduled Jobs)

This project includes:
- Static frontend (GitHub Pages)
- Core backend (`backend/src/server.js`) for existing jobs/notifications
- Brokerage backend (`backend-brokerage/src/server.js`) for Sub-app 1 auth + Gmail ingest/archive
- Scheduled job script (`backend/src/cron.js`)
- Render config (`render.yaml`) for backend hosting
- GitHub Actions schedule for cron triggering

## Current live frontend

`https://pkeday.github.io/ai-webapp/`

## Current backend URLs

- Core API: `https://pkeday-ai-webapp-api.onrender.com`
- Brokerage API (Sub-app 1): `https://pkeday-ai-webapp-brokerage-api.onrender.com`

## 1) Run locally

Frontend:

```bash
cd /Users/parikshitkabra/Projects/codex_projects/ai-webapp
./scripts/run-local.sh
```

Core Backend API:

```bash
cd /Users/parikshitkabra/Projects/codex_projects/ai-webapp
./scripts/run-backend-local.sh
```

Local URLs:
- Frontend: `http://localhost:5173`
- Core backend: `http://localhost:10000`
- Brokerage backend: `http://localhost:10001`

Brokerage backend:

```bash
cd /Users/parikshitkabra/Projects/codex_projects/ai-webapp
./scripts/run-brokerage-backend-local.sh
```

## 2) Backend hosting (Render)

Render web services:
- Name: `pkeday-ai-webapp-api`
- URL: `https://pkeday-ai-webapp-api.onrender.com`
- Root dir: `backend`
- Build command: `npm install --omit=dev`
- Start command: `npm start`
- Plan: `free`

- Name: `pkeday-ai-webapp-brokerage-api`
- URL: `https://pkeday-ai-webapp-brokerage-api.onrender.com`
- Root dir: `backend-brokerage`
- Build command: `npm install --omit=dev`
- Start command: `npm start`
- Plan: `free`

The config source is:
`/Users/parikshitkabra/Projects/codex_projects/ai-webapp/render.yaml`

## 3) Cron hosting (GitHub Actions)

Scheduled trigger workflow:
`/Users/parikshitkabra/Projects/codex_projects/ai-webapp/.github/workflows/backend-cron.yml`

Schedule:
- Every 15 minutes (`*/15 * * * *`)

It calls:
- `POST /api/jobs/daily` on your backend with a secret header.

Current backend cron behavior:
- Fetches NSE corporate announcements
- Fetches BSE corporate announcements in the same cron run
- Stores only new (deduplicated) records in separate backend stores for each exchange
- Exposes data at `GET /api/notifications/announcements?exchange=NSE|BSE`

Required GitHub repository secrets:
- `API_BASE_URL`
- `CRON_SECRET`

## 4) Set backend URL in the frontend UI

After backend deploys, open:
`https://pkeday.github.io/ai-webapp/`

In the Status card:
1. Paste backend URL (for example: `https://pkeday-ai-webapp-brokerage-api.onrender.com`)
2. Click `Save + Test`

The value is saved in browser local storage per device.

## 5) Publish future updates

```bash
cd /Users/parikshitkabra/Projects/codex_projects/ai-webapp
./scripts/publish.sh "Describe update"
```

## 6) Files you will use most

- Frontend: `/Users/parikshitkabra/Projects/codex_projects/ai-webapp/index.html`
- Frontend JS: `/Users/parikshitkabra/Projects/codex_projects/ai-webapp/app.js`
- Core backend API: `/Users/parikshitkabra/Projects/codex_projects/ai-webapp/backend/src/server.js`
- Brokerage backend API: `/Users/parikshitkabra/Projects/codex_projects/ai-webapp/backend-brokerage/src/server.js`
- Cron job: `/Users/parikshitkabra/Projects/codex_projects/ai-webapp/backend/src/cron.js`
- Cron workflow: `/Users/parikshitkabra/Projects/codex_projects/ai-webapp/.github/workflows/backend-cron.yml`
- Render config: `/Users/parikshitkabra/Projects/codex_projects/ai-webapp/render.yaml`

## Notes

- Custom domain is optional and can be connected later.
- We can add more scheduled workflows as your app grows.
