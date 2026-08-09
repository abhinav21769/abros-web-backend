const logger = require("../utils/logger");

const requestLogger = (req, res, next) => {
  const url = req.originalUrl || req.url;

  // Filter out health checks and root pings to prevent cluttering log window
  if (url === "/health" || url === "/") {
    return next();
  }

  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.http(req, res, duration);
  });

  next();
};

module.exports = requestLogger;
