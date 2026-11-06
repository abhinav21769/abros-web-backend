const Invoice = require("../../src/models/invoice.model");
const Medicine = require("../../src/models/medicine.model");
const Customer = require("../../src/models/customer.model");
const { processTelegramUpdate } = require("../../src/services/telegramBot.service");
const { createTestCustomer, createTestMedicine } = require("./helpers");

const originalFetch = global.fetch;
let chatCounter = 5000;
let chatId;
let telegramCalls;
let geminiReplies;

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });

const installFetch = () => {
  global.fetch = jest.fn(async (url, options = {}) => {
    const target = String(url);

    if (target.includes("generativelanguage.googleapis.com")) {
      const reply = geminiReplies.shift();
      if (!reply) throw new Error("Unexpected Gemini call");
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] });
    }

    if (target.includes("api.telegram.org")) {
      const method = target.split("/").pop();
      telegramCalls.push({
        method,
        body: typeof options.body === "string" ? JSON.parse(options.body) : options.body,
      });
      return json({ ok: true, result: {} });
    }

    throw new Error(`Unexpected fetch ${target}`);
  });
};

const say = (text) => processTelegramUpdate({ message: { chat: { id: chatId }, text } });
const tap = (data) =>
  processTelegramUpdate({
    callback_query: { id: "cb", data, message: { chat: { id: chatId }, message_id: 1 } },
  });

const messages = () => telegramCalls.filter((c) => c.method === "sendMessage").map((c) => c.body);
const lastMessage = () => messages().at(-1);
const buttons = (message) =>
  (message.reply_markup?.inline_keyboard || []).flat();
const button = (message, fragment) =>
  buttons(message).find((b) => b.text.includes(fragment));
const documents = () => telegramCalls.filter((c) => c.method === "sendDocument");

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.GEMINI_API_KEY = "test-gemini-key";
});

