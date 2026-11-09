const BASE = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, CLIENT_EMAIL } = process.env;

async function call(path, options = {}) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    console.error("FAILED", res.status, path);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

async function main() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const tok = await call("/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  console.log("1. Token OK, expires in", tok.expires_in, "seconds");

  const auth = { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" };

  const draft = await call("/v2/invoicing/invoices", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      detail: { currency_code: "USD", note: "Phase 1 test" },
      invoicer: { name: { given_name: "Test", surname: "Freelancer" } },
      primary_recipients: [{ billing_info: { email_address: CLIENT_EMAIL } }],
      items: [{ name: "Website design (test)", quantity: "1",
                unit_amount: { currency_code: "USD", value: "100.00" } }],
    }),
  });
  const id = draft.id || draft.href.split("/").pop();
  console.log("2. Draft created, invoice id:", id);

  await call(`/v2/invoicing/invoices/${id}/send`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ send_to_recipient: true, send_to_invoicer: true }),
  });
  console.log("3. Sent OK");

  const inv = await call(`/v2/invoicing/invoices/${id}`, { headers: auth });
  console.log("4. Status:", inv.status);
  console.log("   Client view link (if present):", inv.detail?.metadata?.recipient_view_url);
}

main();
