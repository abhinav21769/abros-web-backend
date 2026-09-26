const Customer = require("../models/customer.model");
const Medicine = require("../models/medicine.model");
const { createInvoiceRecord } = require("./invoice.service");
const { buildInvoicePdf } = require("../utils/fullInvoicePdf");
const logger = require("../utils/logger");

const TELEGRAM_API = "https://api.telegram.org/bot";
const GEMINI_API =
  "https://generativelanguage.googleapis.com/v1beta/models";

let pollingStarted = false;
let pollingOffset = 0;

class AgentBillError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentBillError";
  }
}

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN;
}

function getOwnerChatId() {
  return String(process.env.TELEGRAM_OWNER_CHAT_ID || "").trim();
}

function isConfigured() {
  return Boolean(getBotToken());
}

function telegramUrl(method) {
  return `${TELEGRAM_API}${getBotToken()}/${method}`;
}

function assertOwner(chatId) {
  const ownerChatId = getOwnerChatId();
  if (!ownerChatId) {
    throw new AgentBillError(
      `Owner chat id is not configured. Your chat id is ${chatId}. Add it as TELEGRAM_OWNER_CHAT_ID.`,
    );
  }

  if (String(chatId) !== ownerChatId) {
    throw new AgentBillError("This bot is private.");
  }
}

