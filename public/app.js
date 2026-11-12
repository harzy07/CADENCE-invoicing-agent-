// Plainbill frontend. Plain JS, no frameworks. All data is rendered with
// textContent / DOM nodes, never innerHTML with server data.
// The only place that sends {approved: true} is the confirm modal's
// "Approve and send" button (see confirmSend).

const $ = (id) => document.getElementById(id);
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n) => USD.format(Number(n) || 0);
const fmtDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "–");
const fmtTime = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

// ---------- DOM helpers ----------
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}
function svg(path) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  s.append(p);
  return s;
}
const ICON = {
  doc: "M6 2h9l5 5v15H6zm8 1.5V8h4.5zM9 12v2h8v-2zm0 4v2h8v-2z",
  spark: "M12 2l1.8 5.6L19.5 9l-5.7 1.5L12 16l-1.8-5.5L4.5 9l5.7-1.4zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z",
  check: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z",
  send: "M2 21l21-9L2 3v7l15 2-15 2z",
  coin: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 15v2h-2v-2c-1.7-.3-3-1.3-3-3h2c0 .8.9 1.3 2 1.3s2-.5 2-1.3-.6-1.1-2.3-1.5C9.6 12 8 11.3 8 9.5c0-1.4 1.2-2.5 3-2.8V5h2v1.7c1.7.3 3 1.4 3 3h-2c0-.8-.9-1.3-2-1.3s-2 .5-2 1.2c0 .7.7 1 2.4 1.4 2.1.5 3.6 1.2 3.6 3.1 0 1.5-1.3 2.6-3 2.9",
  bell: "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2m6-6V11a6 6 0 0 0-5-5.9V4h-2v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1z",
  dots: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4m0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14m-1 2v6l5 3 1-1.7-4-2.4V7z",
};

function setBusy(btn, on) { btn.disabled = on; btn.classList.toggle("is-loading", on); btn.setAttribute("aria-busy", on ? "true" : "false"); }
function showAlert(el, err, title) {
  if (!err) { el.hidden = true; el.replaceChildren(); return; }
  el.replaceChildren(...(title ? [h("strong", { text: title })] : []), err.message || String(err));
  el.hidden = false;
}
function toast(text, { link, error } = {}) {
  const t = h("div", { class: `toast${error ? " error" : ""}`, role: error ? "alert" : "status" }, text);
  if (link) t.append(" ", h("a", { href: link, target: "_blank", rel: "noopener", text: "Open client view" }));
  $("toasts").append(t);
  setTimeout(() => t.remove(), 7000);
}

// ---------- API ----------
async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error("Can't reach the server. Check that it's running (npm start) and try again."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    const details = Array.isArray(e.details) ? e.details.map((d) => (typeof d === "string" ? d : d.description || d.issue)).filter(Boolean) : [];
    const err = new Error([friendly(e.code, e.message || `Request failed (${res.status}).`), ...details.map((d) => `• ${d}`)].join("\n"));
    err.code = e.code;
    throw err;
  }
  return data;
}
function friendly(code, message) {
  const hints = {
    AI_UNAVAILABLE: "The AI service is busy right now. Wait a moment and try again.",
    AI_NOT_CONFIGURED: "The AI isn't set up yet. Add an AI key to the server's .env file.",
    AI_AUTH_FAILED: "The AI provider rejected the API key. Check the key in .env.",
    AI_MALFORMED: "The AI gave an unreadable answer twice. Try again, or rephrase the deal.",
    PAYPAL_UNREACHABLE: "Can't reach PayPal right now. Check your connection and try again.",
    BUSY: "Another action on this deal is still running. Try again in a moment.",
  };
  return hints[code] ? `${hints[code]}\n${message}` : message;
}

// ---------- Local activity log ----------
// The server stores approvals and send times. Parse events, reminder times and
// simulated payments are recorded here, in this browser, as they happen.
const LOG_KEY = "plainbill.activity.v1";
function readLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { return []; } }
function logEvent(e) {
  const log = readLog();
  log.push({ ...e, at: new Date().toISOString() });
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-500))); } catch { /* storage full or disabled */ }
}

// ---------- State ----------
const state = { config: null, deals: null, loading: false, error: null, plan: null, planAi: null };

function invoiceRows() {
  if (!state.deals) return [];
  const rows = [];
  for (const d of state.deals) {
    const cur = d.current_instalment?.n;
    for (const inst of d.instalments) {
      rows.push({
        deal: d, inst,
        amount: Number(inst.amount),
        due: inst.paypal_due_date || inst.due_date,
        badge: inst.badge,
        isCurrent: inst.n === cur,
        isNext: inst.n === d.next_instalment,
      });
    }
  }
  return rows.sort((a, b) => (b.deal.created_at || "").localeCompare(a.deal.created_at || "") || a.inst.n - b.inst.n);
}

const PILL = { Draft: "draft", Sent: "sent", Paid: "paid", Overdue: "overdue", "Not created": "pending", Unknown: "unknown" };
const pill = (badge) => h("span", { class: `pill pill-${PILL[badge] || "draft"}`, text: badge === "Not created" ? "Not sent" : badge === "Unknown" ? "Status unavailable" : badge });

