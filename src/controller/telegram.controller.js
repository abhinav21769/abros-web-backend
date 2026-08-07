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

const setupWebhook = async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return sendError(res, {
      message: "TELEGRAM_BOT_TOKEN environment variable is not configured.",
      code: ERROR_CODES.VALIDATION_ERROR,
      statusCode: 400,
    });
  }

  const webhookUrl =
    process.env.TELEGRAM_WEBHOOK_URL ||
    "https://abros-healthcare.onrender.com/api/telegram/webhook";
  const secret =
    process.env.TELEGRAM_WEBHOOK_SECRET ||
    "6ad4d46827d7a49b8ab1dcd60de5fe24118198ac5061de28f5540ed2551329ef";

  try {
    const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}&secret_token=${encodeURIComponent(secret)}`;
    const response = await fetch(url);
    const data = await response.json();
    return sendSuccess(res, { data });
  } catch (error) {
    return sendError(res, {
      message: error.message || "Failed to set Telegram webhook",
      code: ERROR_CODES.INTERNAL_ERROR,
      statusCode: 500,
    });
  }
};

module.exports = {
  getTelegramStatus,
  handleWebhook,
  setupWebhook,
};
