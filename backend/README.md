# Backend + Jobs (Cron-Only Pipeline)

This backend is intentionally dependency-light so it can run without extra setup.

## Scripts

```bash
npm start         # API server
npm run cron      # one-time cron execution (calls /api/jobs/daily)
npm run worker    # legacy async worker (kept idle by hardcoded setting)
npm run check     # syntax checks
```

Production setup in this project (default):
- API runs on Render web service.
- Cron trigger runs via GitHub Actions schedule and calls `POST /api/jobs/daily`.
- Pipeline executes in-order inside the cron route: `NSE/BSE ingest -> dedup -> AI classify`.
- Cron window is hardcoded to `09:00-21:00` (`Asia/Kolkata`).
- Legacy worker/AI-only endpoints are hardcoded off.

## Important env vars

- `PORT`: API server port (Render sets this automatically).
- `CORS_ORIGIN`: Comma-separated allowed frontend origins.
- `CRON_SECRET`: Shared secret for worker/cron protected API routes.
- `API_BASE_URL`: API URL used by worker/cron scripts.
- `WORKER_INTERVAL_SECONDS`: Legacy worker poll interval (default: `60`).
- `WORKER_HEARTBEAT_SECONDS`: Legacy worker heartbeat interval (default: `20`).
- `WORKER_REQUEST_TIMEOUT_MS`: Legacy worker request timeout (default: `180000`).
- `WORKER_LOOP_DELAY_MS`: Legacy worker delay between chunks (default: `200`).
- `WORKER_ID`: Optional static legacy worker identifier.
- `WORKER_ALLOWED_JOB_TYPES`: Legacy worker job types (default: `ai-classification`).
- `DATABASE_URL`: Postgres connection string for durable storage.
- `DATABASE_SSL_MODE`: `require` in Render production, `disable` for local DB.
- `DATABASE_MAX_CONNECTIONS`: PG pool max connections (default: `10`).
- `DATABASE_CONNECTION_TIMEOUT_MS`: PG connect timeout (default: `10000`).
- `DATABASE_IDLE_TIMEOUT_MS`: PG idle timeout (default: `30000`).
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
- `AI_CRITERIA_VERSION`: Prompt/version tag used for idempotent reclassification (default: `v2`).
- `AI_LABELS_STORAGE_FILE`: Path to AI label store (fallback when Postgres unavailable).
- `AI_REVIEWS_STORAGE_FILE`: Path to reviewer corrections store (default: `data/announcement_ai_reviews.json`).
- `AI_SUGGESTIONS_STORAGE_FILE`: Path to category suggestion store.
- `AI_PROMPT_LEARNING_MIN_EXAMPLES`: Min reviewed mismatches needed before adding a learned prompt rule (default: `2`).
- `AI_PROMPT_LEARNING_MAX_RULES`: Max learned prompt rules injected into classifier system prompt (default: `8`).
- `AI_MAX_ITEMS_PER_CRON`: Max dedup announcements sent to models per cron run (default: `120`).
- `AI_ASYNC_CHUNK_SIZE`: Legacy async chunk size (used only if legacy endpoints are enabled in code).
- `AI_ASYNC_MAX_LOOPS`: Legacy async loop limit (used only if legacy endpoints are enabled in code).
- `AI_CLASSIFICATION_CONCURRENCY`: Parallel AI classification workers (default: `2`).
- `AI_PDF_FETCH_TIMEOUT_MS`: Timeout for PDF download before classification (default: `30000`).
- `AI_PDF_FETCH_MAX_ATTEMPTS`: Max PDF download attempts (default: `3`).
- `AI_PDF_PARSE_MAX_ATTEMPTS`: Max parse attempts per fetched PDF (default: `2`).
- `AI_PDF_RETRY_DELAY_MS`: Base delay between PDF retries in milliseconds (default: `1200`).
- `AI_PDF_MIN_BYTES`: Minimum PDF payload size before parsing (default: `1024`).
- `AI_PRIMARY_MAX_PAGES`: Pages sent in stage-1 classification (default: `4`).
- `AI_ESCALATION_MAX_PAGES`: Pages sent in stage-2 escalation (default: `12`).
- `AI_ESCALATION_CONFIDENCE_THRESHOLD`: Escalation threshold (default: `0.8`).
- `AI_MIN_READABLE_CHARS`: Min extracted text chars to treat PDF as machine-readable (default: `700`).
- `AI_FAILURE_RETRY_HOURS`: Retry cooldown for failed classifications (default: `24`).
- `AI_TRANSIENT_FAILURE_RETRY_MINUTES`: Retry cooldown for transient failures (`fetch_failed`, `parse_failed`, `page_invalid`, `provider_failed`; default: `60`).
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
- `GET /api/notifications/announcements?exchange=NSE|BSE|NSE+BSE|DEDUP|ALL&limit=100&symbol=TCS`
- `GET /api/ai/categories`
- `POST /api/ai/reviews/bulk` body `{ "reviews": [{ "dedupAnnouncementKey": "...", "reviewedLabel": "..." }] }`

Legacy endpoints (disabled by default; require code change):
- `POST /api/jobs/ai-only`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/internal/worker-heartbeat`
- `POST /api/internal/jobs/claim`
- `POST /api/internal/jobs/:id/heartbeat`
- `POST /api/internal/jobs/:id/complete`
- `POST /api/internal/jobs/:id/fail`
- `POST /api/internal/ai/run-chunk`

## Notifications sync flow (NSE + BSE)

- GitHub Actions triggers `POST /api/jobs/daily` on schedule.
- Server fetches NSE and BSE corporate announcements in the same cron run (incremental append-only by announcement key).
- BSE records are enriched with `isin` using BSE scrip master data (`ListofScripData` API) before storage.
- New records are deduplicated per exchange and persisted to Postgres snapshot storage.
- Combined union table (`exchange=NSE+BSE`) and dedup table (`exchange=DEDUP`) are refreshed only when source stores changed.
- AI classification runs after dedup refresh and targets new/changed dedup rows only.
- If Postgres is unavailable, backend falls back to local JSON files (`NSE_STORAGE_FILE`, `BSE_STORAGE_FILE`, `COMBINED_STORAGE_FILE`, `DEDUP_STORAGE_FILE`, `AI_LABELS_STORAGE_FILE`, `AI_REVIEWS_STORAGE_FILE`).
- AI labels persist in Postgres snapshot storage and are incrementally appended/updated by key.
- Reviewed labels are stored separately and returned in Dedup API rows as `review_label`; reviewed mismatches are used to inject learned prompt guidance automatically in later AI runs.
- Default cron window is `09:00` to `21:00` in `Asia/Kolkata`; runs outside window are skipped unless payload includes `"force": true`.
- Notifications data is served via `GET /api/notifications/announcements`.
