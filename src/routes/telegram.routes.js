const express = require("express");
const router = express.Router();
const telegramController = require("../controller/telegram.controller");
const { requireAdminSecret } = require("../middleware/auth.middleware");

// C-3 FIX: Protect status and setup-webhook with admin secret
router.get("/status", requireAdminSecret, telegramController.getTelegramStatus);
router.get("/setup-webhook", requireAdminSecret, telegramController.setupWebhook);
router.post("/webhook", telegramController.handleWebhook);

module.exports = router;
