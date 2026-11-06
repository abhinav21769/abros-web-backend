// Turns a chat message into a structured instruction with Gemini. Only the
// message (and a short summary of the bill being edited) is sent - never the
// customer or medicine lists. Matching names to real records happens locally in
// billMatching.service, which keeps customer data out of the prompt.

const { sanitizeInterpretation } = require("./billDraft.service");

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = 30000;

class AgentBillError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentBillError";
  }
}

const extractJson = (text) => {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AgentBillError("I could not understand that message. Try rephrasing it.");
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    throw new AgentBillError("I could not understand that message. Try rephrasing it.");
  }
};

const buildPrompt = (message, context) =>
  [
    "You read short messages from a pharmacy owner in India and turn them into a billing instruction.",
    "Return only JSON with this shape:",
    "{",
    '  "intent": "create" | "edit" | "cancel_invoice" | "other",',
    '  "invoiceNumber": string | null,',
    '  "customerName": string | null,',
    '  "customerLocation": string | null,',
    '  "paymentType": "cash" | "credit" | null,',
    '  "items": [ { "medicineName": string, "quantity": number | null, "free": number | null, "rate": number | null, "discount": number | null } ],',
    '  "addItems": [ same shape as items ],',
    '  "updateItems": [ { "target": string, "quantity": number | null, "free": number | null, "rate": number | null, "discount": number | null } ],',
    '  "removeItems": [ string ]',
    "}",
    "",
    "Rules:",
    '- "create": a new bill. Put every medicine in "items". Example: "20 pieces of rosmont for rishi gautam" -> customerName "rishi gautam", items [{"medicineName":"rosmont","quantity":20}].',
    '- "edit": the owner is changing a bill that already exists or is being drafted (add free, discount, change quantity or rate, add or remove an item, switch cash/credit, change the customer). New medicines go in "addItems", changes to existing lines in "updateItems", deletions in "removeItems".',
    '- In updateItems, "target" is the medicine name as written, a line number like "#2", or "all" for every line. Leave a field null when it is not being changed.',
    '- "cancel_invoice": the owner wants the whole bill deleted. Set invoiceNumber only if one is mentioned.',
    '- "other": anything that is not billing.',
    "- Copy medicine and customer names as the owner wrote them; do not correct or expand them.",
    '- customerLocation is a town, area or city mentioned next to the customer name, if any.',
    '- "free" means free units ("10 free", "10+2" means quantity 10, free 2). "discount" is a percentage.',
    "- Leave a number null when the owner did not say it. Never invent a rate.",
    '- paymentType is "credit" for words like credit, udhaar, baki, pending; "cash" only if cash/paid is said; otherwise null.',
    "",
    context
      ? `The bill currently open:\n${context}\n`
      : "There is no bill open right now.\n",
    `Owner's message (JSON string): ${JSON.stringify(message)}`,
  ].join("\n");

/**
 * @param {string} message
 * @param {string} [context] summary of the bill being edited, if any
 */
const interpretMessage = async (message, context) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AgentBillError("Gemini API key is not configured.");
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  let response;
  try {
    response = await fetch(`${GEMINI_API}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(message, context) }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AgentBillError("The AI service did not respond. Please try again in a moment.");
  }

  if (!response.ok) {
    const status = response.status;
    throw new AgentBillError(
      status === 429
        ? "The AI service is busy right now (rate limit). Please try again in a minute."
        : `The AI service returned an error (${status}). Please try again.`,
    );
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return sanitizeInterpretation(extractJson(text));
};

module.exports = {
  AgentBillError,
  interpretMessage,
};
