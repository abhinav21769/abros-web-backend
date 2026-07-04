# Abros Healthcare Backend

Express + MongoDB API for medicine inventory, customers, and invoices.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Environment

| Variable | Description |
|----------|-------------|
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Secret for signing login tokens |
| `JWT_EXPIRES_IN` | Token lifetime (default: `7d`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather |
| `TELEGRAM_OWNER_CHAT_ID` | Telegram chat ID allowed to create bills |
| `TELEGRAM_ENABLE_POLLING` | Set `true` for local bot polling, `false` for webhook mode |
| `TELEGRAM_WEBHOOK_SECRET` | Random secret Telegram will send with webhook requests |
| `GEMINI_API_KEY` | Gemini API key for parsing bill messages |
| `GEMINI_MODEL` | Gemini model name, defaults to `gemini-2.5-flash` |
| `ADMIN_SECRET` | Required header secret to create users via API |
| `NODE_ENV` | Set to `production` on Render to disable Swagger |

## Authentication

All `/api/medicines`, `/api/customers`, and `/api/invoices` routes require a Bearer token.

Public routes:
- `POST /api/auth/login`
- `GET /` health check

Admin-only user creation:
- `POST /api/auth/users` with header `X-Admin-Secret: YOUR_ADMIN_SECRET`

### Create a user (CLI)

```bash
npm run create-user -- admin your-secure-password "Admin User"
```

### Create a user (API)

```bash
curl -X POST https://abros-healthcare.onrender.com/api/auth/users \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -d '{"username":"admin","password":"your-secure-password","name":"Admin User"}'
```

## API docs

Swagger is available only in development:

`http://localhost:3000/api-docs`

## Frontend

https://github.com/abhinav21769/abros-web-frontend

Live app: https://abros-healthcare.web.app

## Deploy

Backend deploys to [Render](https://render.com) via `render.yaml`.

Production API: https://abros-healthcare.onrender.com

Set `NODE_ENV=production`, `JWT_SECRET`, `ADMIN_SECRET`, Telegram, and Gemini values in Render environment variables.
