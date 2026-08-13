# Abros Healthcare Backend - Agent Instructions

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with nodemon (NODE_ENV=development) |
| `npm start` | Start production server (NODE_ENV=production) |
| `npm run create-user` | Create admin user via CLI |
| `npm run migrate-batches` | Run batch migration script |

## Environment Variables

Critical (server exits if missing):
- `MONGO_URI` - MongoDB connection string
- `JWT_SECRET` - Token signing secret

Optional but required for features:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, `TELEGRAM_ENABLE_POLLING`, `TELEGRAM_WEBHOOK_SECRET`
- `GEMINI_API_KEY`, `GEMINI_MODEL`
- `ADMIN_SECRET` - Header secret for API user creation
- `CORS_ALLOWED_ORIGINS` - Comma-separated origins (default: localhost:5173, localhost:4173, production frontend)
- `SENTRY_DSN` - Error tracking

## Architecture

- **Entry point**: `app.js` → validates env, connects MongoDB, starts Express + Telegram polling
- **Auth**: JWT Bearer tokens; `authenticate` middleware protects all `/api/*` except `/api/auth` and `/api/telegram`
- **Admin user creation**: `POST /api/auth/users` with `X-Admin-Secret` header
- **Swagger**: Only in development at `/api-docs`
- **Sentry**: Initialized in `instrument.js` (loaded first in app.js); lower trace sample rate in prod

## Key Files

- `src/config/database.js` - MongoDB connection
- `src/middleware/auth.middleware.js` - JWT verification
- `src/utils/response.js` - Standardized API responses (`sendSuccess`, `sendError`)
- `src/utils/messages.js` - Error message constants
- `src/services/telegramBot.service.js` - Bot polling/webhook logic

## Deployment

- Render via `render.yaml`: `npm install` → `npm start`
- Health check: `GET /health`
- Set `NODE_ENV=production` in Render env vars
- Swagger disabled in production

## Gotchas

- Server exits on missing `MONGO_URI` or `JWT_SECRET` (see `validateEnvironment` in app.js:116)
- CORS uses explicit allowlist, not wildcard (app.js:30-48)
- Telegram polling starts automatically on server start (app.js:134)
- No test suite configured (`npm test` returns error)