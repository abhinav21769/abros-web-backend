const Sentry = require("@sentry/node");

const { Logtail } = require("@logtail/node");

const logtailToken = process.env.LOGTAIL_TOKEN || process.env.LOGTAIL_SOURCE_TOKEN;
const sentryDsn = process.env.SENTRY_DSN;

let logtail = null;
if (logtailToken) {
  try {
    logtail = new Logtail(logtailToken);
    console.log("🪵 Logtail/BetterStack logging enabled.");
  } catch (err) {
    console.warn("⚠️ Failed to initialize Logtail:", err.message);
  }
}

const getTimestamp = () => new Date().toISOString();

const logger = {
  info: (message, meta = {}) => {
    const timestamp = getTimestamp();
    console.log(`[INFO] [${timestamp}] ${message}`, Object.keys(meta).length ? meta : "");
    if (logtail) logtail.info(message, meta).catch(() => {});
  },

  warn: (message, meta = {}) => {
    const timestamp = getTimestamp();
    console.warn(`[WARN] [${timestamp}] ${message}`, Object.keys(meta).length ? meta : "");
    if (logtail) logtail.warn(message, meta).catch(() => {});
  },

  error: (message, errorOrMeta = {}) => {
    const timestamp = getTimestamp();
    const isErrorObj = errorOrMeta instanceof Error;
    const meta = isErrorObj
      ? { errorMessage: errorOrMeta.message, stack: errorOrMeta.stack }
      : errorOrMeta;

    console.error(`[ERROR] [${timestamp}] ${message}`, meta);

    if (logtail) {
      logtail.error(message, meta).catch(() => {});
    }

    if (sentryDsn) {
      if (isErrorObj) {
        Sentry.captureException(errorOrMeta, { extra: { customMessage: message } });
      } else {
        Sentry.captureMessage(`${message} - ${JSON.stringify(meta)}`);
      }
    }
  },

  http: (req, res, responseTimeMs) => {
    const timestamp = getTimestamp();
    const statusCode = res.statusCode;
    const method = req.method;
    const url = req.originalUrl || req.url;
    const logMsg = `${method} ${url} ${statusCode} - ${responseTimeMs}ms`;

    if (statusCode >= 500) {
      console.error(`[HTTP-500] [${timestamp}] ${logMsg}`);
      if (logtail) logtail.error(logMsg, { statusCode, method, url, responseTimeMs }).catch(() => {});
    } else if (statusCode >= 400) {
      console.warn(`[HTTP-400] [${timestamp}] ${logMsg}`);
      if (logtail) logtail.warn(logMsg, { statusCode, method, url, responseTimeMs }).catch(() => {});
    } else {
      console.log(`[HTTP] [${timestamp}] ${logMsg}`);
      if (logtail) logtail.info(logMsg, { statusCode, method, url, responseTimeMs }).catch(() => {});
    }
  },
};

module.exports = logger;