// ---------- Router ----------
const TITLES = { dashboard: "Dashboard", new: "New deal", invoices: "Invoices", activity: "Activity" };
function route() {
  const name = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : "dashboard";
  document.querySelectorAll(".page").forEach((p) => { p.hidden = p.dataset.page !== name; });
  document.querySelectorAll(".nav a").forEach((a) => (a.dataset.route === name ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  $("page-title").textContent = TITLES[name];
  document.title = `${TITLES[name]} · Plainbill`;
  closeMenu();
  render();
}
window.addEventListener("hashchange", () => { route(); $("view").focus({ preventScroll: true }); });

// ---------- Config / AI badge ----------
function renderAiBadge() {
  const b = $("ai-badge");
  const c = state.config?.ai;
  b.className = "badge badge-ai";
  if (!c) { b.textContent = "AI: unavailable"; b.classList.add("is-off"); return; }
  if (c.sample_data) { b.textContent = "AI: sample data"; b.classList.add("is-sample"); b.title = "AI_MODE=mock: responses are sample data for local development"; return; }
  const names = c.providers.map((p) => p.name);
  if (!names.length) { b.textContent = "AI: not configured"; b.classList.add("is-off"); return; }
  b.textContent = `AI: ${names[0]}`;
  b.title = names.length > 1 ? `Primary ${names[0]} (${c.providers[0].model}). Falls back to ${names[1]} if ${names[0]} is busy or down.` : `${names[0]} (${c.providers[0].model})`;
}
// Small "AI via <provider>" badge next to AI output.
function aiVia(el, ai) {
  el.className = "badge badge-ai";
  if (!ai) { el.hidden = true; return; }
  el.hidden = false;
  if (ai.sample_data) { el.textContent = "Sample data"; el.classList.add("is-sample"); el.title = "AI_MODE=mock"; return; }
  el.textContent = `AI via ${ai.provider}${ai.fallback_used ? " (fallback)" : ""}`;
  el.title = `Model: ${ai.model}${ai.fallback_used ? ". The primary provider failed, so the fallback answered." : ""}`;
  if (ai.fallback_used) el.classList.add("is-fallback");
}

// ---------- Data loading ----------
async function loadDeals() {
  state.loading = true; state.error = null;
  render();
  try { state.deals = (await api("/api/deals")).deals; }
  catch (err) { state.error = err; }
  finally { state.loading = false; render(); }
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-refresh]")) loadDeals(); });

// Address invoices actually go to. With CLIENT_EMAIL set, the server sends
// every invoice to that sandbox buyer instead of the parsed email.
function recipientFor(planEmail) {
  if (!state.config?.sandbox_recipient_override) return { email: planEmail, note: null };
  const known = state.deals?.find((d) => d.sent_to_email)?.sent_to_email;
  return { email: known || "the sandbox buyer (CLIENT_EMAIL)", note: "Sandbox: all invoices go to the test buyer set in CLIENT_EMAIL, not the client's address." };
}

// ---------- Render ----------
function render() {
  renderSummary();
  document.querySelectorAll("[data-invoices]").forEach((el) => renderInvoices(el, el.dataset.invoices === "recent" ? 6 : Infinity));
  renderReview();
  renderActivity();
}

function renderSummary() {
  const box = $("summary");
  const cards = [
    { key: "Outstanding", color: "var(--blue-fg)", badges: ["Sent", "Overdue"] },
    { key: "Paid", color: "var(--green-fg)", badges: ["Paid"] },
    { key: "Overdue", color: "#d97706", badges: ["Overdue"] },
  ];
  if (!state.deals && (state.loading || !state.error)) {
    box.replaceChildren(...cards.map((c) => h("div", { class: "card stat", "aria-busy": "true" },
      h("span", { class: "stat-label" }, h("i", { style: `background:${c.color}` }), c.key),
      h("span", { class: "sk sk-value" }), h("span", { class: "sk sk-line short" }))));
    return;
  }
  if (!state.deals) { // load failed: show "unavailable", not a misleading $0.00
    box.replaceChildren(...cards.map((c) => h("div", { class: "card stat" },
      h("span", { class: "stat-label" }, h("i", { style: `background:${c.color}` }), c.key),
      h("span", { class: "stat-value muted-value", text: "–" }),
      h("span", { class: "stat-sub", text: "Unavailable" }))));
    return;
  }
  const rows = invoiceRows();
  box.replaceChildren(...cards.map((c) => {
    const match = rows.filter((r) => c.badges.includes(r.badge));
    const total = match.reduce((s, r) => s + r.amount, 0);
    return h("div", { class: "card stat" },
      h("span", { class: "stat-label" }, h("i", { style: `background:${c.color}` }), c.key),
      h("span", { class: "stat-value", text: money(total) }),
      h("span", { class: "stat-sub", text: `${match.length} invoice${match.length === 1 ? "" : "s"}` }));
  }));
}

function renderInvoices(container, limit) {
  if (state.error && !state.deals) {
    container.replaceChildren(h("div", { class: "card-body" }, errorBlock("Couldn't load invoices", state.error, () => loadDeals())));
    return;
  }
  if (!state.deals) {
    container.replaceChildren(tableShell(Array.from({ length: 4 }, () => h("tr", {},
      ...[40, 18, 22, 20, 14, 0].map((w) => h("td", {}, w ? h("span", { class: "sk sk-line", style: `width:${w * 2}%` }) : null))))));
    return;
  }
  const rows = invoiceRows().slice(0, limit);
  if (!rows.length) {
    container.replaceChildren(h("div", { class: "empty" }, svg(ICON.doc),
      h("h3", { text: "No invoices yet" }),
      h("p", { text: "Describe your first client deal. The AI drafts a payment plan, and nothing is sent until you approve it." }),
      h("a", { class: "btn btn-primary", href: "#new" }, svg(ICON.plus), "New deal")));
    return;
  }
  const body = rows.map((r) => h("tr", {},
    h("td", { class: "cell-client" }, h("span", { class: "cell-main", text: r.deal.client_name }), h("span", { class: "cell-sub", text: r.deal.client_email, title: r.deal.client_email })),
    h("td", { class: "money" }, h("span", { class: "cell-main", text: money(r.amount) }), h("span", { class: "cell-sub", text: `of ${money(r.deal.total)}` })),
    h("td", {}, h("span", { text: `${r.inst.n} of ${r.deal.instalments.length}` }), h("span", { class: "cell-sub", text: r.inst.label })),
    h("td", { class: "tabular nowrap", text: fmtDate(r.due) }),
    h("td", {}, pill(r.badge)),
    h("td", { class: "actions" }, h("button", {
      class: "icon-btn", "aria-label": `Actions for ${r.deal.client_name}, instalment ${r.inst.n}`, "aria-haspopup": "menu",
      onclick: (e) => openMenu(e.currentTarget, r),
    }, svg(ICON.dots)))));
  if (state.loading) body.forEach((tr) => tr.setAttribute("aria-busy", "true"));
  container.replaceChildren(tableShell(body));
}

function tableShell(bodyRows) {
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: "Client" }), h("th", { scope: "col", class: "money", text: "Amount" }),
      h("th", { scope: "col", text: "Instalment" }), h("th", { scope: "col", text: "Due date" }),
      h("th", { scope: "col", text: "Status" }), h("th", { scope: "col" }, h("span", { class: "sr-only", text: "" })))),
    h("tbody", {}, bodyRows)));
}

