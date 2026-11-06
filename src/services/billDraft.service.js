// The bill the owner is building in chat, before it is real. A draft holds the
// customer and lines as the owner described them, resolved against the real
// customer and medicine records, and is only written to the database when the
// owner taps Confirm. Everything here is plain data in / plain data out - no
// network, no database - so it can be tested without either.

const crypto = require("crypto");
const { buildInvoiceTotals, calculateInvoiceTaxBreakdown } = require("../utils/invoiceTax");
const { resolveEntity } = require("./billMatching.service");

const INTENTS = ["create", "edit", "cancel_invoice", "other"];

const cleanText = (value) => {
  const text = String(value ?? "").trim();
  return text || null;
};

const cleanNumber = (value, { min = 0, max = Infinity, integer = false } = {}) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const clamped = Math.min(Math.max(number, min), max);
  return integer ? Math.round(clamped) : clamped;
};

const cleanSpec = (raw = {}) => ({
  medicineName: cleanText(raw.medicineName ?? raw.name),
  target: cleanText(raw.target),
  quantity: cleanNumber(raw.quantity, { min: 1, integer: true }),
  free: cleanNumber(raw.free, { min: 0, integer: true }),
  rate: cleanNumber(raw.rate, { min: 0 }),
  discount: cleanNumber(raw.discount, { min: 0, max: 100 }),
});

const list = (value) => (Array.isArray(value) ? value : []);

/** Turns whatever the AI returned into a shape the rest of the code can trust. */
const sanitizeInterpretation = (raw = {}) => {
  const intent = INTENTS.includes(raw.intent) ? raw.intent : "other";
  const paymentType =
    raw.paymentType === "credit" || raw.paymentType === "cash"
      ? raw.paymentType
      : null;

  return {
    intent,
    invoiceNumber: cleanText(raw.invoiceNumber)?.toUpperCase() || null,
    customerName: cleanText(raw.customerName),
    customerLocation: cleanText(raw.customerLocation),
    paymentType,
    items: list(raw.items).map(cleanSpec).filter((s) => s.medicineName),
    addItems: list(raw.addItems).map(cleanSpec).filter((s) => s.medicineName),
    updateItems: list(raw.updateItems).map(cleanSpec).filter((s) => s.target),
    removeItems: list(raw.removeItems)
      .map(cleanText)
      .filter(Boolean),
  };
};

const newDraftId = () => crypto.randomBytes(3).toString("hex");

const createDraft = () => ({
  id: newDraftId(),
  mode: "create",
  invoiceId: null,
  invoiceNumber: null,
  customer: null,
  paymentType: "cash",
  originalPaymentType: null,
  items: [],
  removed: [],
  notes: [],
  choices: [],
});

const defaultRate = (medicine) => {
  const rate = Number(medicine.ptr ?? medicine.rate ?? medicine.mrp);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
};

const medicineGstRate = (medicine) => {
  if (medicine.gstRate === null || medicine.gstRate === undefined) return 5;
  const rate = Number(medicine.gstRate);
  return Number.isFinite(rate) && rate >= 0 ? rate : 5;
};

/** Loads a saved sale invoice into an editable draft. */
const draftFromInvoice = (invoice, catalog) => {
  const draft = createDraft();
  draft.mode = "edit";
  draft.invoiceId = String(invoice._id);
  draft.invoiceNumber = invoice.invoiceNumber;
  draft.paymentType = invoice.paymentType === "credit" ? "credit" : "cash";
  draft.originalPaymentType = draft.paymentType;

  const customer = invoice.customer || {};
  draft.customer = {
    id: customer._id ? String(customer._id) : null,
    name: customer.name || "Unknown customer",
    address: customer.address || "",
    isNew: false,
  };

  draft.items = invoice.items.map((item) => {
    const medicineId = String(item.medicine?._id || item.medicine);
    const medicine = catalog.medicines.find((m) => String(m._id) === medicineId);
    const units = (Number(item.quantity) || 0) + (Number(item.free) || 0);
    const line = {
      medicineId,
      name: item.medicineName,
      quantity: item.quantity,
      free: item.free || 0,
      rate: item.rate,
      discount: item.discount || 0,
      gstRate: item.gstRate,
      hsn: item.hsn,
      // Stock on the shelf plus what this very line is already holding.
      available: medicine ? Number(medicine.quantity || 0) + units : null,
      original: {
        quantity: item.quantity,
        free: item.free || 0,
        rate: item.rate,
        discount: item.discount || 0,
      },
      kept: {
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
        mrp: item.mrp,
        sourceBatch: item.sourceBatch,
      },
    };
    return line;
  });

  return draft;
};

