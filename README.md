# AI Invoice Agent for Freelancers

Describe a client deal in plain words. The agent turns it into a payment plan, and after you approve it, creates and sends PayPal invoices for each instalment. When an invoice is unpaid, it suggests a reminder with a tone and a reason, and you edit and approve the message before it goes out.

PayPal **sandbox only**, **USD only**. Nothing is sent to a client without an explicit Approve click.

## Setup

1. Install Node.js 20.6 or later.
2. In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/), open your **sandbox** app and turn on **Invoicing** under Features.
   - If you just turned it on, PayPal may keep returning an older token without invoicing permission for a few hours.
   - The sandbox business account must be able to invoice the buyer account. India-based accounts cannot invoice recipients in India.
3. Install dependencies:
   ```
   npm install
   ```
4. Copy the example config and fill in your values:
   ```
   cp .env.example .env
   ```
   | Variable | Purpose |
   |---|---|
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials |
   | `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` (other hosts are refused) |
   | `CLIENT_EMAIL` | Sandbox buyer email. If set, all invoices go to this address instead of the parsed client email |
   | `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Primary AI provider. Any OpenAI-compatible Chat Completions API, called at `${AI_BASE_URL}/chat/completions` |
   | `AI2_BASE_URL`, `AI2_API_KEY`, `AI2_MODEL` | Optional fallback provider, tried once when the primary returns 429, a 5xx or times out (30 s) |
   | `AI_PROVIDER`, `AI2_PROVIDER` | Optional display names for the "AI via ..." label |
   | `AI_MODE` | Set to `mock` to get labelled sample data with no provider call (local development only; refused when `NODE_ENV=production`) |

   Suggested models: Groq `openai/gpt-oss-120b`, OpenRouter `anthropic/claude-haiku-5.5`. If `*_MODEL` is empty or holds a provider name such as `groq`, the app uses these defaults for those two hosts.
   | `PORT` | Defaults to 3000 |

   `.env` is git-ignored. Never commit it.

## Run

```
npm start
```

Open http://localhost:3000. The server listens on localhost only.

## Using it

1. **New deal**: describe the deal (client, email, amount, schedule) and click **Parse**. Missing email or amount is flagged, never guessed. Click **Approve** to create and send instalment 1.
2. **Deals**: live status from PayPal (Draft, Sent, Paid, Overdue).
   - **Send next instalment** asks for approval, then creates and sends the next invoice.
   - **Get reminder advice** opens the decision card. Enter **days overdue** (sandbox invoices never become overdue by themselves), get a tone, reasoning and message, edit it, click **Approve**, then **Send**.
   - **Simulate payment** records an external payment on the latest invoice. Demo only, no money moves.

## API

| Method | Path | Body |
|---|---|---|
| POST | `/api/deals/parse` | `{text}` |
| POST | `/api/deals/approve` | `{plan, approved: true}` |
| GET | `/api/deals` | |
| POST | `/api/deals/:id/instalments/:n/send` | `{approved: true}` |
| POST | `/api/deals/:id/reminder-strategy` | `{days_overdue}` |
| POST | `/api/deals/:id/remind` | `{message, approved: true}` |
| POST | `/api/deals/:id/simulate-payment` | |

Errors are JSON: `{"error": {"code", "message", "details"}}`.

## Notes

- Deals are stored in `data/deals.json` (git-ignored). Only the plan and PayPal invoice IDs are stored; status always comes from PayPal.
- PayPal's API docs say the reminder endpoint may replace a custom note with PayPal's default text, and limit reminders to 2 per invoice per day.
- `scripts/phase1-test.js` is the original smoke test: `node --env-file=.env scripts/phase1-test.js`.
