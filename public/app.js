// Plain JS frontend. All data is rendered with textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("Cannot reach the server. Is `npm start` running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const details = Array.isArray(e.details) ? e.details.map((d) => (typeof d === "string" ? d : d.description || d.issue)).filter(Boolean) : [];
    throw new Error([e.message || `Request failed (${res.status})`, ...details.map((d) => `• ${d}`)].join("\n"));
  }
  return data;
}

function show(el, on = true) { el.hidden = !on; }
function showError(el, err) { el.textContent = err ? err.message || String(err) : ""; show(el, Boolean(err)); }
function busy(btn, on) { btn.disabled = on; btn.classList.toggle("loading", on); }
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
}

let toastTimer;
function toast(text, link) {
  const t = $("toast");
  t.replaceChildren(text);
  if (link) t.append(" ", el("a", { href: link, target: "_blank", rel: "noopener", textContent: "Open client view" }));
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(t, false), 7000);
}

// ---------- config ----------
let config = {};
api("/api/config").then((c) => {
  config = c;
  const pill = $("ai-pill");
  const names = c.ai.providers.map((p) => p.name);
  pill.textContent = c.ai.sample_data ? "AI: SAMPLE DATA" : names.length ? `AI: ${names.join(" → ")}` : "AI: not configured";
  pill.title = c.ai.sample_data ? "AI_MODE=mock: responses are sample data for local development" : names.length > 1 ? "Second provider is used if the first returns 429, 5xx or times out" : "";
  pill.classList.toggle("mock", c.ai.sample_data);
}).catch(() => { $("ai-pill").textContent = "AI: unknown"; });

// Small "AI via <provider>" label, or a sample-data warning in mock mode.
function renderAiLabel(labelId, sampleId, ai) {
  const label = $(labelId);
  label.textContent = ai?.sample_data ? "Sample data" : ai ? `AI via ${ai.provider}${ai.fallback_used ? " (fallback)" : ""}` : "";
  label.title = ai?.model ? `Model: ${ai.model}${ai.fallback_used ? ". The primary provider failed, so the fallback answered." : ""}` : "";
  label.classList.toggle("sample", Boolean(ai?.sample_data));
  label.classList.toggle("fallback", Boolean(ai?.fallback_used));
  show($(sampleId), Boolean(ai?.sample_data));
}

// ---------- (a) New deal ----------
let currentPlan = null;

$("parse-btn").addEventListener("click", async () => {
  const text = $("deal-text").value.trim();
  showError($("parse-error"), null);
  if (!text) return showError($("parse-error"), new Error("Describe the deal first."));
  busy($("parse-btn"), true);
  $("parse-status").textContent = "Reading the deal…";
  try {
    const { plan, ai } = await api("/api/deals/parse", { text });
    renderPlan(plan);
    renderAiLabel("plan-ai", "plan-sample", ai);
  } catch (err) {
    showError($("parse-error"), err);
  } finally {
    busy($("parse-btn"), false);
    $("parse-status").textContent = "";
  }
});

function renderPlan(plan) {
  currentPlan = plan;
  const missing = new Set(plan.missing_fields || []);
  const setField = (id, value, key) => {
    const node = $(id);
    node.textContent = value ?? "Missing";
    node.classList.toggle("is-missing", missing.has(key) || value == null);
  };
  setField("plan-name", plan.client_name, "client_name");
  setField("plan-email", plan.client_email, "client_email");
  setField("plan-total", plan.total ? `${money(plan.total)} USD` : null, "total");

  const body = $("plan-instalments");
  body.replaceChildren(...plan.instalments.map((inst, i) => el("tr", {},
    el("td", { textContent: i + 1 }),
    el("td", { textContent: inst.label }),
    el("td", { textContent: `${inst.percent}%` }),
    el("td", { textContent: plan.total ? money((plan.total * inst.percent) / 100) : "–" }),
    el("td", { textContent: inst.due_in_days === 0 ? "On approval" : `In ${inst.due_in_days} days` }),
  )));

  const labels = { client_name: "client name", client_email: "client email", total: "total amount", instalments: "a valid instalment schedule (percents must add up to 100)", currency_usd_only: "USD amounts (only USD is supported)" };
  const m = $("plan-missing");
  m.textContent = missing.size ? `Missing or unclear: ${[...missing].map((k) => labels[k] || k).join(", ")}. Add it to the description and parse again.` : "";
  show(m, missing.size > 0);

  $("plan-recipient-note").textContent = config.sandbox_recipient_override
    ? "Sandbox: invoices go to the sandbox buyer set in CLIENT_EMAIL, not the address above."
    : "";
  $("approve-plan-btn").disabled = missing.size > 0;
  showError($("approve-error"), null);
  show($("plan"));
}

