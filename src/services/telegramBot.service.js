const Customer = require("../models/customer.model");
const Invoice = require("../models/invoice.model");
const Medicine = require("../models/medicine.model");
const {
  createInvoiceRecord,
  populateInvoice,
  updateInvoiceRecord,
} = require("./invoice.service");
const { AgentBillError, interpretMessage } = require("./billAssistant.service");
const {
  answerChoice,
  applyInterpretation,
  createDraft,
  draftFromInvoice,
  draftProblems,
  draftToCreatePayload,
  draftToUpdatePayload,
  escapeHtml,
  formatDraft,
  money,
} = require("./billDraft.service");
const { InsufficientStockError } = require("./inventory.service");
const {
  buildPendingReport,
  buildStockReport,
  buildTodayReport,
} = require("./telegramCommands.service");
const { buildInvoicePdf } = require("../utils/fullInvoicePdf");
const { getUserMessage } = require("../utils/messages");
const logger = require("../utils/logger");

const TELEGRAM_API = "https://api.telegram.org/bot";
const DRAFT_TTL_MS = 30 * 60 * 1000;

// Button taps arrive as "callback_query" updates. A webhook registered without
// this type never receives them, so the buttons would do nothing at all.
const UPDATE_TYPES = ["message", "edited_message", "callback_query"];

let pollingStarted = false;
let pollingOffset = 0;

// One owner, one chat: the open draft and the last bill live in memory. They
// are lost on a restart, which only costs the owner re-typing a prompt - a draft
// is never a saved record.
const sessions = new Map();
const chatQueues = new Map();

const HELP_TEXT = [
  "<b>Abros Billing Bot</b>",
  "",
  "Type a bill the way you would say it:",
  "<i>20 rosmont for rishi gautam</i>",
  "<i>paracetamol 10 + 2 free, dolo 5 at 30 rate for sharma medical, credit</i>",
  "",
  "I will show a draft - tap <b>Confirm</b> to create the bill, and the PDF comes back here.",
  "",
  "Change a draft or the last bill by just saying so:",
  "<i>add 5 free on rosmont</i> · <i>10% discount on all</i> · <i>make it credit</i>",
  "<i>remove dolo</i> · <i>change customer to gupta</i> · <i>edit AH-2026-045 qty of rosmont 30</i>",
  "<i>delete the bill</i> (asks first)",
  "",
  "<b>Commands</b>",
  "/last - send the last bill again",
  "/bill AH-2026-045 - send a bill by number",
  "/today - today's sales",
  "/pending - unpaid credit bills",
  "/stock rosmont - stock and expiry of a medicine",
  "/cancel - drop the open draft",
].join("\n");

// Shown in Telegram's "/" menu.
const BOT_COMMANDS = [
  { command: "last", description: "Send the last bill again" },
  { command: "bill", description: "Send a bill by number, e.g. /bill AH-2026-045" },
  { command: "today", description: "Today's sales" },
  { command: "pending", description: "Unpaid credit bills" },
  { command: "stock", description: "Stock and expiry, e.g. /stock rosmont" },
  { command: "cancel", description: "Drop the open draft" },
  { command: "help", description: "How to use the bot" },
];

const getBotToken = () => process.env.TELEGRAM_BOT_TOKEN;
const getOwnerChatId = () => String(process.env.TELEGRAM_OWNER_CHAT_ID || "").trim();
const isConfigured = () => Boolean(getBotToken());
const telegramUrl = (method) => `${TELEGRAM_API}${getBotToken()}/${method}`;

const assertOwner = (chatId) => {
  const ownerChatId = getOwnerChatId();
  if (!ownerChatId) {
    throw new AgentBillError(
      `Owner chat id is not configured. Your chat id is ${chatId}. Add it as TELEGRAM_OWNER_CHAT_ID.`,
    );
  }

  if (String(chatId) !== ownerChatId) {
    throw new AgentBillError("This bot is private.");
  }
};

const telegramCall = async (method, payload) => {
  if (!getBotToken()) return null;

  const response = await fetch(telegramUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    logger.error(`Telegram ${method} failed`, new Error(await response.text()));
  }
  return response;
};

