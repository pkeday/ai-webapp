# Brokerage Backend (Phase 1 + 1.5)

This is a separate backend service for Sub-app 1 (Brokerage Emails).

It provides:
- Google OAuth sign-in + session handling
- Gmail connection + token storage (encrypted)
- Gmail ingest of source emails
- Archive of raw `.eml` + attachments
- Secure share links for archived files

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

## Main endpoints

- `GET /api/health`
- `GET /api/auth/google/url`
- `GET /api/auth/google/callback`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/gmail/ingest`
- `GET /api/email-archives`
- `GET /api/email-archives/:id/raw`
- `GET /api/email-archives/:id/attachments/:index`
- `POST /api/email-archives/:id/share-links`
- `GET /api/shared/file?token=...`
