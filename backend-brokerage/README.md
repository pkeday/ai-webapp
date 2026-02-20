# Brokerage Backend (Phase 1 + 1.5)

This is a separate backend service for Sub-app 1 (Brokerage Emails).

It provides:
- Google OAuth sign-in + session handling
- Gmail connection + token storage (encrypted)
- Gmail label discovery and label-scoped ingest preferences
- Daily scheduler support via `/api/jobs/daily` (ingests only new emails using a moving cursor)
- Archive of raw `.eml` + attachments
- Secure share links for archived files
- Postgres-backed permanent state snapshot (`brokerage_app_state` table)

## Run locally

```bash
cd /Users/parikshitkabra/Projects/codex_projects/ai-webapp/backend-brokerage
cp .env.example .env
node src/server.js
```

## Important env vars

- `PORT`: API port (default `10001`).
- `BROKERAGE_DATA_DIR`: Optional data directory for db/archive storage. Relative values resolve from `backend-brokerage/`.
- `APP_ENV`: Set `production` in Render.
- `AUTH_SECRET`: Required in production. Used to sign auth/session tokens.
- `TOKEN_ENCRYPTION_KEY`: Required in production. Used to encrypt Google tokens at rest.
- `CORS_ORIGIN`: Required in production (for example `https://pkeday.github.io`).
- `CRON_SECRET`: Optional but recommended in production. Required header for scheduler endpoint.
- `DATABASE_URL`: Optional Postgres connection string. When set, state is stored in Postgres and mirrored to file snapshot.
- `DATABASE_SSL_MODE`: `require` (Render production) or `disable` (local).
- `DATABASE_MAX_CONNECTIONS`: Connection pool max (default `5`).

## Main endpoints

- `GET /api/health`
- `GET /api/auth/google/url`
- `GET /api/auth/google/callback`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/gmail/labels`
- `GET /api/gmail/preferences`
- `PUT /api/gmail/preferences`
- `POST /api/gmail/ingest`
- `POST /api/jobs/daily`
- `GET /api/email-archives`
- `GET /api/email-archives/:id/raw`
- `GET /api/email-archives/:id/attachments/:index`
- `POST /api/email-archives/:id/share-links`
- `GET /api/shared/file?token=...`