const sendTelegramMessage = (chatId, text, buttons) =>
  telegramCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });

const registerBotCommands = () =>
  telegramCall("setMyCommands", { commands: BOT_COMMANDS }).catch(() => null);

const getWebhookInfo = async () => {
  const response = await telegramCall("getWebhookInfo", {});
  if (!response?.ok) return null;
  const data = await response.json();
  return data?.result || null;
};

// A webhook set up before the buttons existed lists only message updates, so
// Telegram would silently drop every tap. Re-registering the same URL with
// callback_query added fixes it without anyone having to remember to.
const ensureWebhookReceivesButtonTaps = async (info) => {
  const current = info?.allowed_updates;
  // An empty or missing list means "everything", which already includes taps.
  if (!info?.url || !current?.length || current.includes("callback_query")) return;

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  await telegramCall("setWebhook", {
    url: info.url,
    allowed_updates: [...new Set([...current, "callback_query"])],
    ...(secret ? { secret_token: secret } : {}),
  });
  logger.info("Telegram webhook updated to receive button taps.");
};

const clearButtons = (message) => {
  if (!message?.chat?.id || !message?.message_id) return null;
  return telegramCall("editMessageReplyMarkup", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => null);
};

const sendTelegramDocument = async (chatId, pdfBuffer, filename, caption) => {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
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
};

const sendInvoicePdf = async (chatId, invoice, caption) => {
  const pdfBuffer = await buildInvoicePdf(invoice);
  await sendTelegramDocument(chatId, pdfBuffer, `${invoice.invoiceNumber}.pdf`, caption);
};

const loadCatalog = async () => {
  const [customers, medicines] = await Promise.all([
    Customer.find({}, "name address contact").lean(),
    Medicine.find({}, "name packagingType ptr rate mrp hsn gstRate quantity").lean(),
  ]);
  return { customers, medicines };
};

const getSession = (chatId) => {
  const key = String(chatId);
  let session = sessions.get(key);
  if (!session) {
    session = { draft: null, lastInvoiceId: null, updatedAt: Date.now() };
    sessions.set(key, session);
  }

  if (session.draft && Date.now() - session.updatedAt > DRAFT_TTL_MS) {
    session.draft = null;
  }
  session.updatedAt = Date.now();
  return session;
};

const summarizeDraft = (draft) => {
  const lines = [
    draft.mode === "edit" ? `Bill ${draft.invoiceNumber}` : "Draft bill (not saved yet)",
    `Customer: ${draft.customer?.name || "not set"}; payment: ${draft.paymentType}`,
  ];
  draft.items.forEach((line, index) => {
    lines.push(
      `#${index + 1} ${line.name} qty ${line.quantity} free ${line.free} rate ${line.rate ?? "none"} discount ${line.discount}%`,
    );
  });
  return lines.join("\n");
};

const findSaleInvoice = async (session, invoiceNumber) => {
  let invoice = null;

  if (invoiceNumber) {
    invoice = await Invoice.findOne({
      invoiceNumber,
      invoiceType: { $ne: "purchase" },
    });
  } else if (session.lastInvoiceId) {
    invoice = await Invoice.findOne({
      _id: session.lastInvoiceId,
      invoiceType: { $ne: "purchase" },
    });
  }

  // After a restart the bot forgets which bill was last; the newest sale is the
  // natural reading of "the bill", and the draft always names it before saving.
  if (!invoice && !invoiceNumber) {
    invoice = await Invoice.findOne({ invoiceType: { $ne: "purchase" } }).sort({
      createdAt: -1,
    });
  }

  return invoice ? populateInvoice(invoice) : null;
};

const truncate = (text, length) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

const choiceKeyboard = (draft, choice) => {
  const rows = choice.candidates.map((candidate, index) => {
    const label =
      choice.kind === "customer"
        ? `${candidate.name}${candidate.address ? ` - ${candidate.address}` : ""}`
        : `${candidate.name}${candidate.packaging ? ` (${candidate.packaging})` : ""} · stock ${candidate.stock}`;
    return [{ text: truncate(label, 60), callback_data: `pick:${draft.id}:${index}` }];
  });

  if (choice.kind === "customer") {
    rows.push([
      {
        text: truncate(`➕ New customer "${choice.query}"`, 60),
        callback_data: `pick:${draft.id}:new`,
      },
    ]);
  } else {
    rows.push([{ text: "Skip this item", callback_data: `pick:${draft.id}:skip` }]);
  }
  rows.push([{ text: "❌ Discard", callback_data: `no:${draft.id}` }]);
  return rows;
};