function errorBlock(title, err, retry) {
  return h("div", { class: "alert alert-error", role: "alert" }, h("strong", { text: title }), err.message,
    retry ? h("div", { style: "margin-top:8px" }, h("button", { class: "btn btn-secondary btn-sm", onclick: retry, text: "Try again" })) : null);
}

// ---------- Row action menu ----------
let menuFor = null;
function openMenu(btn, r) {
  const menu = $("row-menu");
  if (menuFor === btn) return closeMenu();
  const unpaid = r.isCurrent && ["Sent", "Overdue"].includes(r.badge);
  const item = (label, note, enabled, fn) => h("button", { role: "menuitem", disabled: !enabled, onclick: () => { closeMenu(); fn(); } },
    h("span", {}, label, note ? h("span", { class: "menu-note", text: note }) : null));
  const items = [
    item("Send this instalment", r.isNext ? `Creates and sends a ${money(r.amount)} invoice` : r.inst.sent_at ? "Already sent" : `Send instalment ${r.deal.next_instalment} first`, r.isNext, () => confirmInstalment(r)),
    item("Get reminder advice", unpaid ? null : r.badge === "Paid" ? "Already paid" : "Only for the latest unpaid invoice", unpaid, () => openReminder(r)),
    h("hr"),
    item("Simulate payment", unpaid ? "Demo only, no money moves" : "Only for the latest unpaid invoice", unpaid, () => simulatePayment(r)),
  ];
  if (r.inst.client_view_url) items.push(item("Open client view", "Opens PayPal sandbox", true, () => window.open(r.inst.client_view_url, "_blank", "noopener")));
  menu.replaceChildren(...items);
  menu.hidden = false;
  const rect = btn.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(rect.right - mw, innerWidth - mw - 8))}px`;
  menu.style.top = `${rect.bottom + mh + 8 > innerHeight ? Math.max(8, rect.top - mh - 4) : rect.bottom + 4}px`;
  menuFor = btn;
  btn.setAttribute("aria-expanded", "true");
  menu.querySelector("button:not(:disabled)")?.focus();
}
function closeMenu() {
  $("row-menu").hidden = true;
  if (menuFor) { menuFor.setAttribute("aria-expanded", "false"); menuFor = null; }
}
document.addEventListener("click", (e) => { if (menuFor && !e.target.closest("#row-menu") && !menuFor.contains(e.target)) closeMenu(); });
window.addEventListener("scroll", closeMenu, true);
window.addEventListener("resize", closeMenu);

// ---------- New deal ----------
$("parse-btn").addEventListener("click", async () => {
  const text = $("deal-text").value.trim();
  showAlert($("parse-error"), null);
  if (!text) return showAlert($("parse-error"), new Error("Describe the deal first: who the client is, their email, the amount and when it's due."));
  const btn = $("parse-btn");
  setBusy(btn, true);
  state.plan = "loading";
  renderReview();
  try {
    const { plan, ai } = await api("/api/deals/parse", { text });
    state.plan = plan; state.planAi = ai;
    initDraft(plan);
    logEvent({ type: "parsed", client: plan.client_name || "Unknown client", provider: ai.sample_data ? "sample data" : ai.provider, missing: plan.missing_fields.length });
  } catch (err) {
    state.plan = null;
    showAlert($("parse-error"), err, "Couldn't propose a plan");
  } finally {
    setBusy(btn, false);
    renderReview();
  }
});

const MISSING_LABELS = { client_name: "client name", client_email: "client email", total: "total amount", instalments: "a payment schedule that adds up to 100%", currency_usd_only: "amounts in USD (only USD is supported)" };
const addDays = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

function splitAmounts(total, instalments) {
  const cents = Math.round(total * 100);
  let used = 0;
  return instalments.map((inst, i) => {
    const c = i === instalments.length - 1 ? cents - used : Math.round((cents * inst.percent) / 100);
    used += c;
    return c / 100;
  });
}

// ---- Editable draft of the AI plan ----
// The AI plan is the starting point. You can change each instalment's label,
// amount, due date and the note printed on its PayPal invoice before approving.
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86400000);
const defaultNote = (i, n, client) => `Instalment ${i + 1} of ${n}${client ? ` for ${client}` : ""}.`;

function initDraft(plan) {
  const amounts = plan.total ? splitAmounts(plan.total, plan.instalments) : plan.instalments.map(() => null);
  state.draft = {
    editing: null,
    error: null,
    rows: plan.instalments.map((inst, i) => ({
      label: inst.label,
      amount: amounts[i],
      due: addDays(inst.due_in_days),
      note: defaultNote(i, plan.instalments.length, plan.client_name),
      edited: false,
      noteEdited: false,
    })),
  };
}

function draftTotals() {
  const rows = state.draft.rows;
  const allAmounts = rows.length > 0 && rows.every((r) => typeof r.amount === "number" && r.amount > 0);
  const total = allAmounts ? Math.round(rows.reduce((s, r) => s + r.amount * 100, 0)) / 100 : null;
  const missing = new Set(state.plan.missing_fields || []);
  if (allAmounts) { missing.delete("total"); missing.delete("instalments"); }
  if (total !== null && total > 100000) missing.add("total_over_limit");
  return { total, missing };
}

// The plan object the server receives. Percents are derived from your amounts,
// so the server's split reproduces exactly the amounts shown here.
function draftToPlan() {
  const { total } = draftTotals();
  const n = state.draft.rows.length;
  return {
    client_name: state.plan.client_name,
    client_email: state.plan.client_email,
    total,
    currency: "USD",
    instalments: state.draft.rows.map((r) => ({
      label: r.label,
      percent: (r.amount / total) * 100,
      due_in_days: daysFromToday(r.due),
      note: r.noteEdited ? r.note : undefined,
    })),
    missing_fields: [],
    _n: n,
  };
}

const MISSING_LABELS_EXTRA = { total_over_limit: "a total of $100,000 or less" };

function renderReview() {
  const body = $("review-body");
  aiVia($("plan-ai"), state.plan && state.plan !== "loading" ? state.planAi : null);
  if (state.plan === "loading") {
    body.replaceChildren(h("div", { "aria-busy": "true", "aria-label": "Proposing a plan" },
      h("span", { class: "sk sk-line" }), h("span", { class: "sk sk-line short" }), h("span", { class: "sk sk-block" }), h("span", { class: "sk sk-line short" })));
    return;
  }
  if (!state.plan) {
    body.replaceChildren(h("div", { class: "empty" }, svg(ICON.spark),
      h("h3", { text: "No plan yet" }),
      h("p", { text: "Describe a deal and choose Propose a plan. You'll review every amount, date and recipient here before anything is sent." })));
    return;
  }
  const plan = state.plan;
  const d = state.draft;
  const n = d.rows.length;
  const { total, missing } = draftTotals();
  const rcpt = recipientFor(plan.client_email);
  const anyEdited = d.rows.some((r) => r.edited);
  const fact = (label, value, key, small, full) => h("div", { class: full ? "full" : null },
    h("dt", { text: label }),
    h("dd", { class: value == null || missing.has(key) ? "missing" : null }, value ?? "Missing", small ? h("small", { text: small }) : null));

  const rowsEls = [];
  d.rows.forEach((r, i) => {
    const pct = total && r.amount ? `${Math.round((r.amount / total) * 1000) / 10}%` : "";
    const days = daysFromToday(r.due);
    rowsEls.push(h("tr", { class: d.editing === i ? "is-editing" : null },
      h("td", { class: "tabular", text: i + 1 }),
      h("td", {}, r.label, r.edited ? h("span", { class: "tag-edited", text: "Edited by you" }) : null, h("span", { class: "cell-sub", text: pct })),
      h("td", { class: "tabular" }, fmtDate(r.due), h("span", { class: "cell-sub", text: days <= 0 ? "On approval" : `In ${days} days` })),
      h("td", { class: "money", text: r.amount ? money(r.amount) : "–" }),
      h("td", { class: "actions" }, h("button", {
        class: "btn btn-ghost btn-sm", disabled: d.editing !== null && d.editing !== i,
        "aria-expanded": d.editing === i ? "true" : "false",
        "aria-label": `Edit instalment ${i + 1}`,
        text: "Edit",
        onclick: () => { d.editing = d.editing === i ? null : i; d.error = null; d.pending = null; renderReview(); focusEditor(); },
      }))));
    if (d.editing === i) rowsEls.push(editorRow(i));
  });

  const nodes = [
    h("div", { class: "ai-line" }, svg(ICON.spark), anyEdited ? "AI proposed this plan and you edited it. Nothing is sent until you approve." : "AI proposed this plan. Nothing is sent until you approve."),
    state.planAi?.sample_data ? h("div", { class: "sample-note", text: "Sample data (AI_MODE=mock). This plan was not written by an AI model." }) : null,
    h("dl", { class: "facts" },
      fact("Client", plan.client_name, "client_name"),
      fact("Total", total ? money(total) : null, "total", plan.total && total && total !== plan.total ? `AI proposed ${money(plan.total)}` : "USD"),
      fact("Client email", plan.client_email, "client_email", null, true),
      plan.client_email ? fact("Invoices go to", rcpt.email, null, rcpt.note, true) : null),
    h("table", { class: "schedule" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", text: "#" }), h("th", { scope: "col", text: "Instalment" }), h("th", { scope: "col", text: "Due" }),
        h("th", { scope: "col", class: "money", text: "Amount" }), h("th", { scope: "col" }, h("span", { class: "sr-only", text: "Edit" })))),
      h("tbody", {}, rowsEls),
      total ? h("tfoot", {}, h("tr", {}, h("td", { colspan: "3", text: "Total" }), h("td", { class: "money", text: money(total) }), h("td", {}))) : null),
    clientPreview(rcpt.email, total),
  ];
  if (missing.size) {
    nodes.push(h("div", { class: "alert alert-warn", role: "status" },
      h("strong", { text: "Needs more detail before you can approve" }),
      `Missing or unclear: ${[...missing].map((k) => MISSING_LABELS[k] || MISSING_LABELS_EXTRA[k] || k).join(", ")}.`,
      missing.has("client_name") || missing.has("client_email") || missing.has("currency_usd_only") ? " Add it to the description and propose again." : " Edit the instalment amounts above."));
  }
  const approveBlocked = missing.size > 0 || d.editing !== null;
  nodes.push(h("div", { class: "review-actions" },
    d.editing !== null ? h("span", { class: "muted", text: "Save or cancel your edit to continue." }) : null,
    h("button", { class: "btn btn-ghost", text: "Discard", onclick: () => { state.plan = null; state.draft = null; renderReview(); } }),
    h("button", { class: "btn btn-primary", disabled: approveBlocked, text: "Approve and send instalment 1", onclick: () => confirmPlan(rcpt.email) })));
  body.replaceChildren(...nodes.filter(Boolean));
}

function focusEditor() { setTimeout(() => $("edit-label")?.focus(), 0); }

function editorRow(i) {
  const d = state.draft;
  const r = d.rows[i];
  const n = d.rows.length;
  const field = (id, label, input, hint) => h("div", { class: "edit-field" }, h("label", { for: id, class: "field-label", text: label }), input, hint ? h("p", { class: "hint", text: hint }) : null);
  // After a failed save, show what you typed rather than the saved values.
  const v = d.pending || { label: r.label, amount: r.amount ?? "", due: r.due, note: r.note };
  const labelIn = h("input", { id: "edit-label", type: "text", maxlength: "120", value: v.label });
  const amountIn = h("input", { id: "edit-amount", type: "number", min: "0.01", max: "100000", step: "0.01", inputmode: "decimal", value: v.amount });
  const dueIn = h("input", { id: "edit-due", type: "date", min: todayISO(), max: addDays(365), value: v.due });
  const noteIn = h("textarea", { id: "edit-note", rows: "3", maxlength: "4000" });
  noteIn.value = v.note;
  const err = h("div", { class: "alert alert-error", role: "alert", hidden: !d.error, text: d.error || "" });

  const save = () => {
    const label = labelIn.value.trim();
    const amount = Math.round(Number(amountIn.value) * 100) / 100;
    const due = dueIn.value;
    const note = noteIn.value.trim();
    const days = due ? daysFromToday(due) : NaN;
    const problem = !label ? "Give the instalment a name."
      : !(amount > 0) ? "Enter an amount above $0.00."
      : amount > 100000 ? "The amount can't be more than $100,000."
      : !due || !Number.isInteger(days) || days < 0 || days > 365 ? "Pick a due date between today and one year from today."
      : !note ? "The note can't be empty. It's printed on the invoice."
      : null;
    if (problem) {
      d.error = problem;
      d.pending = { label: labelIn.value, amount: amountIn.value, due: dueIn.value, note: noteIn.value };
      renderReview(); focusEditor(); return;
    }
    d.pending = null;
    const changed = label !== r.label || amount !== r.amount || due !== r.due || note !== r.note;
    if (note !== r.note) r.noteEdited = note !== defaultNote(i, n, state.plan.client_name);
    Object.assign(r, { label, amount, due, note, edited: r.edited || changed });
    d.editing = null; d.error = null;
    renderReview();
  };
  const cancel = () => { d.editing = null; d.error = null; d.pending = null; renderReview(); };

  return h("tr", { class: "edit-row" }, h("td", { colspan: "5" },
    h("div", { class: "edit-grid", onkeydown: (e) => { if (e.key === "Escape") { e.stopPropagation(); cancel(); } } },
      field("edit-label", "Name on invoice", labelIn),
      field("edit-amount", "Amount (USD)", amountIn, "Changes the plan total."),
      field("edit-due", "Due date", dueIn),
      h("div", { class: "edit-field full" },
        h("label", { for: "edit-note", class: "field-label", text: "Note to client on the invoice" }), noteIn,
        h("p", { class: "hint", text: "Printed on the PayPal invoice. PayPal writes the email around it." })),
      h("div", { class: "edit-actions full" }, err,
        h("button", { class: "btn btn-ghost btn-sm", text: "Cancel", onclick: cancel }),
        h("button", { class: "btn btn-primary btn-sm", text: "Save changes", onclick: save })))));
}

// "What your client receives" for the invoice that goes out on approval.
function clientPreview(recipient, total) {
  const d = state.draft;
  const r = d.rows[0];
  const n = d.rows.length;
  if (!r) return null;
  return h("section", { class: "preview", "aria-label": "What your client receives" },
    h("h3", { class: "label-sm", text: "What your client receives now" }),
    h("p", { class: "preview-lead" }, "PayPal emails ", h("strong", { text: recipient || "the client" }), " an invoice from Test Freelancer:"),
    h("dl", { class: "confirm-details" },
      h("dt", { text: "Item" }), h("dd", { text: `${r.label} (1 of ${n})` }),
      h("dt", { text: "Amount" }), h("dd", { text: r.amount ? money(r.amount) : "–" }),
      h("dt", { text: "Due" }), h("dd", { text: fmtDate(r.due) })),
    h("blockquote", { class: "preview-note", text: r.note }),
    n > 1 ? h("p", { class: "hint", text: `${n === 2 ? "Instalment 2 is" : `Instalments 2 to ${n} are`} not sent now. ${n === 2 ? "It is" : "Each is"} sent later, with its own note, when you choose Send this instalment on the Invoices page.` }) : null);
}

function confirmPlan(recipient) {
  const plan = draftToPlan();
  delete plan._n;
  const first = state.draft.rows[0];
  const n = state.draft.rows.length;
  const edited = state.draft.rows.some((r) => r.edited);
  confirmSend({
    text: [`You're about to send `, h("strong", { text: money(first.amount) }), " to ", h("span", { class: "email", text: recipient }), "."],
    details: [["Client", plan.client_name], ["Invoice", `1 of ${n} · ${first.label}`], ["Due", fmtDate(first.due)], ["Note", first.note], ["Plan total", money(plan.total)]],
    run: async () => {
      const r = await api("/api/deals/approve", { plan, approved: true });
      if (edited) logEvent({ type: "edited", client: plan.client_name, rows: state.draft.rows.filter((x) => x.edited).length });
      state.plan = null; state.draft = null;
      $("deal-text").value = "";
      toast(`Invoice 1 sent to ${recipient}. PayPal status: ${r.status}.`, { link: r.client_view_url });
      location.hash = "#dashboard";
      loadDeals();
    },
  });
}

