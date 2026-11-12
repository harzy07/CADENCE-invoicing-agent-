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
- client_name is the business or person the work is for, as written. "Logo design for Harbor Coffee" means client_name is "Harbor Coffee"; "website for Maria Lopez" means "Maria Lopez". Only if no client is named at all, set client_name to null and add "client_name" to missing_fields.
- A missing email does not make the client name missing, and a missing name does not make the email missing. Judge each field on its own.
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
// Tones from softest to strictest. The escalation policy below is enforced in
// code; the prompt only explains it so the AI usually agrees with it.
const TONES = ["friendly", "firm", "formal"];
const toneRank = (t) => TONES.indexOf(t);
const MAX_MESSAGE_WORDS = 90;

// Minimum tone for how late the invoice is.
function minimumTone(daysOverdue) {
  if (daysOverdue >= 15) return "formal";
  if (daysOverdue >= 6) return "firm";
  return "friendly"; // 0-5 days
}

// Returns the tone to use and whether policy changed the AI's choice.
// The AI may go stricter than the minimum only when 2+ reminders were already sent.
function applyEscalationPolicy(aiTone, daysOverdue, remindersSent) {
  const min = minimumTone(daysOverdue);
  const tone = TONES.includes(aiTone) ? aiTone : min;
  if (toneRank(tone) < toneRank(min)) return { tone: min, minimum: min, changed: "raised" };
  if (toneRank(tone) > toneRank(min) && remindersSent < 2) return { tone: min, minimum: min, changed: "lowered" };
  return { tone, minimum: min, changed: null };
}

const POLICY_NOTES = {
  raised: "Tone raised by escalation policy.",
  lowered: "Tone lowered by escalation policy: a stricter tone needs at least 2 earlier reminders.",
};

// Things the message must never contain (invented penalties or threats).
const FORBIDDEN = /\b(late[- ]fees?|late charges?|interest (charge|rate)s?|charge interest|penalt(y|ies)|legal|lawyers?|attorneys?|court|collections? agency|debt collect\w*|lawsuit|sue|small claims)\b/i;
const wordCount = (s) => (String(s).trim().match(/\S+/g) || []).length;

const REMINDER_SHAPE = `{
  "tone": "friendly" | "firm" | "formal",
  "reasoning": string,
  "message": string,
  "next_action": string
}`;

const TONE_GUIDE = `- friendly: warm and light, assumes it was an oversight.
- firm: direct and polite, clearly asks for payment soon or a reply.
- formal: businesslike and serious, states the amount, how many days overdue and how many reminders were already sent, and asks for payment or a reply now.`;

const GUARDRAILS = `- Never mention or invent late fees, interest, penalties, collections, or legal action of any kind.
- Never promise discounts, extensions, payment plans, deadlines or anything else that is not in the context.
- No links and no invented facts.
- The message must be under ${MAX_MESSAGE_WORDS} words, addressed to the client, mention the instalment and the amount, and be signed off without a name.`;

const REMINDER_SYSTEM = `You advise a freelancer on chasing an unpaid PayPal invoice.
Reply with one JSON object only, no other text, in exactly this shape:
${REMINDER_SHAPE}

Escalation policy (the app enforces it):
- 0-5 days overdue: "friendly".
- 6-14 days overdue: "firm".
- 15 or more days overdue: "formal".
- Choose a stricter tone than that only if reminders_sent is 2 or more.
- If previous_tone is given, build on it: do not repeat the same soft wording.

Tones:
${TONE_GUIDE}

Fields:
- reasoning: 1-2 sentences explaining why this tone and timing fit. It must state the exact days_overdue and the exact reminders_sent as digits, for example "12 days overdue with 0 reminders sent".
- message: the reminder to the client, written in the chosen tone.
- next_action: one short, concrete step with timing for the freelancer, for example "Wait 3 days, then send the next reminder", "Call the client", or "Pause work until paid". Never suggest a softer tone than the one you chose.

Guardrails:
${GUARDRAILS}`;

// Used only when policy changed the tone, so the message matches the final tone.
const REWRITE_SHAPE = `{
  "message": string,
  "next_action": string
}`;
const REWRITE_SYSTEM = `You write a payment reminder from a freelancer to a client about an unpaid PayPal invoice.
Reply with one JSON object only, no other text, in exactly this shape:
${REWRITE_SHAPE}

The tone is fixed and given in the context as "tone". Tones:
${TONE_GUIDE}

- next_action: one short, concrete step with timing for the freelancer, for example "Wait 3 days, then send the next reminder", "Call the client", or "Pause work until paid". Never suggest a softer tone than the given tone.

Guardrails:
${GUARDRAILS}`;

function messageProblems(message) {
  const problems = [];
  if (typeof message === "string") {
    if (!message.trim()) problems.push(`"message" is empty`);
    if (wordCount(message) > MAX_MESSAGE_WORDS) problems.push(`"message" must be under ${MAX_MESSAGE_WORDS} words (got ${wordCount(message)})`);
    if (FORBIDDEN.test(message)) problems.push(`"message" must not mention fees, interest, penalties, collections or legal action`);
  }
  return problems;
}