const sendDraft = async (chatId, session) => {
  const { draft } = session;

  if (draft.mode === "cancel") {
    await sendTelegramMessage(
      chatId,
      `<b>🗑 Delete ${escapeHtml(draft.invoiceNumber)}?</b>\n${escapeHtml(draft.customerName)} - ${money(draft.total)}\nStock will be put back and the bill number is freed.`,
      [
        [
          { text: "🗑 Yes, delete", callback_data: `ok:${draft.id}` },
          { text: "Keep it", callback_data: `no:${draft.id}` },
        ],
      ],
    );
    return;
  }

  const preview = formatDraft(draft);

  if (draft.choices.length) {
    const choice = draft.choices[0];
    const question =
      choice.kind === "customer"
        ? choice.candidates.length
          ? `Which customer is <b>"${escapeHtml(choice.query)}"</b>?`
          : `I can't find a customer called <b>"${escapeHtml(choice.query)}"</b>.`
        : `Which medicine is <b>"${escapeHtml(choice.query)}"</b>?`;

    await sendTelegramMessage(
      chatId,
      `${preview}\n\n${question}`,
      choiceKeyboard(draft, choice),
    );
    return;
  }

  const problems = draftProblems(draft);
  if (problems.length) {
    await sendTelegramMessage(
      chatId,
      `${preview}\n\n${problems.map((p) => `• ${escapeHtml(p)}`).join("\n")}`,
      [[{ text: "❌ Discard", callback_data: `no:${draft.id}` }]],
    );
    return;
  }

  await sendTelegramMessage(chatId, preview, [
    [
      {
        text: draft.mode === "edit" ? "✅ Save changes" : "✅ Create bill",
        callback_data: `ok:${draft.id}`,
      },
      { text: "❌ Discard", callback_data: `no:${draft.id}` },
    ],
  ]);
};

const startCancelDraft = async (chatId, session, invoiceNumber) => {
  const invoice = await findSaleInvoice(session, invoiceNumber);
  if (!invoice) {
    await sendTelegramMessage(chatId, "I could not find that bill.");
    return;
  }

  const draft = createDraft();
  draft.mode = "cancel";
  draft.invoiceId = String(invoice._id);
  draft.invoiceNumber = invoice.invoiceNumber;
  draft.customerName = invoice.customer?.name || "Unknown customer";
  draft.total = invoice.total;
  session.draft = draft;
  await sendDraft(chatId, session);
};

const handleBillingMessage = async (chatId, text) => {
  const session = getSession(chatId);

  await telegramCall("sendChatAction", { chat_id: chatId, action: "typing" });

  const interpretation = await interpretMessage(
    text,
    session.draft && session.draft.mode !== "cancel" ? summarizeDraft(session.draft) : null,
  );
  const catalog = await loadCatalog();

  if (interpretation.intent === "other") {
    await sendTelegramMessage(chatId, HELP_TEXT);
    return;
  }

  if (interpretation.intent === "cancel_invoice") {
    await startCancelDraft(chatId, session, interpretation.invoiceNumber);
    return;
  }

  const openDraft =
    session.draft && session.draft.mode !== "cancel" ? session.draft : null;

  // "add 5 paracetamol" while a draft is open is a change to it, even when the
  // AI read it as a fresh bill because no customer was named.
  const isEdit =
    interpretation.intent === "edit" ||
    (interpretation.intent === "create" && openDraft && !interpretation.customerName);

  if (isEdit) {
    let draft = openDraft;
    if (!draft) {
      const invoice = await findSaleInvoice(session, interpretation.invoiceNumber);
      if (!invoice) {
        await sendTelegramMessage(
          chatId,
          "There is no bill to change yet. Create one first, or name it: <i>edit AH-2026-045 ...</i>",
        );
        return;
      }
      draft = draftFromInvoice(invoice, catalog);
    }
    applyInterpretation(draft, interpretation, catalog);
    session.draft = draft;
    await sendDraft(chatId, session);
    return;
  }

  const draft = createDraft();
  applyInterpretation(draft, interpretation, catalog);
  if (!interpretation.customerName) {
    draft.notes.push("I did not catch a customer name.");
  }
  session.draft = draft;
  await sendDraft(chatId, session);
};