function confirmInstalment(r) {
  confirmSend({
    text: [`You're about to send `, h("strong", { text: money(r.amount) }), " to ", h("span", { class: "email", text: r.deal.sent_to_email }), "."],
    details: [["Client", r.deal.client_name], ["Invoice", `${r.inst.n} of ${r.deal.instalments.length} · ${r.inst.label}`], ["Due", fmtDate(r.due)], ...(r.inst.note ? [["Note", r.inst.note]] : [])],
    run: async () => {
      const res = await api(`/api/deals/${encodeURIComponent(r.deal.id)}/instalments/${r.inst.n}/send`, { approved: true });
      toast(`Invoice ${res.instalment} sent to ${r.deal.sent_to_email}. PayPal status: ${res.status}.`, { link: res.client_view_url });
      loadDeals();
    },
  });
}

// ---------- Confirm modal (the approval gate in the UI) ----------
let confirmRun = null;
function confirmSend({ text, details, run }) {
  $("confirm-text").replaceChildren(...text);
  $("confirm-details").replaceChildren(...details.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]));
  showAlert($("confirm-error"), null);
  confirmRun = run;
  openModal("confirm-modal", $("confirm-cancel"));
}
$("confirm-ok").addEventListener("click", async () => {
  if (!confirmRun) return;
  const btn = $("confirm-ok");
  setBusy(btn, true);
  $("confirm-cancel").disabled = true;
  showAlert($("confirm-error"), null);
  try {
    await confirmRun();
    confirmRun = null;
    closeModal("confirm-modal");
  } catch (err) {
    showAlert($("confirm-error"), err, "Nothing was sent");
  } finally {
    setBusy(btn, false);
    $("confirm-cancel").disabled = false;
  }
});
$("confirm-cancel").addEventListener("click", () => closeModal("confirm-modal"));

