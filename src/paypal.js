// PayPal Invoicing v2 client. Sandbox only, USD only.
// call() and the invoice payload are adapted from scripts/phase1-test.js.
const { AppError, addRuntimeSecret, redact } = require("./safe");

const SANDBOX_HOSTS = new Set(["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]);
const BASE = (process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com").replace(/\/+$/, "");

if (!SANDBOX_HOSTS.has(new URL(BASE).hostname)) {
  throw new Error("PAYPAL_BASE_URL must point to the PayPal sandbox (https://api-m.sandbox.paypal.com). Live mode is not supported.");
}

async function call(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, options);
  } catch (err) {
    throw new AppError(502, "PAYPAL_UNREACHABLE", `Could not reach PayPal: ${redact(err.message)}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const body = data && typeof data === "object" ? data : {};
    const details = (body.details || []).map((d) => ({ issue: d.issue, field: d.field, description: d.description }));
    const message = details.find((d) => d.description)?.description || body.message || body.error_description || `HTTP ${res.status}`;
    throw new AppError(502, "PAYPAL_ERROR", redact(`PayPal ${res.status} on ${path.split("?")[0]}: ${message}`), JSON.parse(redact({
      paypal_status: res.status,
      name: body.name || body.error,
      debug_id: body.debug_id,
      details,
    })));
  }
  return data;
}

let cachedToken = null; // { value, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new AppError(503, "PAYPAL_NOT_CONFIGURED", "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env.");
  }
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const tok = await call("/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  addRuntimeSecret(tok.access_token);
  cachedToken = { value: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 };
  return cachedToken.value;
}

async function authed(path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  return call(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// due_date: "YYYY-MM-DD". amount: string with 2 decimals, e.g. "250.00".
async function createDraftInvoice({ recipientEmail, recipientName, itemName, amount, dueDate, note }) {
  const draft = await authed("/v2/invoicing/invoices", {
    method: "POST",
    body: {
      detail: {
        currency_code: "USD",
        note,
        payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: dueDate },
      },
      invoicer: { name: { given_name: "Test", surname: "Freelancer" } },
      primary_recipients: [{ billing_info: { email_address: recipientEmail, name: { full_name: recipientName } } }],
      items: [{ name: itemName, quantity: "1", unit_amount: { currency_code: "USD", value: amount } }],
    },
  });
  const id = draft?.id || draft?.href?.split("/").pop();
  if (!id) throw new AppError(502, "PAYPAL_ERROR", "PayPal created the invoice but returned no invoice ID.");
  return id;
}

async function sendInvoice(id) {
  await authed(`/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
    method: "POST",
    body: { send_to_recipient: true, send_to_invoicer: true },
  });
}

async function getInvoice(id) {
  return authed(`/v2/invoicing/invoices/${encodeURIComponent(id)}`);
}

// POST /v2/invoicing/invoices/{id}/remind with a `notification` body. Returns 204.
// PayPal's spec notes the subject and note may be replaced with its default text,
// and that only 2 reminders per invoice per day are allowed.
async function sendReminder(id, message) {
  await authed(`/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
    method: "POST",
    body: { subject: "Payment reminder", note: message, send_to_recipient: true, send_to_invoicer: true },
  });
}

// POST /v2/invoicing/invoices/{id}/payments with a `payment_detail` body.
// Records an external (non-PayPal) payment. No money moves.
async function recordPayment(id, amount, note) {
  return authed(`/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
    method: "POST",
    body: {
      method: "OTHER",
      payment_date: new Date().toISOString().slice(0, 10),
      amount: { currency_code: "USD", value: amount },
      note,
    },
  });
}

module.exports = { getAccessToken, createDraftInvoice, sendInvoice, getInvoice, sendReminder, recordPayment };