// next_action must not step down, e.g. "send a firm reminder" after a formal one.
function nextActionProblems(nextAction, tone) {
  if (typeof nextAction !== "string" || !TONES.includes(tone)) return [];
  const softer = TONES.slice(0, toneRank(tone)).filter((t) => new RegExp(`\\b${t}\\b`, "i").test(nextAction));
  return softer.length ? [`"next_action" suggests a softer tone (${softer.join(", ")}) than "${tone}"`] : [];
}

function validateReminder(o) {
  const problems = check(o, { tone: ["string"], reasoning: ["string"], message: ["string"], next_action: ["string"] });
  const tone = typeof o.tone === "string" ? o.tone.trim().toLowerCase() : null;
  if (tone && !TONES.includes(tone)) problems.push(`"tone" must be one of ${TONES.join(", ")}`);
  return problems.concat(messageProblems(o.message), nextActionProblems(o.next_action, tone));
}

const validateRewrite = (tone) => (o) =>
  check(o, { message: ["string"], next_action: ["string"] }).concat(messageProblems(o.message), nextActionProblems(o.next_action, tone));

// The reasoning must name the actual numbers; add them if the model left them out.
function withNumbers(reasoning, days, sent) {
  const text = reasoning.trim();
  const hasDays = new RegExp(`\\b${days}\\b`).test(text);
  const hasSent = new RegExp(`\\b${sent}\\b`).test(text) || (sent === 0 && /\bno (prior |previous |earlier )?reminders?\b/i.test(text));
  if (hasDays && hasSent) return text;
  return `${text} (${days} day${days === 1 ? "" : "s"} overdue, ${sent} reminder${sent === 1 ? "" : "s"} sent so far.)`;
}

// Final safety net: keep the message under the word limit at a sentence end.
function capWords(message, max = MAX_MESSAGE_WORDS) {
  const text = message.trim();
  if (wordCount(text) <= max) return text;
  const words = text.split(/\s+/).slice(0, max).join(" ");
  const end = Math.max(words.lastIndexOf(". "), words.lastIndexOf("! "), words.lastIndexOf("? "));
  return end > 0 ? words.slice(0, end + 1) : `${words}…`;
}

function sampleReminder() {
  return {
    tone: "friendly",
    reasoning: "Sample reasoning (AI_MODE=mock).",
    message: "Hi, just a friendly reminder that this invoice is now due. Thanks!",
    next_action: "Wait 7 days, then send a firmer reminder if it is still unpaid.",
  };
}

async function reminderStrategy(context) {
  const days = Number(context.days_overdue);
  const sent = Number(context.reminders_sent) || 0;
  if (!Number.isInteger(days) || days < 0) throw new AppError(400, "BAD_REQUEST", "days_overdue must be a whole number of 0 or more.");
  const ctx = {
    client_name: context.client_name || "the client",
    amount: context.amount,
    instalment_label: context.instalment_label,
    days_overdue: days,
    reminders_sent: sent,
    previous_tone: TONES.includes(context.previous_tone) ? context.previous_tone : null,
  };

  const first = await callLLM(REMINDER_SYSTEM, `Context (JSON):\n${JSON.stringify(ctx, null, 2)}`, { validate: validateReminder, mock: sampleReminder });
  const aiTone = first.data.tone.trim().toLowerCase();
  const policy = applyEscalationPolicy(aiTone, days, sent);
  let message = first.data.message;
  let nextAction = first.data.next_action;
  let ai = first.ai;
  let rewriteNote = null;

  if (policy.changed) {
    // The AI's message was written for a different tone, so rewrite it for the enforced one.
    try {
      const re = await callLLM(REWRITE_SYSTEM, `Context (JSON):\n${JSON.stringify({ ...ctx, tone: policy.tone }, null, 2)}`, {
        validate: validateRewrite(policy.tone),
        mock: () => ({ message: sampleReminder().message, next_action: sampleReminder().next_action }),
      });
      message = re.data.message;
      nextAction = re.data.next_action;
      ai = { ...re.ai, fallback_used: first.ai.fallback_used || re.ai.fallback_used };
    } catch (err) {
      rewriteNote = `The message was written for a ${aiTone} tone. Review it before sending.`;
      console.warn(`[ai] tone rewrite failed, keeping the original message (${err.code || err.message})`);
    }
  }

  return {
    decision: {
      tone: policy.tone,
      reasoning: withNumbers(first.data.reasoning, days, sent),
      message: capWords(message),
      next_action: nextAction.trim(),
      ai_tone: aiTone,
      minimum_tone: policy.minimum,
      policy_note: [policy.changed ? POLICY_NOTES[policy.changed] : null, rewriteNote].filter(Boolean).join(" ") || null,
    },
    ai,
  };
}

module.exports = { parseDeal, reminderStrategy, applyEscalationPolicy, minimumTone, TONES };