const addLine = (draft, medicine, spec, fuzzyFrom) => {
  const existing = draft.items.find(
    (line) => line.medicineId === String(medicine._id),
  );

  if (existing) {
    existing.quantity += spec.quantity ?? 1;
    existing.free += spec.free ?? 0;
    if (spec.rate !== null) existing.rate = spec.rate;
    if (spec.discount !== null) existing.discount = spec.discount;
    draft.notes.push(`${medicine.name} was already on the bill - quantity added to it.`);
    return;
  }

  const rate = spec.rate ?? defaultRate(medicine);
  draft.items.push({
    medicineId: String(medicine._id),
    name: medicine.name,
    quantity: spec.quantity ?? 1,
    free: spec.free ?? 0,
    rate,
    discount: spec.discount ?? 0,
    gstRate: medicineGstRate(medicine),
    hsn: medicine.hsn,
    available: Number(medicine.quantity || 0),
    isNew: draft.mode === "edit",
    guessedFrom: fuzzyFrom || null,
    rateGuessed: spec.rate === null,
  });
};

const resolveCustomer = (draft, interpretation, catalog) => {
  const query = interpretation.customerName;
  if (!query) return;

  const result = resolveEntity(query, catalog.customers, (c) => c.name, {
    hint: interpretation.customerLocation,
    getHint: (c) => c.address,
  });

  if (result.status === "match") {
    draft.customer = {
      id: String(result.match._id),
      name: result.match.name,
      address: result.match.address || "",
      isNew: false,
    };
    if (result.fuzzy) {
      draft.notes.push(`Customer "${query}" matched to ${result.match.name} - check it is right.`);
    }
    return;
  }

  draft.choices.push({
    kind: "customer",
    query,
    candidates: result.candidates.map((c) => ({
      id: String(c._id),
      name: c.name,
      address: c.address || "",
    })),
  });
};

