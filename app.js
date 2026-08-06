require("dotenv").config();
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

const app = express();
const isProduction = process.env.NODE_ENV === "production";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.use((err, req, res, next) => {
  console.error(err.stack);
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

const startServer = async () => {
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
