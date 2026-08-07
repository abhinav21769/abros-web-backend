const express = require("express");
const router = express.Router();
const telegramController = require("../controller/telegram.controller");

router.get("/status", telegramController.getTelegramStatus);
router.get("/setup-webhook", telegramController.setupWebhook);
router.post("/webhook", telegramController.handleWebhook);

module.exports = router;
