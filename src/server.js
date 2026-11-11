const path = require("path");
const crypto = require("crypto");
const express = require("express");
const paypal = require("./paypal");
const ai = require("./ai");
const store = require("./store");
const { describeConfig } = require("./llm");
const { AppError, redact } = require("./safe");

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use((req, res, next) => {
  res.on("finish", () => {
    if (req.path.startsWith("/api/")) console.log(`${req.method} ${req.path} -> ${res.statusCode}`);
  });
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- helpers ----------

function requireApproval(req) {
  if (req.body?.approved !== true) {
    throw new AppError(403, "APPROVAL_REQUIRED", "This action sends something to the client. Send {\"approved\": true} after the user clicks Approve.");
  }
}

function addDays(days, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const today = () => new Date().toISOString().slice(0, 10);

// Split the total into instalment amounts in cents; the last instalment absorbs rounding.
function splitAmounts(total, instalments) {
  const cents = Math.round(total * 100);
  let used = 0;
  return instalments.map((inst, i) => {
    const c = i === instalments.length - 1 ? cents - used : Math.round((cents * inst.percent) / 100);
    used += c;
    return (c / 100).toFixed(2);
  });
}

function validatePlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== "object") throw new AppError(400, "BAD_REQUEST", "plan is required.");
  if (typeof plan.client_name !== "string" || !plan.client_name.trim()) problems.push("client_name is required");
  if (typeof plan.client_email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.client_email)) problems.push("client_email must be a valid email");
  if (typeof plan.total !== "number" || !(plan.total > 0) || plan.total > 100000) problems.push("total must be a number between 0 and 100000");
  if (plan.currency !== "USD") problems.push("currency must be USD");
  const inst = Array.isArray(plan.instalments) ? plan.instalments : [];
  if (!inst.length || inst.length > 12) problems.push("instalments must have 1-12 entries");
  if (inst.some((i) => typeof i?.label !== "string" || !(i.percent > 0) || !Number.isInteger(i.due_in_days) || i.due_in_days < 0 || i.due_in_days > 365)) {
    problems.push("each instalment needs a label, a percent above 0 and due_in_days between 0 and 365");
  }
  if (Math.abs(inst.reduce((s, i) => s + Number(i?.percent || 0), 0) - 100) > 0.01) problems.push("instalment percents must add up to 100");
  if (Array.isArray(plan.missing_fields) && plan.missing_fields.length) problems.push(`plan still has missing fields: ${plan.missing_fields.join(", ")}`);
  if (problems.length) throw new AppError(400, "INVALID_PLAN", "The plan cannot be approved yet.", problems);
}

function findDeal(id) {
  const deal = store.getDeal(id);
  if (!deal) throw new AppError(404, "NOT_FOUND", "Deal not found.");
  return deal;
}

const locks = new Set();
async function withDealLock(id, fn) {
  if (locks.has(id)) throw new AppError(409, "BUSY", "Another action on this deal is still running. Try again in a moment.");
  locks.add(id);
  try { return await fn(); } finally { locks.delete(id); }
}

// Creates (if needed) and sends the PayPal invoice for instalment index i.
async function sendInstalment(deal, i) {
  const inst = deal.instalments[i];
  if (!inst.invoice_id) {
    const due = inst.due_date < today() ? today() : inst.due_date;
    inst.invoice_id = await paypal.createDraftInvoice({
      recipientEmail: deal.sent_to_email,
      recipientName: deal.plan.client_name,
      itemName: `${inst.label} (${i + 1} of ${deal.instalments.length})`,
      amount: inst.amount,
      dueDate: due,
      note: `Instalment ${i + 1} of ${deal.instalments.length} for ${deal.plan.client_name}.`,
    });
    store.saveDeal(deal); // keep the draft ID even if sending fails
  }
  await paypal.sendInvoice(inst.invoice_id);
  inst.sent_at = new Date().toISOString();
  store.saveDeal(deal);
  const inv = await paypal.getInvoice(inst.invoice_id);
  return { invoice_id: inst.invoice_id, status: inv.status, badge: badgeFor(inv), client_view_url: inv.detail?.metadata?.recipient_view_url || null };
}

