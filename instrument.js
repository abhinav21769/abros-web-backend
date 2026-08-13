require("dotenv").config();
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Send structured logs to Sentry
  enableLogs: true,

  // Tracing
  tracesSampleRate: 1.0, // Capture 100% of transactions

  environment: process.env.NODE_ENV || "development",
});