const resolveLine = (draft, target) => {
  const text = String(target).trim();
  const indexMatch = text.match(/^#?(\d+)$/);
  if (indexMatch) {
    const line = draft.items[Number(indexMatch[1]) - 1];
    return line ? [line] : [];
  }
  if (/^(all|everything|every item|all items)$/i.test(text)) {
    return [...draft.items];
  }
  const result = resolveEntity(text, draft.items, (line) => line.name);
  if (result.status === "match") return [result.match];
  return result.candidates;
};

const applyUpdate = (draft, spec) => {
  const lines = resolveLine(draft, spec.target);
  if (!lines.length) {
    draft.notes.push(`Could not find "${spec.target}" on the bill.`);
    return;
  }
  if (lines.length > 1 && !/^(all|everything|every item|all items)$/i.test(spec.target)) {
    draft.notes.push(
      `"${spec.target}" matches more than one line (${lines.map((l) => l.name).join(", ")}) - say which one, e.g. "#2".`,
    );
    return;
  }
  for (const line of lines) {
    if (spec.quantity !== null) line.quantity = spec.quantity;
    if (spec.free !== null) line.free = spec.free;
    if (spec.rate !== null) {
      line.rate = spec.rate;
      line.rateGuessed = false;
    }
    if (spec.discount !== null) line.discount = spec.discount;
  }
};

const applyRemove = (draft, target) => {
  const lines = resolveLine(draft, target);
  if (lines.length !== 1) {
    draft.notes.push(
      lines.length
        ? `"${target}" matches more than one line - say which one, e.g. "#2".`
        : `Could not find "${target}" on the bill.`,
    );
    return;
  }
  draft.items = draft.items.filter((line) => line !== lines[0]);
  draft.removed.push(lines[0].name);
};

/**
 * Applies one parsed message to the draft. Anything it cannot settle on its own
 * (two customers called Rishi, a medicine that does not exist) is either queued
 * as a question in draft.choices or reported in draft.notes - never guessed.
 */
const applyInterpretation = (draft, interpretation, catalog) => {
  draft.notes = [];
  draft.removed = draft.mode === "edit" ? draft.removed : [];

  resolveCustomer(draft, interpretation, catalog);

  if (interpretation.paymentType) {
    draft.paymentType = interpretation.paymentType;
  }

  for (const spec of [...interpretation.items, ...interpretation.addItems]) {
    const result = resolveEntity(spec.medicineName, catalog.medicines, (m) => m.name);

    if (result.status === "match") {
      addLine(draft, result.match, spec, result.fuzzy ? spec.medicineName : null);
    } else if (result.status === "ambiguous") {
      draft.choices.push({
        kind: "item",
        query: spec.medicineName,
        spec,
        candidates: result.candidates.map((m) => ({
          id: String(m._id),
          name: m.name,
          packaging: m.packagingType || "",
          stock: Number(m.quantity || 0),
        })),
      });
    } else {
      draft.notes.push(
        `"${spec.medicineName}" is not in your inventory - skipped. Check the spelling and add it again.`,
      );
    }
  }

  for (const spec of interpretation.updateItems) applyUpdate(draft, spec);
  for (const target of interpretation.removeItems) applyRemove(draft, target);

  return draft;
};

/**
 * Settles the question at the front of draft.choices.
 * `answer` is a candidate index, "new" (customer only) or "skip".
 */
const answerChoice = (draft, answer, catalog) => {
  const choice = draft.choices.shift();
  if (!choice) return draft;

  if (answer === "skip") {
    draft.notes.push(`Skipped "${choice.query}".`);
    return draft;
  }

  if (choice.kind === "customer") {
    if (answer === "new") {
      draft.customer = { id: null, name: choice.query, address: "", isNew: true };
    } else {
      const picked = choice.candidates[Number(answer)];
      if (picked) draft.customer = { ...picked, isNew: false };
    }
    return draft;
  }

  const picked = choice.candidates[Number(answer)];
  const medicine = picked && catalog.medicines.find((m) => String(m._id) === picked.id);
  if (medicine) addLine(draft, medicine, choice.spec, null);
  return draft;
};

/** Reasons the draft cannot be saved yet. */
const draftProblems = (draft) => {
  const problems = [];
  if (draft.choices.length) problems.push("Answer the question above first.");
  if (!draft.customer) problems.push("No customer yet - tell me who the bill is for.");
  if (!draft.items.length) problems.push("No items yet - tell me what to add.");
  for (const line of draft.items) {
    if (line.rate === null || line.rate === undefined) {
      problems.push(`No rate for ${line.name} - say e.g. "rate 45 for ${line.name}".`);
    }
  }
  return problems;
};

const stockWarnings = (draft) =>
  draft.items
    .filter(
      (line) =>
        line.available !== null &&
        line.available !== undefined &&
        line.quantity + line.free > line.available,
    )
    .map(
      (line) =>
        `${line.name}: you asked for ${line.quantity + line.free} but only ${line.available} in stock.`,
    );

const lineDidChange = (line) =>
  Boolean(line.original) &&
  (line.original.quantity !== line.quantity || line.original.free !== line.free);

const linePayload = (line) => {
  const payload = {
    medicine: line.medicineId,
    medicineName: line.name,
    hsn: line.hsn || undefined,
    gstRate: line.gstRate,
    quantity: line.quantity,
    free: line.free,
    rate: line.rate,
    discount: line.discount,
  };

  // A line whose quantity is unchanged keeps the batch it was sold from. If the
  // quantity moved, the old batch may no longer cover it, so the line is left
  // for first-expiry-first-out to allocate afresh.
  if (line.kept && !lineDidChange(line)) {
    Object.entries(line.kept).forEach(([key, value]) => {
      if (value !== undefined && value !== null) payload[key] = value;
    });
  }

  return payload;
};

const draftToCreatePayload = (draft, customerId) => ({
  invoiceType: "sale",
  customer: customerId,
  paymentType: draft.paymentType,
  status: draft.paymentType === "credit" ? "pending" : "paid",
  invoiceDate: new Date(),
  items: draft.items.map(linePayload),
});

const draftToUpdatePayload = (draft, customerId) => {
  const payload = {
    customer: customerId,
    paymentType: draft.paymentType,
    items: draft.items.map(linePayload),
  };
  // Moving a bill to credit leaves it unpaid; moving to cash is forced to paid
  // by the invoice service itself.
  if (draft.paymentType !== draft.originalPaymentType && draft.paymentType === "credit") {
    payload.status = "pending";
  }
  return payload;
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const money = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const changedFields = (line) => {
  if (!line.original) return "";
  const parts = [];
  if (line.original.quantity !== line.quantity) parts.push(`qty was ${line.original.quantity}`);
  if (line.original.free !== line.free) parts.push(`free was ${line.original.free}`);
  if (line.original.rate !== line.rate) parts.push(`rate was ${money(line.original.rate)}`);
  if (line.original.discount !== line.discount) parts.push(`disc was ${line.original.discount}%`);
  return parts.length ? ` <i>(${parts.join(", ")})</i>` : "";
};

/** The text shown to the owner for review. */
const formatDraft = (draft) => {
  const lines = [];

  lines.push(
    draft.mode === "edit"
      ? `<b>✏️ Editing ${escapeHtml(draft.invoiceNumber)}</b>`
      : "<b>🧾 New bill - draft</b>",
  );

  if (draft.customer) {
    const place = draft.customer.address ? ` - ${escapeHtml(draft.customer.address)}` : "";
    lines.push(
      `👤 ${escapeHtml(draft.customer.name)}${place}${draft.customer.isNew ? " <b>(new customer)</b>" : ""}`,
    );
  } else {
    lines.push("👤 <i>customer not set</i>");
  }
  lines.push(`💳 ${draft.paymentType === "credit" ? "Credit" : "Cash"}`);
  lines.push("");

  const priced = draft.items.map((line) => ({
    ...line,
    rate: Number(line.rate) || 0,
  }));
  const totals = priced.length ? buildInvoiceTotals(priced) : { items: [] };

  draft.items.forEach((line, index) => {
    const amount = totals.items[index]?.amount ?? 0;
    const rate = line.rate === null || line.rate === undefined ? "no rate" : money(line.rate);
    const extras = [];
    if (line.free) extras.push(`+${line.free} free`);
    if (line.discount) extras.push(`${line.discount}% disc`);
    if (line.isNew) extras.push("new");
    if (line.rateGuessed && line.rate !== null) extras.push("price list rate");

    lines.push(
      `${index + 1}. <b>${escapeHtml(line.name)}</b> - ${line.quantity} × ${rate} = ${money(amount)}${
        extras.length ? ` (${extras.join(", ")})` : ""
      }${changedFields(line)}`,
    );
    if (line.guessedFrom) {
      lines.push(`   ↳ <i>read "${escapeHtml(line.guessedFrom)}" as ${escapeHtml(line.name)}</i>`);
    }
  });

  if (draft.removed.length) {
    lines.push(`🗑 Removed: ${draft.removed.map(escapeHtml).join(", ")}`);
  }

  if (priced.length) {
    const tax = calculateInvoiceTaxBreakdown(priced);
    lines.push("");
    lines.push(`Subtotal ${money(tax.subtotal)} · GST ${money(tax.gst)}`);
    lines.push(`<b>Total ${money(tax.total)}</b>`);
  }

  const warnings = [...draft.notes, ...stockWarnings(draft)];
  if (warnings.length) {
    lines.push("");
    warnings.forEach((warning) => lines.push(`⚠️ ${escapeHtml(warning)}`));
  }

  return lines.join("\n");
};

module.exports = {
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
  sanitizeInterpretation,
  stockWarnings,
};
