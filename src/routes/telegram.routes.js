const express = require("express");
const router = express.Router();
const telegramController = require("../controller/telegram.controller");

router.get("/status", telegramController.getTelegramStatus);
router.post("/webhook", telegramController.handleWebhook);

module.exports = router;
