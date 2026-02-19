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
- `COMBINED_STORAGE_FILE`: Path to NSE+BSE no-dedup union store (default: `data/combined_announcements.json`).
- `COMBINED_MAX_STORED`: Max combined announcements retained (default: `10000`).
- `DEDUP_STORAGE_FILE`: Path to deduped NSE+BSE store (default: `data/dedup_announcements.json`).
- `DEDUP_MAX_STORED`: Max deduped announcements retained (default: `10000`).
- `PDF_HASH_TIMEOUT_MS`: Timeout used when downloading PDFs for hashing (default: `20000`).
- `PDF_HASH_CONCURRENCY`: Parallel PDF hash workers during dedup rebuild (default: `4`).
- `AI_CLASSIFIER_ENABLED`: Gate for AI classification (`true` to enable; default: `false`).
- `AI_CRITERIA_VERSION`: Prompt/version tag used for idempotent reclassification (default: `v1`).
- `AI_MAX_ITEMS_PER_CRON`: Max dedup announcements sent to models per cron run (default: `120`).
- `AI_CLASSIFICATION_CONCURRENCY`: Parallel AI classification workers (default: `2`).
- `AI_PRIMARY_MAX_PAGES`: Pages sent in stage-1 classification (default: `4`).
- `AI_ESCALATION_MAX_PAGES`: Pages sent in stage-2 escalation (default: `12`).
- `AI_ESCALATION_CONFIDENCE_THRESHOLD`: Escalation threshold (default: `0.8`).
- `AI_MIN_READABLE_CHARS`: Min extracted text chars to treat PDF as machine-readable (default: `700`).
- `AI_FAILURE_RETRY_HOURS`: Retry cooldown for failed classifications (default: `24`).
- `OPENAI_API_KEY`: OpenAI API key for machine-readable announcements.
- OpenAI models are fixed in code to `gpt-5-nano` (stage-1) and `gpt-5-mini` (stage-2).
- `GEMINI_API_KEY`: Gemini API key for scanned/image-heavy announcements.
- `AI_GEMINI_STAGE1_MODEL`: Low-cost Gemini stage-1 model (default: `gemini-2.5-flash-lite`).
- `AI_GEMINI_STAGE2_MODEL`: Escalation Gemini model (default: `gemini-2.5-flash`).
- `CLAUDE_API_KEY`: Anthropic key (fallback provider for machine-readable text).
- `AI_ANTHROPIC_STAGE1_MODEL`: Low-cost Anthropic stage-1 model (default: `claude-3-5-haiku-latest`).
- `AI_ANTHROPIC_STAGE2_MODEL`: Escalation Anthropic model (default: `claude-3-5-sonnet-latest`).

## API endpoints

- `GET /health`
- `GET /api/health`
- `GET /api/status`
- `GET /api/notes`
- `POST /api/notes` body `{ "text": "..." }`
- `POST /api/jobs/daily` (optional secret in `x-cron-secret`)
- `POST /api/internal/worker-heartbeat` (optional secret in `x-cron-secret`)
- `GET /api/notifications/announcements?exchange=NSE|BSE|NSE+BSE|DEDUP|ALL&limit=100&symbol=TCS`

## Notifications sync flow (NSE + BSE)

- GitHub Actions triggers `POST /api/jobs/daily` on schedule.
- Server fetches NSE and BSE corporate announcements in the same cron run.
- BSE records are enriched with `isin` using BSE scrip master data (`ListofScripData` API) before storage.
- New records are deduplicated per exchange and stored in separate files (`NSE_STORAGE_FILE`, `BSE_STORAGE_FILE`).
- A separate combined union table (`COMBINED_STORAGE_FILE`) is rebuilt as `exchange=NSE+BSE` (no dedup).
- A separate dedup table (`DEDUP_STORAGE_FILE`) is rebuilt using `ISIN + PDF hash` and served with `exchange=DEDUP`.
- If enabled, AI classification runs after dedup in the same cron run and stores per-announcement labels in `data/announcement_ai_labels.json`.
- Notifications data is served via `GET /api/notifications/announcements`.