// ---------- Reminder decision card ----------
let reminderRow = null;
function openReminder(r) {
  reminderRow = r;
  $("reminder-for").textContent = `${r.deal.client_name} · ${money(r.amount)} · invoice ${r.inst.n} of ${r.deal.instalments.length} · ${r.deal.reminders_sent} reminder${r.deal.reminders_sent === 1 ? "" : "s"} sent so far`;
  $("decision").hidden = true;
  $("decision-actions").hidden = true;
  $("advice-loading").hidden = true;
  showAlert($("advice-error"), null);
  openModal("reminder-modal", $("days-overdue"));
}

$("advice-btn").addEventListener("click", async () => {
  const days = Number($("days-overdue").value);
  showAlert($("advice-error"), null);
  if (!Number.isInteger(days) || days < 0 || days > 365) return showAlert($("advice-error"), new Error("Enter a whole number of days from 0 to 365."));
  const btn = $("advice-btn");
  setBusy(btn, true);
  $("advice-loading").hidden = false;
  $("decision").hidden = true;
  $("decision-actions").hidden = true;
  try {
    const { decision, ai } = await api(`/api/deals/${encodeURIComponent(reminderRow.deal.id)}/reminder-strategy`, { days_overdue: days });
    const tone = $("decision-tone");
    tone.textContent = decision.tone.replace("_", " ");
    tone.className = `tone-chip tone-${decision.tone}`;
    aiVia($("decision-ai"), ai);
    $("decision-sample").hidden = !ai.sample_data;
    $("decision-reasoning").textContent = decision.reasoning;
    $("decision-message").value = decision.message;
    $("decision-next").textContent = `Next: ${decision.next_action}`;
    updateCount();
    $("decision").hidden = false;
    $("decision-actions").hidden = false;
  } catch (err) {
    showAlert($("advice-error"), err, "Couldn't get advice");
  } finally {
    setBusy(btn, false);
    $("advice-loading").hidden = true;
  }
});
const updateCount = () => { $("message-count").textContent = `${$("decision-message").value.length} / 4000`; };
$("decision-message").addEventListener("input", updateCount);