beforeEach(() => {
  chatCounter += 1;
  chatId = chatCounter;
  process.env.TELEGRAM_OWNER_CHAT_ID = String(chatId);
  telegramCalls = [];
  geminiReplies = [];
  installFetch();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("Telegram billing bot", () => {
  it("shows a draft first and only creates the bill when confirmed", async () => {
    await createTestCustomer({ name: "Rishi Gautam", address: "Ambala" });
    const medicine = await createTestMedicine({ name: "Rosmont 20" });

    geminiReplies.push({
      intent: "create",
      customerName: "rishi gautam",
      items: [{ medicineName: "rosmont", quantity: 20 }],
    });

    await say("20 pieces of rosmont for rishi gautam");

    const draft = lastMessage();
    expect(draft.text).toContain("Rosmont 20");
    expect(draft.text).toContain("Rishi Gautam");
    expect(await Invoice.countDocuments()).toBe(0);
    expect((await Medicine.findById(medicine._id)).quantity).toBe(100);

    await tap(button(draft, "Create bill").callback_data);

    const invoice = await Invoice.findOne();
    expect(invoice.items[0]).toMatchObject({ quantity: 20, medicineName: "Rosmont 20" });
    expect((await Medicine.findById(medicine._id)).quantity).toBe(80);
    expect(documents()).toHaveLength(1);
  });

  it("asks which medicine when the name fits more than one", async () => {
    await createTestCustomer({ name: "Rishi Gautam" });
    await createTestMedicine({ name: "Rosmont 10" });
    const rosmont20 = await createTestMedicine({ name: "Rosmont 20" });

    geminiReplies.push({
      intent: "create",
      customerName: "rishi gautam",
      items: [{ medicineName: "rosmont", quantity: 5 }],
    });
    await say("5 rosmont for rishi gautam");

    const question = lastMessage();
    expect(question.text).toContain("Which medicine");
    expect(button(question, "Create bill")).toBeUndefined();

    await tap(button(question, "Rosmont 20").callback_data);

    const draft = lastMessage();
    expect(button(draft, "Create bill")).toBeDefined();
    await tap(button(draft, "Create bill").callback_data);

    const invoice = await Invoice.findOne();
    expect(String(invoice.items[0].medicine)).toBe(String(rosmont20._id));
  });

  it("does not create a customer unless asked", async () => {
    await createTestMedicine({ name: "Rosmont 20" });

    geminiReplies.push({
      intent: "create",
      customerName: "Brand New Chemist",
      items: [{ medicineName: "rosmont 20", quantity: 1 }],
    });
    await say("1 rosmont 20 for brand new chemist");

    const question = lastMessage();
    expect(question.text).toContain("can't find a customer");
    expect(await Customer.countDocuments({ name: "Brand New Chemist" })).toBe(0);

    await tap(button(question, "New customer").callback_data);
    expect(await Customer.countDocuments({ name: "Brand New Chemist" })).toBe(0);

    await tap(button(lastMessage(), "Create bill").callback_data);
    expect(await Customer.countDocuments({ name: "Brand New Chemist" })).toBe(1);
    expect(await Invoice.countDocuments()).toBe(1);
  });

  it("edits the last bill from a follow-up message", async () => {
    await createTestCustomer({ name: "Rishi Gautam" });
    const medicine = await createTestMedicine({ name: "Rosmont 20" });

    geminiReplies.push({
      intent: "create",
      customerName: "rishi gautam",
      items: [{ medicineName: "rosmont 20", quantity: 20 }],
    });
    await say("20 rosmont 20 for rishi gautam");
    await tap(button(lastMessage(), "Create bill").callback_data);

    geminiReplies.push({
      intent: "edit",
      updateItems: [{ target: "rosmont", free: 5, discount: 10 }],
    });
    await say("add 5 free and 10% discount");

    const preview = lastMessage();
    expect(preview.text).toContain("Editing");
    // Nothing has changed until the edit is confirmed.
    expect((await Invoice.findOne()).items[0].free).toBe(0);

    await tap(button(preview, "Save changes").callback_data);

    const invoice = await Invoice.findOne();
    expect(invoice.items[0]).toMatchObject({ quantity: 20, free: 5, discount: 10 });
    expect(await Invoice.countDocuments()).toBe(1);
    expect((await Medicine.findById(medicine._id)).quantity).toBe(75);
    expect(documents()).toHaveLength(2);
  });

  it("deletes a bill only after confirmation and puts stock back", async () => {
    await createTestCustomer({ name: "Rishi Gautam" });
    const medicine = await createTestMedicine({ name: "Rosmont 20" });

    geminiReplies.push({
      intent: "create",
      customerName: "rishi gautam",
      items: [{ medicineName: "rosmont 20", quantity: 10 }],
    });
    await say("10 rosmont 20 for rishi gautam");
    await tap(button(lastMessage(), "Create bill").callback_data);
    expect((await Medicine.findById(medicine._id)).quantity).toBe(90);

    geminiReplies.push({ intent: "cancel_invoice" });
    await say("delete the bill");

    const confirm = lastMessage();
    expect(confirm.text).toContain("Delete");
    expect(await Invoice.countDocuments()).toBe(1);

    await tap(button(confirm, "Yes, delete").callback_data);
    expect(await Invoice.countDocuments()).toBe(0);
    expect((await Medicine.findById(medicine._id)).quantity).toBe(100);
  });

  it("discards a draft without saving anything", async () => {
    await createTestCustomer({ name: "Rishi Gautam" });
    await createTestMedicine({ name: "Rosmont 20" });

    geminiReplies.push({
      intent: "create",
      customerName: "rishi gautam",
      items: [{ medicineName: "rosmont 20", quantity: 3 }],
    });
    await say("3 rosmont 20 for rishi gautam");
    await tap(button(lastMessage(), "Discard").callback_data);

    expect(await Invoice.countDocuments()).toBe(0);
  });

  it("does not create twice when Confirm is tapped twice", async () => {
    await createTestCustomer({ name: "Rishi Gautam" });
    await createTestMedicine({ name: "Rosmont 20" });

    geminiReplies.push({
      intent: "create",
      customerName: "rishi gautam",
      items: [{ medicineName: "rosmont 20", quantity: 3 }],
    });
    await say("3 rosmont 20 for rishi gautam");
    const data = button(lastMessage(), "Create bill").callback_data;

    await Promise.all([tap(data), tap(data)]);

    expect(await Invoice.countDocuments()).toBe(1);
  });

  it("keeps the draft when stock is short so it can be adjusted", async () => {
    await createTestCustomer({ name: "Rishi Gautam" });
    await createTestMedicine({
      name: "Rosmont 20",
      batches: [
        {
          batchNumber: "B1",
          expiryDate: new Date(Date.now() + 365 * 86400000),
          mrp: 60,
          rate: 40,
          ptr: 45,
          quantity: 5,
        },
      ],
    });

    geminiReplies.push({
      intent: "create",
      customerName: "rishi gautam",
      items: [{ medicineName: "rosmont 20", quantity: 50 }],
    });
    await say("50 rosmont 20 for rishi gautam");
    expect(lastMessage().text).toContain("only 5 in stock");

    await tap(button(lastMessage(), "Create bill").callback_data);
    expect(lastMessage().text).toContain("Not enough stock");
    expect(await Invoice.countDocuments()).toBe(0);

    geminiReplies.push({ intent: "edit", updateItems: [{ target: "rosmont", quantity: 4 }] });
    await say("make it 4");
    await tap(button(lastMessage(), "Create bill").callback_data);
    expect(await Invoice.countDocuments()).toBe(1);
  });

  it("refuses anyone who is not the owner", async () => {
    process.env.TELEGRAM_OWNER_CHAT_ID = "999999999";

    await say("20 rosmont for rishi gautam");

    expect(lastMessage().text).toContain("This bot is private");
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes("generativelanguage"))).toBe(false);
  });

  it("explains itself when the AI service is rate limited", async () => {
    global.fetch = jest.fn();
    global.fetch.mockImplementation(async (url, options = {}) => {
      if (String(url).includes("generativelanguage")) {
        return { ok: false, status: 429, text: async () => "quota" };
      }
      telegramCalls.push({
        method: String(url).split("/").pop(),
        body: typeof options.body === "string" ? JSON.parse(options.body) : options.body,
      });
      return json({ ok: true });
    });

    await say("20 rosmont for rishi");

    expect(lastMessage().text).toContain("busy");
  });
});
