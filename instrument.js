require("dotenv").config();
const Sentry = require("@sentry/node");

const isProduction = process.env.NODE_ENV === "production";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Send structured logs to Sentry
  enableLogs: true,

  // M-2 FIX: Use lower sample rate in production to avoid excessive quota
  tracesSampleRate: isProduction ? 0.1 : 1.0,

  environment: process.env.NODE_ENV || "development",
});