const confirmDraft = async (chatId, session) => {
  const { draft } = session;

  if (draft.confirming) return;

  if (draft.mode !== "cancel") {
    const problems = draftProblems(draft);
    if (problems.length) {
      await sendDraft(chatId, session);
      return;
    }
  }

  draft.confirming = true;

  try {
    if (draft.mode === "cancel") {
      await updateInvoiceRecord(draft.invoiceId, { status: "cancelled" });
      session.draft = null;
      session.lastInvoiceId = null;
      await sendTelegramMessage(
        chatId,
        `🗑 ${escapeHtml(draft.invoiceNumber)} deleted. Stock has been put back.`,
      );
      return;
    }

    if (!draft.customer.id) {
      const customer = await Customer.create({
        name: draft.customer.name,
        address: "Not provided",
      });
      draft.customer = {
        id: String(customer._id),
        name: customer.name,
        address: customer.address,
        isNew: false,
      };
    }

    const invoice =
      draft.mode === "edit"
        ? await updateInvoiceRecord(
            draft.invoiceId,
            draftToUpdatePayload(draft, draft.customer.id),
          )
        : await createInvoiceRecord(draftToCreatePayload(draft, draft.customer.id));

    if (!invoice) {
      session.draft = null;
      await sendTelegramMessage(chatId, "That bill no longer exists.");
      return;
    }

    const wasEdit = draft.mode === "edit";
    session.draft = null;
    session.lastInvoiceId = String(invoice._id);

    await sendInvoicePdf(
      chatId,
      invoice,
      `${wasEdit ? "✏️ Updated" : "✅ Created"} <b>${escapeHtml(invoice.invoiceNumber)}</b> - Total ${money(invoice.total)}\nReply with a change (e.g. <i>add 5 free</i>) to edit it.`,
    );
  } finally {
    // Still set only when saving failed (e.g. not enough stock): the draft stays
    // so the owner can adjust it and try again.
    draft.confirming = false;
  }
};

const handleCommand = async (chatId, text) => {
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, "");
  const args = rest.join(" ").trim();
  const session = getSession(chatId);

  switch (command) {
    case "/cancel":
      session.draft = null;
      await sendTelegramMessage(chatId, "Draft discarded.");
      return;

    case "/last":
    case "/bill": {
      if (command === "/bill" && !args) {
        await sendTelegramMessage(chatId, "Send the number, e.g. <code>/bill AH-2026-045</code>");
        return;
      }
      const invoice = await findSaleInvoice(
        session,
        command === "/bill" ? args.toUpperCase() : null,
      );
      if (!invoice) {
        await sendTelegramMessage(
          chatId,
          command === "/bill"
            ? `I can't find a bill <b>${escapeHtml(args.toUpperCase())}</b>.`
            : "No bills yet.",
        );
        return;
      }
      await sendInvoicePdf(
        chatId,
        invoice,
        `🧾 <b>${escapeHtml(invoice.invoiceNumber)}</b> - ${escapeHtml(invoice.customer?.name || "")} - Total ${money(invoice.total)}`,
      );
      return;
    }

    case "/today":
      await sendTelegramMessage(chatId, await buildTodayReport());
      return;

    case "/pending":
      await sendTelegramMessage(chatId, await buildPendingReport());
      return;

    case "/stock":
      await sendTelegramMessage(chatId, await buildStockReport(args));
      return;

    default:
      await sendTelegramMessage(
        chatId,
        `I don't know <code>${escapeHtml(rawCommand)}</code>. Send /help to see what I can do.`,
      );
  }
};

