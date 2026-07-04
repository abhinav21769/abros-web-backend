const { ERROR_CODES, sendSuccess, sendError } = require("../utils/response");
const {
  isConfigured,
  processTelegramUpdate,
} = require("../services/telegramBot.service");

const getTelegramStatus = async (req, res) => {
  return sendSuccess(res, {
    data: {
      configured: isConfigured(),
      polling: process.env.TELEGRAM_ENABLE_POLLING === "true",
      ownerChatIdSet: Boolean(process.env.TELEGRAM_OWNER_CHAT_ID),
    },
  });
};

const handleWebhook = async (req, res) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (
    expectedSecret &&
    req.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret
  ) {
    return sendError(res, {
      message: "Unauthorized Telegram webhook request.",
      code: ERROR_CODES.UNAUTHORIZED,
      errorMessage: "Unauthorized Telegram webhook request.",
      statusCode: 401,
    });
  }

  await processTelegramUpdate(req.body);
  return sendSuccess(res, { data: { ok: true } });
};

module.exports = {
  getTelegramStatus,
  handleWebhook,
};