$("cancel-plan-btn").addEventListener("click", () => {
  currentPlan = null;
  show($("plan"), false);
});

$("approve-plan-btn").addEventListener("click", async () => {
  if (!currentPlan) return;
  const btn = $("approve-plan-btn");
  busy(btn, true);
  $("cancel-plan-btn").disabled = true;
  showError($("approve-error"), null);
  try {
    const r = await api("/api/deals/approve", { plan: currentPlan, approved: true });
    toast(`Instalment 1 sent. Invoice ${r.invoice_id} is ${r.status}.`, r.client_view_url);
    currentPlan = null;
    show($("plan"), false);
    $("deal-text").value = "";
    loadDeals();
  } catch (err) {
    showError($("approve-error"), err);
    loadDeals();
  } finally {
    busy(btn, false);
    $("cancel-plan-btn").disabled = false;
  }
});

// ---------- (b) Deals ----------
let deals = [];

async function loadDeals() {
  showError($("deals-error"), null);
  show($("deals-loading"));
  busy($("refresh-btn"), true);
  try {
    ({ deals } = await api("/api/deals"));
    renderDeals();
  } catch (err) {
    showError($("deals-error"), err);
  } finally {
    show($("deals-loading"), false);
    busy($("refresh-btn"), false);
  }
}

function renderDeals() {
  show($("deals-empty"), deals.length === 0);
  show($("deals-table"), deals.length > 0);
  $("deals-body").replaceChildren(...deals.slice().reverse().map((d) => {
    const cur = d.current_instalment;
    const unpaid = cur && ["Sent", "Overdue"].includes(cur.badge);
    const badge = cur ? cur.badge : "Not sent";

    const sendBtn = el("button", { className: "btn small", textContent: "Send next instalment", disabled: !d.next_instalment });
    sendBtn.title = d.next_instalment ? `Send instalment ${d.next_instalment}` : "All instalments sent";
    sendBtn.addEventListener("click", () => openConfirm(d));

    const adviceBtn = el("button", { className: "btn small", textContent: "Get reminder advice", disabled: !unpaid });
    adviceBtn.addEventListener("click", () => openReminder(d));

    const payBtn = el("button", { className: "btn small", textContent: "Simulate payment", disabled: !unpaid });
    payBtn.title = "Demo only: records a payment in the sandbox. No money moves.";
    payBtn.addEventListener("click", () => simulatePayment(d, payBtn));

    const clientCell = el("td", {}, el("strong", { textContent: d.client_name }), el("span", { className: "cell-sub", textContent: d.client_email }));
    const amountCell = el("td", {}, money(cur ? cur.amount : d.total), el("span", { className: "cell-sub", textContent: `of ${money(d.total)} total` }));
    const instCell = el("td", {}, cur ? `${cur.n} of ${d.instalments.length}` : "–", el("span", { className: "cell-sub", textContent: cur ? cur.label : "" }));
    const statusCell = el("td", {}, el("span", { className: `badge ${badge}`, textContent: badge }));
    if (cur?.status_error) statusCell.append(el("span", { className: "cell-sub", textContent: "Could not load status" }));
    return el("tr", {}, clientCell, amountCell, instCell, statusCell, el("td", {}, el("div", { className: "actions" }, sendBtn, adviceBtn, payBtn)));
  }));
}

$("refresh-btn").addEventListener("click", loadDeals);

async function simulatePayment(deal, btn) {
  busy(btn, true);
  try {
    const r = await api(`/api/deals/${encodeURIComponent(deal.id)}/simulate-payment`, {});
    toast(`Demo only: recorded ${r.amount_recorded}. Invoice is now ${r.status}.`);
    loadDeals();
  } catch (err) {
    showError($("deals-error"), err);
    busy(btn, false);
  }
}

