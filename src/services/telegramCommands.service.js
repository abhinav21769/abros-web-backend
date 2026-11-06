// Read-only reports behind the bot's slash commands. Each builder returns the
// HTML text to send; sending is the bot's job. Nothing here changes data.

const Invoice = require("../models/invoice.model");
const Medicine = require("../models/medicine.model");
const { resolveEntity } = require("./billMatching.service");
const { escapeHtml, money } = require("./billDraft.service");

const IST = "Asia/Kolkata";
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 180;
const MAX_LINES = 25;

const SALES = { invoiceType: { $ne: "purchase" } };

// Invoice dates are stored as IST midnight, so "today" is the IST calendar day.
const istDayStart = (date = new Date()) => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(date);
  return new Date(`${day}T00:00:00+05:30`);
};

const formatDay = (date) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);

const formatExpiry = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: IST,
      month: "2-digit",
      year: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.month}-${parts.year}`;
};

const buildTodayReport = async (now = new Date()) => {
  const start = istDayStart(now);
  const end = new Date(start.getTime() + DAY_MS);

  const invoices = await Invoice.find({
    ...SALES,
    status: { $ne: "cancelled" },
    invoiceDate: { $gte: start, $lt: end },
  })
    .select("total paymentType status")
    .lean();

  const heading = `<b>📊 Today - ${formatDay(start)}</b>`;
  if (!invoices.length) return `${heading}\nNo bills yet.`;

  const sum = (list) => list.reduce((total, inv) => total + (inv.total || 0), 0);
  const cash = invoices.filter((inv) => inv.paymentType === "cash");
  const credit = invoices.filter((inv) => inv.paymentType !== "cash");
  const unpaid = invoices.filter((inv) => inv.status === "pending");

  return [
    heading,
    `Bills: ${invoices.length} · <b>Total ${money(sum(invoices))}</b>`,
    `Cash ${money(sum(cash))} (${cash.length}) · Credit ${money(sum(credit))} (${credit.length})`,
    `Still unpaid: ${money(sum(unpaid))} (${unpaid.length})`,
  ].join("\n");
};

const buildPendingReport = async () => {
  const invoices = await Invoice.find({ ...SALES, status: "pending" })
    .select("customer total")
    .populate("customer", "name")
    .lean();

  if (!invoices.length) return "<b>🧾 Pending bills</b>\nNothing unpaid. 🎉";

  const byCustomer = new Map();
  for (const invoice of invoices) {
    const name = invoice.customer?.name || "Unknown customer";
    const entry = byCustomer.get(name) || { name, total: 0, bills: 0 };
    entry.total += invoice.total || 0;
    entry.bills += 1;
    byCustomer.set(name, entry);
  }

  const rows = [...byCustomer.values()].sort((a, b) => b.total - a.total);
  const lines = rows
    .slice(0, MAX_LINES)
    .map(
      (row) =>
        `• ${escapeHtml(row.name)} - ${money(row.total)} (${row.bills} bill${row.bills === 1 ? "" : "s"})`,
    );
  if (rows.length > MAX_LINES) lines.push(`…and ${rows.length - MAX_LINES} more`);

  const grand = rows.reduce((total, row) => total + row.total, 0);
  return [
    "<b>🧾 Pending bills</b>",
    ...lines,
    "",
    `<b>Total owed ${money(grand)}</b> across ${invoices.length} bill${invoices.length === 1 ? "" : "s"}`,
  ].join("\n");
};

const totalStock = (medicine) =>
  medicine.batches?.length
    ? medicine.batches.reduce((sum, batch) => sum + (batch.quantity || 0), 0)
    : Number(medicine.quantity || 0);

const buildStockReport = async (query, now = new Date()) => {
  const text = String(query || "").trim();
  if (!text) {
    return "Tell me which medicine, e.g. <code>/stock rosmont</code>";
  }

  const medicines = await Medicine.find({}, "name packagingType quantity batches").lean();
  const result = resolveEntity(text, medicines, (m) => m.name);

  if (result.status === "none") {
    return `I can't find a medicine like <b>"${escapeHtml(text)}"</b>.`;
  }

  if (result.status === "ambiguous") {
    const lines = result.candidates.map(
      (m) => `• ${escapeHtml(m.name)} - ${totalStock(m)} in stock`,
    );
    return [
      `More than one medicine fits <b>"${escapeHtml(text)}"</b>:`,
      ...lines,
      "",
      "Send <code>/stock</code> with the full name.",
    ].join("\n");
  }

  const medicine = result.match;
  const soon = now.getTime() + EXPIRY_WARNING_DAYS * DAY_MS;
  const batches = [...(medicine.batches || [])]
    .filter((batch) => batch.quantity > 0)
    .sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));

  const lines = batches.map((batch) => {
    const expiry = new Date(batch.expiryDate).getTime();
    const flag = expiry < now.getTime() ? " ❌ expired" : expiry < soon ? " ⏳ expiring" : "";
    return `• ${escapeHtml(batch.batchNumber)} · exp ${formatExpiry(batch.expiryDate)} · qty ${batch.quantity} · MRP ${money(batch.mrp)}${flag}`;
  });

  const packaging = medicine.packagingType ? ` (${escapeHtml(medicine.packagingType)})` : "";
  return [
    `<b>💊 ${escapeHtml(medicine.name)}</b>${packaging}`,
    `In stock: <b>${totalStock(medicine)}</b>`,
    ...(lines.length ? ["", ...lines] : ["No batches with stock."]),
  ].join("\n");
};

module.exports = {
  buildPendingReport,
  buildStockReport,
  buildTodayReport,
};