const handleText = async (chatId, text) => {
  if (text === "/start" || text === "/help") {
    await sendTelegramMessage(
      chatId,
      `${HELP_TEXT}\n\nYour chat ID: <code>${chatId}</code>`,
    );
    return;
  }

  assertOwner(chatId);

  if (text.startsWith("/")) {
    await handleCommand(chatId, text);
    return;
  }

  await handleBillingMessage(chatId, text);
};

const handleCallback = async (callback) => {
  const chatId = callback?.message?.chat?.id;
  if (!chatId) return;

  telegramCall("answerCallbackQuery", { callback_query_id: callback.id }).catch(
    () => null,
  );

  assertOwner(chatId);

  const [action, draftId, answer] = String(callback.data || "").split(":");
  const session = getSession(chatId);

  if (!session.draft || session.draft.id !== draftId) {
    await clearButtons(callback.message);
    await sendTelegramMessage(
      chatId,
      "That draft is no longer open. Send the bill again.",
    );
    return;
  }

  await clearButtons(callback.message);

  if (action === "no") {
    session.draft = null;
    await sendTelegramMessage(chatId, "Discarded. Nothing was saved.");
  } else if (action === "ok") {
    await confirmDraft(chatId, session);
  } else if (action === "pick") {
    answerChoice(session.draft, answer, await loadCatalog());
    await sendDraft(chatId, session);
  }
};

const errorMessageFor = (error) => {
  // Expected, user-fixable outcomes: reported in chat, not logged as failures.
  if (error instanceof AgentBillError || error instanceof InsufficientStockError) {
    return error.message;
  }
  logger.error("Telegram bot error", error);
  return getUserMessage(error, "Something went wrong. Please try again.");
};

// Updates for the same chat run one after another, so a double-tapped button or
// two quick messages cannot interleave on the same draft.
const runInOrder = (chatId, task) => {
  const key = String(chatId);
  const previous = chatQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  chatQueues.set(key, next);
  next.finally(() => {
    if (chatQueues.get(key) === next) chatQueues.delete(key);
  });
  return next;
};

const processTelegramUpdate = async (update) => {
  const callback = update?.callback_query;
  const message = update?.message || update?.edited_message;
  const chatId = callback?.message?.chat?.id || message?.chat?.id;
  if (!chatId) return;

  const text = String(message?.text || "").trim();
  if (!callback && !text) return;

  await runInOrder(chatId, async () => {
    try {
      if (callback) {
        await handleCallback(callback);
      } else {
        await handleText(chatId, text);
      }
    } catch (error) {
      await sendTelegramMessage(chatId, escapeHtml(errorMessageFor(error))).catch(
        () => null,
      );
    }
  });
};

const startTelegramPolling = async () => {
  if (pollingStarted || process.env.TELEGRAM_DISABLE_POLLING === "true") {
    return;
  }

  if (!isConfigured()) {
    logger.info("Telegram polling skipped: TELEGRAM_BOT_TOKEN missing.");
    return;
  }

  // With a webhook registered Telegram refuses getUpdates, so polling would only
  // fail in a loop. The webhook delivers updates instead.
  const webhook = await getWebhookInfo().catch(() => null);
  if (webhook?.url) {
    logger.info("Telegram webhook is active; polling skipped.");
    await ensureWebhookReceivesButtonTaps(webhook).catch((error) =>
      logger.error("Could not update the Telegram webhook", error),
    );
    registerBotCommands();
    return;
  }

  pollingStarted = true;
  logger.info("Telegram billing bot polling started.");
  registerBotCommands();

  while (pollingStarted) {
    try {
      const response = await fetch(telegramUrl("getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: pollingOffset || undefined,
          timeout: 25,
          allowed_updates: UPDATE_TYPES,
        }),
      });
      const data = await response.json();

      if (!data.ok) {
        logger.error("Telegram getUpdates rejected", new Error(JSON.stringify(data)));
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      for (const update of data.result || []) {
        pollingOffset = update.update_id + 1;
        await processTelegramUpdate(update);
      }
    } catch (error) {
      logger.error("Telegram polling error", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

module.exports = {
  isConfigured,
  registerBotCommands,
  processTelegramUpdate,
  startTelegramPolling,
  UPDATE_TYPES,
};
