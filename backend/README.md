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

## API endpoints

- `GET /health`
- `GET /api/health`
- `GET /api/status`
- `GET /api/notes`
- `POST /api/notes` body `{ "text": "..." }`
- `POST /api/jobs/daily` (optional secret in `x-cron-secret`)
- `POST /api/internal/worker-heartbeat` (optional secret in `x-cron-secret`)
