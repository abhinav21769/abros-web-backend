require("./instrument.js");
require("dotenv").config();
const Sentry = require("@sentry/node");
const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const connectDB = require("./src/config/database");
const swaggerDocument = require("./src/config/swagger");
const authRoutes = require("./src/routes/auth.routes");
const medicineRoutes = require("./src/routes/medicine.routes");
const customerRoutes = require("./src/routes/customer.routes");
const invoiceRoutes = require("./src/routes/invoice.routes");
const purchaseRoutes = require("./src/routes/purchase.routes");
const ledgerRoutes = require("./src/routes/ledger.routes");
const dashboardRoutes = require("./src/routes/dashboard.routes");
const gstRoutes = require("./src/routes/gst.routes");
const telegramRoutes = require("./src/routes/telegram.routes");
const { authenticate } = require("./src/middleware/auth.middleware");
const { ERROR_CODES, sendSuccess, sendError } = require("./src/utils/response");
const { ERRORS } = require("./src/utils/messages");
const { startTelegramPolling } = require("./src/services/telegramBot.service");

const logger = require("./src/utils/logger");
const requestLogger = require("./src/middleware/requestLogger");

const app = express();
const isProduction = process.env.NODE_ENV === "production";

// C-2 FIX: Restrict CORS to known allowed origins instead of wildcard
const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ||
  "http://localhost:5173,http://localhost:4173,https://abros-healthcare.web.app"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, server-to-server)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: Origin '${origin}' not allowed`));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

if (!isProduction) {
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});


app.get("/", (req, res) => {
  return sendSuccess(res, {
    message: "Abros Healthcare - Medicine Inventory Management System",
    data: {
      version: "1.0.0",
      endpoints: {
        auth: "/api/auth",
        medicines: "/api/medicines",
        customers: "/api/customers",
        invoices: "/api/invoices",
        purchases: "/api/purchases",
        ledger: "/api/ledger",
        dashboard: "/api/dashboard",
        gst: "/api/gst",
        telegram: "/api/telegram",
        ...(isProduction ? {} : { swagger: "/api-docs" }),
      },
    },
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/telegram", telegramRoutes);
app.use("/api/medicines", authenticate, medicineRoutes);
app.use("/api/customers", authenticate, customerRoutes);
app.use("/api/invoices", authenticate, invoiceRoutes);
app.use("/api/purchases", authenticate, purchaseRoutes);
app.use("/api/ledger", authenticate, ledgerRoutes);
app.use("/api/dashboard", authenticate, dashboardRoutes);
app.use("/api/gst", authenticate, gstRoutes);

Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, next) => {
  logger.error("Unhandled API Error", err);
  return sendError(res, {
    message: ERRORS.generic,
    code: ERROR_CODES.INTERNAL_ERROR,
    errorMessage: ERRORS.generic,
    statusCode: 500,
  });
});

app.use((req, res) => {
  return sendError(res, {
    message: ERRORS.notFound.route,
    code: ERROR_CODES.ROUTE_NOT_FOUND,
    errorMessage: ERRORS.notFound.route,
    statusCode: 404,
  });
});

const PORT = process.env.PORT || 3000;

const validateEnvironment = () => {
  // M-1 FIX: Exit process on missing critical env vars instead of just warning
  const critical = ["MONGO_URI", "JWT_SECRET"];
  const missing = critical.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      `[CONFIG ERROR] Missing critical environment variables: ${missing.join(", ")}. Server cannot start.`,
    );
    process.exit(1);
  }
};

const startServer = async () => {
  validateEnvironment();
  await connectDB();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${PORT}`);
    startTelegramPolling();
  });
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}

module.exports = app;
