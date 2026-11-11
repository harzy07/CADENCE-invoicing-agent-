// AI tasks built on callLLM. Each prompt states the exact JSON shape, the
// result is validated, and the model's output is re-checked in code so the
// app never acts on a guessed email address or amount.
const { callLLM } = require("./llm");
const { AppError } = require("./safe");

// ---------- small shape validator ----------
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
function check(obj, fields) {
  const problems = [];
  for (const [key, allowed] of Object.entries(fields)) {
    if (!(key in obj)) problems.push(`"${key}" is missing`);
    else if (!allowed.includes(typeOf(obj[key]))) problems.push(`"${key}" should be ${allowed.join(" or ")}, got ${typeOf(obj[key])}`);
  }
  return problems;
}

// ---------- parseDeal ----------
const DEAL_SHAPE = `{
  "client_name": string or null,
  "client_email": string or null,
  "total": number or null,
  "currency": "USD",
  "instalments": [ { "label": string, "percent": number, "due_in_days": integer } ],
  "missing_fields": [ "client_name" | "client_email" | "total" ]
}`;

const DEAL_SYSTEM = `You turn a freelancer's description of a client deal into a payment plan.
Reply with one JSON object only, no other text, in exactly this shape:
${DEAL_SHAPE}

Rules:
- Only use facts stated in the text. Never invent or guess a name, email address or amount.
- If the client email is not written in the text, set client_email to null and add "client_email" to missing_fields.
- If the total amount is not stated or cannot be computed from stated numbers, set total to null and add "total" to missing_fields.
- If the client name is not stated, set client_name to null and add "client_name" to missing_fields.
- total is a plain number in USD, e.g. 1200 (not "$1,200").
- currency is always "USD".
- Instalments follow the schedule in the text. Percents add up to 100. If no schedule is given, use one instalment of 100% due in 30 days labelled "Full payment".
- due_in_days counts from today, the day the plan is approved. "On signing" or "upfront" means 0.`;

function validateDeal(o) {
  const problems = check(o, { client_name: ["string", "null"], client_email: ["string", "null"], total: ["number", "null"], currency: ["string"], instalments: ["array"], missing_fields: ["array"] });
  if (Array.isArray(o.instalments)) {
    o.instalments.forEach((inst, i) => {
      if (typeOf(inst) !== "object") return problems.push(`instalments[${i}] should be an object`);
      problems.push(...check(inst, { label: ["string"], percent: ["number"], due_in_days: ["number"] }).map((p) => `instalments[${i}] ${p}`));
    });
  }
  return problems;
}

const NON_USD = /€|£|¥|₹|\b(EUR|GBP|INR|JPY|CAD|AUD|CHF|euros?|pounds?|rupees?)\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function sampleDeal(text) {
  const email = text.match(EMAIL_RE)?.[0] || null;
  const amount = text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s?(?:usd|dollars)/i);
  const total = amount ? Number((amount[1] || amount[2]).replace(/,/g, "")) : null;
  return {
    client_name: "Sample Client",
    client_email: email,
    total,
    currency: "USD",
    instalments: [
      { label: "Deposit (sample)", percent: 50, due_in_days: 7 },
      { label: "Final payment (sample)", percent: 50, due_in_days: 30 },
    ],
    missing_fields: [],
  };
}

async function parseDeal(text) {
  if (typeof text !== "string" || !text.trim()) throw new AppError(400, "BAD_REQUEST", "text is required.");
  if (text.length > 5000) throw new AppError(400, "BAD_REQUEST", "text must be 5000 characters or fewer.");

  const { data: out, ai } = await callLLM(DEAL_SYSTEM, `Deal description:\n"""\n${text}\n"""`, { validate: validateDeal, mock: () => sampleDeal(text) });
  const missing = new Set((out.missing_fields || []).filter((f) => typeof f === "string"));

  // Do not trust the model on the fields that matter most.
  let email = typeof out.client_email === "string" ? out.client_email.trim() : null;
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !text.toLowerCase().includes(email.toLowerCase()))) email = null;
  const total = typeof out.total === "number" && Number.isFinite(out.total) && out.total > 0 ? Math.round(out.total * 100) / 100 : null;
  const name = typeof out.client_name === "string" && out.client_name.trim() ? out.client_name.trim() : null;
  for (const [key, ok] of [["client_email", email], ["total", total], ["client_name", name]]) {
    if (ok) missing.delete(key);
    else missing.add(key);
  }

  const instalments = out.instalments.map((i) => ({
    label: String(i.label || "").trim() || "Instalment",
    percent: Number(i.percent),
    due_in_days: Math.max(0, Math.round(Number(i.due_in_days) || 0)),
  }));
  const sum = instalments.reduce((s, i) => s + i.percent, 0);
  if (!instalments.length || Math.abs(sum - 100) > 0.01 || instalments.some((i) => !(i.percent > 0))) missing.add("instalments");
  if (NON_USD.test(text)) missing.add("currency_usd_only");

  return { plan: { client_name: name, client_email: email, total, currency: "USD", instalments, missing_fields: [...missing] }, ai };
}

// ---------- reminderStrategy ----------
const TONES = ["friendly", "firm", "final_notice"];

const REMINDER_SHAPE = `{
  "tone": "friendly" | "firm" | "final_notice",
  "reasoning": string,
  "message": string,
  "next_action": string
}`;

const REMINDER_SYSTEM = `You advise a freelancer on chasing an unpaid PayPal invoice.
Reply with one JSON object only, no other text, in exactly this shape:
${REMINDER_SHAPE}

- tone: pick from the three values based on days overdue, how many reminders were already sent, and the notes.
- reasoning: 1-2 sentences explaining why this tone and timing fit this specific context. Refer to the actual numbers.
- message: a short, polite, professional note to the client, under 600 characters, signed off without a name. Mention the instalment and amount. No threats, no legal claims, no invented facts, no links.
- next_action: one sentence on what to do next and when.`;

function validateReminder(o) {
  const problems = check(o, { tone: ["string"], reasoning: ["string"], message: ["string"], next_action: ["string"] });
  if (typeof o.tone === "string" && !TONES.includes(o.tone.toLowerCase())) problems.push(`"tone" must be one of ${TONES.join(", ")}`);
  if (typeof o.message === "string" && !o.message.trim()) problems.push(`"message" is empty`);
  return problems;
}

function sampleReminder() {
  return {
    tone: "friendly",
    reasoning: "Sample reasoning: the invoice is only slightly overdue and no reminder has been sent, so a light nudge fits.",
    message: "Hi, just a friendly reminder that this invoice is now due. Thanks!",
    next_action: "Wait 7 days, then send a firmer reminder if it is still unpaid.",
  };
}

async function reminderStrategy(context) {
  const ctx = {
    client_name: context.client_name || "the client",
    amount: context.amount,
    days_overdue: context.days_overdue,
    reminders_sent: context.reminders_sent,
    instalment_label: context.instalment_label,
    notes: context.notes || "",
  };
  const { data, ai } = await callLLM(REMINDER_SYSTEM, `Context (JSON):\n${JSON.stringify(ctx, null, 2)}`, { validate: validateReminder, mock: sampleReminder });
  return {
    decision: { tone: data.tone.toLowerCase(), reasoning: data.reasoning.trim(), message: data.message.trim(), next_action: data.next_action.trim() },
    ai,
  };
}

module.exports = { parseDeal, reminderStrategy };