function badgeFor(inv) {
  const s = inv?.status;
  if (s === "PAID" || s === "MARKED_AS_PAID") return "Paid";
  if (s === "DRAFT") return "Draft";
  const due = inv?.detail?.payment_term?.due_date;
  if (["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED"].includes(s) && due && due < today()) return "Overdue";
  if (s === "SENT" || s === "UNPAID" || s === "SCHEDULED" || s === "PARTIALLY_PAID" || s === "PAYMENT_PENDING") return "Sent";
  return s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "Unknown";
}

const UNPAID = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED"]);

function latestSentIndex(deal) {
  for (let i = deal.instalments.length - 1; i >= 0; i--) if (deal.instalments[i].sent_at) return i;
  return -1;
}

async function liveDeal(deal) {
  const instalments = await Promise.all(deal.instalments.map(async (inst, i) => {
    const base = { n: i + 1, label: inst.label, percent: inst.percent, amount: inst.amount, due_date: inst.due_date, invoice_id: inst.invoice_id, sent_at: inst.sent_at };
    if (!inst.invoice_id) return { ...base, status: null, badge: "Not created" };
    try {
      const inv = await paypal.getInvoice(inst.invoice_id);
      return { ...base, status: inv.status, badge: badgeFor(inv), paypal_due_date: inv.detail?.payment_term?.due_date || null, client_view_url: inv.detail?.metadata?.recipient_view_url || null };
    } catch (err) {
      return { ...base, status: null, badge: "Unknown", status_error: err.message };
    }
  }));
  const cur = latestSentIndex(deal);
  const next = deal.instalments.findIndex((x) => !x.sent_at);
  return {
    id: deal.id,
    created_at: deal.created_at,
    client_name: deal.plan.client_name,
    client_email: deal.plan.client_email,
    sent_to_email: deal.sent_to_email,
    total: deal.plan.total,
    currency: "USD",
    current_instalment: cur === -1 ? null : instalments[cur],
    next_instalment: next === -1 ? null : next + 1,
    reminders_sent: deal.reminders.length,
    instalments,
  };
}

async function latestUnpaidInvoice(deal) {
  const i = latestSentIndex(deal);
  if (i === -1) throw new AppError(409, "NOTHING_SENT", "No invoice has been sent for this deal yet.");
  const inst = deal.instalments[i];
  const inv = await paypal.getInvoice(inst.invoice_id);
  if (!UNPAID.has(inv.status)) throw new AppError(409, "NOT_UNPAID", `The latest invoice is ${inv.status}, so there is nothing to collect.`);
  return { i, inst, inv };
}

// ---------- routes ----------

app.get("/api/config", (req, res) => {
  res.json({ ai: describeConfig(), paypal: "sandbox", currency: "USD", sandbox_recipient_override: Boolean(process.env.CLIENT_EMAIL) });
});

app.post("/api/deals/parse", async (req, res) => {
  const { plan, ai: aiInfo } = await ai.parseDeal(req.body?.text);
  res.json({ plan, ai: aiInfo });
});

app.post("/api/deals/approve", async (req, res) => {
  requireApproval(req);
  const plan = req.body.plan;
  validatePlan(plan);
  const amounts = splitAmounts(plan.total, plan.instalments);
  const deal = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    plan: {
      client_name: plan.client_name.trim(),
      client_email: plan.client_email.trim(),
      total: Math.round(plan.total * 100) / 100,
      currency: "USD",
      instalments: plan.instalments.map(({ label, percent, due_in_days }) => ({ label, percent, due_in_days })),
    },
    // Sandbox safety: if CLIENT_EMAIL is set, every invoice goes to that sandbox buyer.
    sent_to_email: process.env.CLIENT_EMAIL || plan.client_email.trim(),
    instalments: plan.instalments.map((inst, i) => ({
      label: inst.label, percent: inst.percent, amount: amounts[i], due_date: addDays(inst.due_in_days), invoice_id: null, sent_at: null,
    })),
    reminders: [],
  };
  store.saveDeal(deal);
  const result = await withDealLock(deal.id, () => sendInstalment(deal, 0));
  res.status(201).json({ deal_id: deal.id, instalment: 1, ...result });
});

app.get("/api/deals", async (req, res) => {
  const deals = store.listDeals();
  res.json({ deals: await Promise.all(deals.map(liveDeal)) });
});

