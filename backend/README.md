# Backend + Jobs

This backend is intentionally dependency-light so it can run without extra setup.

## Scripts

```bash
npm start         # API server
npm run worker    # long-running background worker (optional)
npm run cron      # one-time cron execution
npm run check     # syntax checks
```

Production setup in this project:
- API runs on Render web service.
- Cron trigger runs via GitHub Actions schedule and calls `POST /api/jobs/daily`.
- Worker script is available for future always-on background processing.

## Important env vars

- `PORT`: API server port (Render sets this automatically).
- `CORS_ORIGIN`: Comma-separated allowed frontend origins.
- `CRON_SECRET`: Shared secret for worker/cron protected API routes.
- `API_BASE_URL`: API URL used by worker/cron scripts.
- `NSE_INDEX`: NSE index for announcement API (`equities` by default).
- `NSE_LOOKBACK_DAYS`: Date lookback window used by each sync run (default: `1`).
- `NSE_REQUEST_TIMEOUT_MS`: Per-request timeout for NSE calls (default: `30000`).
- `NSE_MAX_STORED`: Max announcements retained in backend storage (default: `5000`).
- `NSE_STORAGE_FILE`: Path to local JSON store (default: `data/nse_announcements.json`).
- `BSE_LOOKBACK_DAYS`: Date lookback window used by each sync run (default: `1`).
- `BSE_REQUEST_TIMEOUT_MS`: Per-request timeout for BSE calls (default: `30000`).
- `BSE_MAX_STORED`: Max announcements retained in backend storage (default: `5000`).
- `BSE_STORAGE_FILE`: Path to local JSON store (default: `data/bse_announcements.json`).
- `BSE_PAGE_SIZE`: BSE page size for paginated API fetch (default: `100`).
- `BSE_PAGE_DELAY_MS`: Delay between BSE page fetches in ms (default: `500`).
- `COMBINED_STORAGE_FILE`: Path to deduped NSE+BSE store (default: `data/combined_announcements.json`).
- `COMBINED_MAX_STORED`: Max deduped combined announcements retained (default: `10000`).

## API endpoints

- `GET /health`
- `GET /api/health`
- `GET /api/status`
- `GET /api/notes`
- `POST /api/notes` body `{ "text": "..." }`
- `POST /api/jobs/daily` (optional secret in `x-cron-secret`)
- `POST /api/internal/worker-heartbeat` (optional secret in `x-cron-secret`)
- `GET /api/notifications/announcements?exchange=NSE|BSE|BSE+NSE|ALL&limit=100&symbol=TCS`

## Notifications sync flow (NSE + BSE)

- GitHub Actions triggers `POST /api/jobs/daily` on schedule.
- Server fetches NSE and BSE corporate announcements in the same cron run.
- BSE records are enriched with `isin` using BSE scrip master data (`ListofScripData` API) before storage.
- New records are deduplicated per exchange and stored in separate files (`NSE_STORAGE_FILE`, `BSE_STORAGE_FILE`).
- A separate deduped combined table (`COMBINED_STORAGE_FILE`) is rebuilt using ISIN + date + (attachment or subject) and served with `exchange=BSE+NSE`.
- Notifications data is served via `GET /api/notifications/announcements`.