$("reminder-send-btn").addEventListener("click", () => {
  const message = $("decision-message").value.trim();
  if (!message) return showAlert($("advice-error"), new Error("The message is empty. Write a short note to the client."));
  const r = reminderRow;
  const toneText = $("decision-tone").textContent;
  const tone = toneText.charAt(0).toUpperCase() + toneText.slice(1);
  confirmSend({
    text: [`You're about to send a reminder for `, h("strong", { text: money(r.amount) }), " to ", h("span", { class: "email", text: r.deal.sent_to_email }), "."],
    details: [["Client", r.deal.client_name], ["Invoice", `${r.inst.n} of ${r.deal.instalments.length} · ${r.inst.invoice_id}`], ["Tone", tone]],
    run: async () => {
      await api(`/api/deals/${encodeURIComponent(r.deal.id)}/remind`, { message, approved: true });
      logEvent({ type: "reminder", dealId: r.deal.id, client: r.deal.client_name, invoiceId: r.inst.invoice_id, n: r.inst.n, tone });
      closeModal("reminder-modal");
      toast(`Reminder sent to ${r.deal.sent_to_email}.`);
      loadDeals();
    },
  });
});

// ---------- Simulate payment (demo only, not a send) ----------
async function simulatePayment(r) {
  try {
    const res = await api(`/api/deals/${encodeURIComponent(r.deal.id)}/simulate-payment`, {});
    logEvent({ type: "paid", dealId: r.deal.id, client: r.deal.client_name, invoiceId: r.inst.invoice_id, n: r.inst.n, amount: res.amount_recorded, demo: true });
    toast(`Demo only: recorded ${res.amount_recorded} on invoice ${r.inst.n}. PayPal status: ${res.status}.`);
    loadDeals();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- Activity timeline ----------
function renderActivity() {
  const box = $("activity");
  if (state.error && !state.deals) return box.replaceChildren(errorBlock("Couldn't load activity", state.error, () => loadDeals()));
  if (!state.deals) {
    return box.replaceChildren(h("ul", { class: "timeline", "aria-busy": "true" }, Array.from({ length: 4 }, () => h("li", {},
      h("span", { class: "sk", style: "width:32px;height:32px;border-radius:50%" }),
      h("div", {}, h("span", { class: "sk sk-line" }), h("span", { class: "sk sk-line short" })), h("span", {})))));
  }

  const log = readLog();
  const dated = [];
  const undated = [];
  for (const e of log.filter((x) => x.type === "parsed")) {
    dated.push({ kind: "parsed", icon: ICON.spark, at: e.at, local: true, title: `AI proposed a plan for ${e.client}`, detail: `via ${e.provider}${e.missing ? ` · ${e.missing} field(s) missing` : ""}` });
  }
  for (const e of log.filter((x) => x.type === "edited")) {
    dated.push({ kind: "parsed", icon: ICON.doc, at: e.at, local: true, title: `You edited the plan for ${e.client} before approving`, detail: `${e.rows} instalment${e.rows === 1 ? "" : "s"} changed` });
  }
  for (const d of state.deals) {
    dated.push({ kind: "approved", icon: ICON.check, at: d.created_at, title: `Approved by you: ${d.client_name}`, detail: `${money(d.total)} in ${d.instalments.length} instalment${d.instalments.length === 1 ? "" : "s"}` });
    for (const inst of d.instalments) {
      if (inst.sent_at) dated.push({ kind: "sent", icon: ICON.send, at: inst.sent_at, title: `Invoice ${inst.n} of ${d.instalments.length} sent to ${d.sent_to_email}`, detail: `${d.client_name} · ${money(inst.amount)} · ${inst.invoice_id}` });
      if (inst.badge === "Paid") {
        const paidLog = log.find((x) => x.type === "paid" && x.invoiceId === inst.invoice_id);
        const ev = { kind: "paid", icon: ICON.coin, title: `Invoice ${inst.n} of ${d.instalments.length} paid`, detail: `${d.client_name} · ${money(inst.amount)}${paidLog?.demo ? " · simulated (demo)" : ""}` };
        if (paidLog) dated.push({ ...ev, at: paidLog.at, local: true }); else undated.push({ ...ev, detail: `${ev.detail} · status from PayPal` });
      }
    }
    const reminders = log.filter((x) => x.type === "reminder" && x.dealId === d.id);
    for (const e of reminders) dated.push({ kind: "reminder", icon: ICON.bell, at: e.at, local: true, title: `Reminder sent for invoice ${e.n}`, detail: `${d.client_name} · tone ${e.tone}` });
    const unseen = d.reminders_sent - reminders.length;
    if (unseen > 0) undated.push({ kind: "reminder", icon: ICON.bell, title: `${unseen} reminder${unseen === 1 ? "" : "s"} sent`, detail: `${d.client_name} · sent outside this browser` });
  }
  dated.sort((a, b) => b.at.localeCompare(a.at));

  if (!dated.length && !undated.length) {
    return box.replaceChildren(h("div", { class: "empty" }, svg(ICON.clock), h("h3", { text: "No activity yet" }),
      h("p", { text: "Every plan, approval, invoice, payment and reminder will be listed here with its time." }),
      h("a", { class: "btn btn-primary", href: "#new" }, svg(ICON.plus), "New deal")));
  }
  const item = (e) => h("li", {},
    h("span", { class: `tl-icon ${e.kind}` }, svg(e.icon)),
    h("div", { class: "tl-text" }, h("div", { class: "tl-title", text: e.title }), h("div", { class: "tl-detail", text: e.detail })),
    h("div", { class: "tl-time" }, e.at ? fmtTime(e.at) : "Time not recorded", e.local ? h("span", { class: "tl-source", title: "Recorded by this browser when it happened", text: "this browser" }) : null));
  box.replaceChildren(...[
    h("p", { class: "muted activity-note", text: "Approvals and send times come from the server. Plan proposals, reminder times and simulated payments are recorded by this browser." }),
    dated.length ? h("ul", { class: "timeline" }, dated.map(item)) : null,
    undated.length ? h("h3", { class: "tl-group", text: "Without a recorded time" }) : null,
    undated.length ? h("ul", { class: "timeline" }, undated.map(item)) : null,
  ].filter(Boolean));
}

// ---------- Modals ----------
const lastFocus = {};
function openModal(id, focusEl) {
  lastFocus[id] = document.activeElement;
  $(id).hidden = false;
  (focusEl || $(id).querySelector("button, input, textarea"))?.focus();
}
function closeModal(id) {
  $(id).hidden = true;
  if (id === "confirm-modal") confirmRun = null;
  lastFocus[id]?.focus?.();
}
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => {
    if (e.target === m && !m.querySelector(".is-loading")) closeModal(m.id);
    if (e.target.closest("[data-close]")) closeModal(m.id);
  });
  // Keep Tab focus inside the open dialog.
  m.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = [...m.querySelectorAll("button, input, textarea, a[href]")].filter((x) => !x.disabled && x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("row-menu").hidden) return closeMenu();
  const top = ["confirm-modal", "reminder-modal"].find((id) => !$(id).hidden);
  if (top && !$(top).querySelector(".is-loading")) closeModal(top);
});

// ---------- Start ----------
api("/api/config").then((c) => { state.config = c; }).catch(() => {}).finally(() => { renderAiBadge(); renderReview(); });
route();
loadDeals();