app.post("/api/deals/:id/instalments/:n/send", async (req, res) => {
  requireApproval(req);
  const deal = findDeal(req.params.id);
  const n = Number(req.params.n);
  const next = deal.instalments.findIndex((x) => !x.sent_at);
  if (next === -1) throw new AppError(409, "ALL_SENT", "All instalments for this deal have already been sent.");
  if (n !== next + 1) throw new AppError(409, "WRONG_INSTALMENT", `The next instalment to send is ${next + 1}, not ${req.params.n}.`);
  const result = await withDealLock(deal.id, () => sendInstalment(deal, next));
  res.json({ deal_id: deal.id, instalment: n, ...result });
});

app.post("/api/deals/:id/reminder-strategy", async (req, res) => {
  const deal = findDeal(req.params.id);
  const days = Number(req.body?.days_overdue);
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new AppError(400, "BAD_REQUEST", "days_overdue must be a whole number from 0 to 365.");
  const { i, inst, inv } = await latestUnpaidInvoice(deal);
  const earlier = deal.instalments.slice(0, i).length;
  const context = {
    client_name: deal.plan.client_name,
    amount: `${inst.amount} USD`,
    days_overdue: days,
    reminders_sent: deal.reminders.filter((r) => r.invoice_id === inst.invoice_id).length,
    instalment_label: `${inst.label} (instalment ${i + 1} of ${deal.instalments.length})`,
    notes: `PayPal status: ${inv.status}. Deal total ${deal.plan.total} USD. ${earlier ? `${earlier} earlier instalment(s) were already invoiced.` : "This is the first invoice for this client."}`,
  };
  const { decision, ai: aiInfo } = await ai.reminderStrategy(context);
  res.json({ deal_id: deal.id, invoice_id: inst.invoice_id, context, decision, ai: aiInfo });
});

app.post("/api/deals/:id/remind", async (req, res) => {
  requireApproval(req);
  const deal = findDeal(req.params.id);
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > 4000) throw new AppError(400, "BAD_REQUEST", "message is required and must be 4000 characters or fewer.");
  await withDealLock(deal.id, async () => {
    const { inst } = await latestUnpaidInvoice(deal);
    await paypal.sendReminder(inst.invoice_id, message);
    deal.reminders.push({ invoice_id: inst.invoice_id, sent_at: new Date().toISOString(), message });
    store.saveDeal(deal);
    res.json({
      deal_id: deal.id,
      invoice_id: inst.invoice_id,
      reminder_sent: true,
      note: "PayPal's API docs say it may replace a custom reminder note with its own default text.",
    });
  });
});

app.post("/api/deals/:id/simulate-payment", async (req, res) => {
  const deal = findDeal(req.params.id);
  await withDealLock(deal.id, async () => {
    const { inst, inv } = await latestUnpaidInvoice(deal);
    const amount = inv.due_amount?.value || inv.amount?.value || inst.amount;
    const payment = await paypal.recordPayment(inst.invoice_id, amount, "DEMO ONLY: simulated payment recorded by the invoice agent. No money moved.");
    const after = await paypal.getInvoice(inst.invoice_id);
    res.json({
      demo_only: true,
      label: "DEMO ONLY: records an external payment in the PayPal sandbox. No money moves.",
      deal_id: deal.id,
      invoice_id: inst.invoice_id,
      amount_recorded: `${amount} USD`,
      payment_id: payment?.payment_id || null,
      status: after.status,
      badge: badgeFor(after),
    });
  });
});

app.use("/api", (req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown API route." } }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") err = new AppError(400, "BAD_JSON", "Request body is not valid JSON.");
  if (err.type === "entity.too.large") err = new AppError(413, "TOO_LARGE", "Request body is too large.");
  const status = err instanceof AppError ? err.status : 500;
  const message = err instanceof AppError ? err.message : "Internal server error.";
  console.error(`[error] ${req.method} ${req.path}: ${redact(err.message)}`);
  res.status(status).json({ error: { code: err.code || "INTERNAL", message: redact(message), details: err.details } });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "127.0.0.1", () => {
  const cfg = describeConfig();
  console.log(`Invoice agent running at http://localhost:${PORT} (PayPal sandbox, USD only)`);
  if (cfg.mode === "mock") console.log("AI: MOCK MODE, returns sample data (local development only)");
  else if (!cfg.providers.length) console.log("AI: not configured (set AI_BASE_URL, AI_API_KEY, AI_MODEL)");
  for (const p of cfg.providers) {
    console.log(`AI ${p.role}: ${p.name} model=${p.model || "(none)"}${p.model_defaulted ? " (default; *_MODEL was empty or a provider name)" : ""} key_set=${p.api_key_set}`);
  }
});