async function sendTelegramMessage(chatId, text) {
  if (!getBotToken()) return;

  await fetch(telegramUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}

async function sendTelegramDocument(chatId, pdfBuffer, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append(
    "document",
    new Blob([pdfBuffer], { type: "application/pdf" }),
    filename,
  );

  const response = await fetch(telegramUrl("sendDocument"), {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AgentBillError(`Could not send PDF on Telegram. ${body}`);
  }
}

function extractJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AgentBillError("Gemini could not understand the bill message.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

async function fetchDatabaseContext() {
  const customers = await Customer.find({}, "name address contact gstin dlNo").lean();
  const medicines = await Medicine.find({}, "name ptr mrp rate packagingType batchNumber expiryDate hsn gstRate quantity").lean();

  const customerListText = customers
    .map(
      (c) =>
        `- ID: "${c._id}" | Name: "${c.name}" | Address: "${c.address || "N/A"}" | Contact: "${c.contact || "N/A"}"`
    )
    .join("\n");

  const medicineListText = medicines
    .map(
      (m) =>
        `- ID: "${m._id}" | Name: "${m.name}" | Rate: ${m.ptr ?? m.rate ?? m.mrp ?? 0} | Packing: "${m.packagingType || ""}"`
    )
    .join("\n");

  return { customers, medicines, customerListText, medicineListText };
}

async function parseBillMessage(message) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AgentBillError("Gemini API key is not configured.");
  }

  const dbContext = await fetchDatabaseContext();
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const prompt = [
    "You are an AI assistant for a pharmacy owner. Extract invoice billing details from the owner's message by matching entities against the provided database directory.",
    "",
    "--- DATABASE CUSTOMER DIRECTORY ---",
    dbContext.customerListText || "(No customers in database)",
    "",
    "--- DATABASE MEDICINE INVENTORY ---",
    dbContext.medicineListText || "(No medicines in database)",
    "",
    "Return only valid JSON matching this schema:",
    "{",
    '  "matchedCustomerId": "string | null",',
    '  "customerName": "string",',
    '  "paymentType": "cash|credit",',
    '  "status": "paid|pending",',
    '  "items": [',
    '    {',
    '      "matchedMedicineId": "string | null",',
    '      "medicineName": "string",',
    '      "quantity": number,',
    '      "free": number,',
    '      "rate": number | null,',
    '      "discount": number',
    "    }",
    "  ]",
    "}",
    "",
    "Matching Rules:",
    "1. CUSTOMER MATCHING (RAG): Compare the requested customer in the message against the DATABASE CUSTOMER DIRECTORY.",
    "   - Use names, partial names, shorthand, or address/city details to find the matching customer.",
    "   - If a customer shares a similar name, use address/location details in the message to disambiguate.",
    "   - If matched, set 'matchedCustomerId' to their ID and 'customerName' to their exact full DB name.",
    "   - If no customer in the database matches, set 'matchedCustomerId': null and 'customerName' to the name extracted from the message.",
    "2. MEDICINE MATCHING (RAG): Compare requested medicine names against the DATABASE MEDICINE INVENTORY.",
    "   - If matched, set 'matchedMedicineId' to its ID and 'medicineName' to its exact DB name.",
    "   - If not matched, set 'matchedMedicineId': null.",
    "3. DEFAULT VALUES:",
    "   - paymentType defaults to 'cash'. If 'credit' or 'udhaar' or 'pending' is mentioned, set 'credit'.",
    "   - status defaults to 'paid' for cash, 'pending' for credit.",
    "   - free and discount default to 0.",
    "   - quantity defaults to 1 if not specified.",
    "   - If rate is not specified in the message, set 'rate': null.",
    "",
    `Message: "${message}"`,
  ].join("\n");

  const response = await fetch(
    `${GEMINI_API}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new AgentBillError(`Gemini request failed. ${body}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const parsed = extractJson(text);

  if (
    (!parsed.customerName && !parsed.matchedCustomerId) ||
    !Array.isArray(parsed.items) ||
    !parsed.items.length
  ) {
    throw new AgentBillError(
      "Please include customer name and at least one medicine item."
    );
  }

  return parsed;
}

async function findOrCreateCustomer(name, matchedCustomerId) {
  if (matchedCustomerId) {
    const customer = await Customer.findById(matchedCustomerId);
    if (customer) return customer;
  }

  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    throw new AgentBillError("Customer name is required.");
  }

  // 1. Exact match (case insensitive)
  const exact = await Customer.findOne({
    name: { $regex: `^${escapeRegex(trimmedName)}$`, $options: "i" },
  });
  if (exact) return exact;

  // 2. Substring match (case insensitive)
  const contains = await Customer.findOne({
    name: { $regex: escapeRegex(trimmedName), $options: "i" },
  });
  if (contains) return contains;

  // 3. Word match for multi-word names
  const words = trimmedName.split(/\s+/).filter((w) => w.length > 2);
  for (const word of words) {
    const wordMatch = await Customer.findOne({
      name: { $regex: escapeRegex(word), $options: "i" },
    });
    if (wordMatch) return wordMatch;
  }

  // 4. Create new customer only if no existing customer matched
  return Customer.create({
    name: trimmedName,
    address: "Not provided",
  });
}

async function findMedicineByName(name, matchedMedicineId) {
  if (matchedMedicineId) {
    const medicine = await Medicine.findById(matchedMedicineId);
    if (medicine) return medicine;
  }

  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    throw new AgentBillError("Medicine name is required.");
  }

  const exact = await Medicine.findOne({
    name: { $regex: `^${escapeRegex(trimmedName)}$`, $options: "i" },
  });
  if (exact) return exact;

  const contains = await Medicine.findOne({
    name: { $regex: escapeRegex(trimmedName), $options: "i" },
  }).sort({ quantity: -1, expiryDate: 1 });

  if (contains) return contains;

  throw new AgentBillError(`Medicine not found: ${trimmedName}`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePaymentType(value) {
  return value === "credit" ? "credit" : "cash";
}

function normalizeStatus(value, paymentType) {
  if (value === "pending" || value === "paid" || value === "cancelled") {
    return value;
  }
  return paymentType === "credit" ? "pending" : "paid";
}

async function buildInvoicePayload(parsed) {
  const customer = await findOrCreateCustomer(
    parsed.customerName,
    parsed.matchedCustomerId
  );
  const paymentType = normalizePaymentType(parsed.paymentType);
  const status = normalizeStatus(parsed.status, paymentType);
  const items = [];

  for (const item of parsed.items) {
    const medicine = await findMedicineByName(
      item.medicineName,
      item.matchedMedicineId
    );
    const quantity = Number(item.quantity) || 1;
    const rate =
      item.rate == null || item.rate === ""
        ? Number(medicine.ptr ?? medicine.rate ?? medicine.mrp)
        : Number(item.rate);

    if (!Number.isFinite(rate) || rate < 0) {
      throw new AgentBillError(`Invalid rate for ${medicine.name}.`);
    }

    const primaryBatch = medicine.batches && medicine.batches.length > 0
      ? (medicine.batches.find((b) => b.quantity > 0) || medicine.batches[0])
      : null;

    items.push({
      medicine: medicine._id,
      medicineName: medicine.name,
      batchNumber: item.batchNumber || primaryBatch?.batchNumber || medicine.batchNumber || undefined,
      expiryDate: primaryBatch?.expiryDate || medicine.expiryDate || undefined,
      mrp: primaryBatch?.mrp ?? medicine.mrp ?? undefined,
      hsn: medicine.hsn || undefined,
      gstRate: Number(medicine.gstRate) || 5,
      discount: Number(item.discount) || 0,
      quantity,
      free: Number(item.free) || 0,
      rate,
    });
  }

  return {
    invoiceType: "sale",
    customer: customer._id,
    paymentType,
    status,
    invoiceDate: new Date(),
    items,
  };
}

async function createBillFromMessage(message) {
  const parsed = await parseBillMessage(message);
  const payload = await buildInvoicePayload(parsed);
  return createInvoiceRecord(payload);
}

async function handleTelegramMessage(message) {
  const chatId = message?.chat?.id;
  const text = String(message?.text || "").trim();

  if (!chatId || !text) return;

  if (text === "/start" || text === "/help") {
    await sendTelegramMessage(
      chatId,
      `<b>Abros Billing Bot Ready!</b>\nYour Chat ID: <code>${chatId}</code>\n\nSend any order text (e.g. <i>"Ramesh Kumar Paracetamol 10 tabs 15.50 cash"</i>) to create an invoice and receive your A4 GST Tax Invoice PDF!`,
    );
    return;
  }

  assertOwner(chatId);

  await sendTelegramMessage(chatId, "Creating invoice...");
  const invoice = await createBillFromMessage(text);
  const pdfBuffer = await buildInvoicePdf(invoice);
  const filename = `${invoice.invoiceNumber}.pdf`;
  await sendTelegramDocument(
    chatId,
    pdfBuffer,
    filename,
    `Invoice ${invoice.invoiceNumber} created. Total: Rs. ${invoice.total}`,
  );
}

async function processTelegramUpdate(update) {
  const message = update?.message || update?.edited_message;
  if (!message) return;

  try {
    await handleTelegramMessage(message);
  } catch (error) {
    const chatId = message?.chat?.id;
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        error?.message || "Could not create invoice from this message.",
      );
    }
  }
}

async function startTelegramPolling() {
  if (pollingStarted || process.env.TELEGRAM_DISABLE_POLLING === "true") {
    return;
  }

  if (!isConfigured()) {
    logger.info("Telegram polling skipped: TELEGRAM_BOT_TOKEN missing.");
    return;
  }

  pollingStarted = true;
  logger.info("Telegram billing bot polling started.");

  while (pollingStarted) {
    try {
      const response = await fetch(telegramUrl("getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: pollingOffset || undefined,
          timeout: 25,
          allowed_updates: ["message", "edited_message"],
        }),
      });
      const data = await response.json();

      for (const update of data.result || []) {
        pollingOffset = update.update_id + 1;
        await processTelegramUpdate(update);
      }
    } catch (error) {
      logger.error("Telegram polling error", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

module.exports = {
  createBillFromMessage,
  isConfigured,
  processTelegramUpdate,
  startTelegramPolling,
};