// ---------- modals ----------
function openModal(id) { show($(id)); }
function closeModal(id) { show($(id), false); }
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m || e.target.hasAttribute("data-close")) closeModal(m.id); });
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".modal:not([hidden])").forEach((m) => closeModal(m.id)); });

// Approval for "Send next instalment"
let confirmDeal = null;
function openConfirm(deal) {
  confirmDeal = deal;
  const inst = deal.instalments[deal.next_instalment - 1];
  $("confirm-body").textContent = `This creates a PayPal invoice for ${money(inst.amount)} (${inst.label}, instalment ${inst.n} of ${deal.instalments.length}) and emails it to ${deal.sent_to_email}.`;
  showError($("confirm-error"), null);
  openModal("confirm-modal");
}

$("confirm-approve-btn").addEventListener("click", async () => {
  if (!confirmDeal) return;
  const btn = $("confirm-approve-btn");
  busy(btn, true);
  try {
    const r = await api(`/api/deals/${encodeURIComponent(confirmDeal.id)}/instalments/${confirmDeal.next_instalment}/send`, { approved: true });
    closeModal("confirm-modal");
    toast(`Instalment ${r.instalment} sent. Invoice ${r.invoice_id} is ${r.status}.`, r.client_view_url);
    loadDeals();
  } catch (err) {
    showError($("confirm-error"), err);
  } finally {
    busy(btn, false);
  }
});

// (c) Reminder decision card
let reminderDeal = null;
let reminderApproved = false;

function setReminderApproved(on) {
  reminderApproved = on;
  $("send-reminder-btn").disabled = !on;
  $("approve-reminder-btn").textContent = on ? "Approved ✓" : "Approve";
  $("reminder-approval").textContent = on ? "Approved. Editing the message will require approval again." : "Approve the message to enable Send.";
}

function openReminder(deal) {
  reminderDeal = deal;
  const cur = deal.current_instalment;
  $("reminder-for").textContent = `${deal.client_name} · ${money(cur.amount)} · ${cur.label} (${cur.n} of ${deal.instalments.length}) · ${deal.reminders_sent} reminder(s) sent so far`;
  show($("decision"), false);
  showError($("advice-error"), null);
  showError($("send-error"), null);
  setReminderApproved(false);
  openModal("reminder-modal");
}

$("advice-btn").addEventListener("click", async () => {
  const days = Number($("days-overdue").value);
  showError($("advice-error"), null);
  if (!Number.isInteger(days) || days < 0 || days > 365) return showError($("advice-error"), new Error("Days overdue must be a whole number from 0 to 365."));
  const btn = $("advice-btn");
  busy(btn, true);
  show($("advice-loading"));
  show($("decision"), false);
  try {
    const { decision, ai } = await api(`/api/deals/${encodeURIComponent(reminderDeal.id)}/reminder-strategy`, { days_overdue: days });
    renderAiLabel("decision-ai", "decision-sample", ai);
    $("decision-tone").textContent = decision.tone.replace("_", " ");
    $("decision-tone").className = `tone ${decision.tone}`;
    $("decision-reasoning").textContent = decision.reasoning;
    $("decision-message").value = decision.message;
    $("decision-next").textContent = decision.next_action;
    setReminderApproved(false);
    showError($("send-error"), null);
    show($("decision"));
  } catch (err) {
    showError($("advice-error"), err);
  } finally {
    busy(btn, false);
    show($("advice-loading"), false);
  }
});

$("decision-message").addEventListener("input", () => setReminderApproved(false));

$("approve-reminder-btn").addEventListener("click", () => {
  if (!$("decision-message").value.trim()) return showError($("send-error"), new Error("The message is empty."));
  showError($("send-error"), null);
  setReminderApproved(true);
});

$("send-reminder-btn").addEventListener("click", async () => {
  if (!reminderApproved) return;
  const btn = $("send-reminder-btn");
  busy(btn, true);
  showError($("send-error"), null);
  try {
    await api(`/api/deals/${encodeURIComponent(reminderDeal.id)}/remind`, { message: $("decision-message").value.trim(), approved: true });
    closeModal("reminder-modal");
    toast("Reminder sent through PayPal.");
    loadDeals();
  } catch (err) {
    showError($("send-error"), err);
    btn.disabled = false;
  } finally {
    btn.classList.remove("loading");
  }
});

loadDeals();
