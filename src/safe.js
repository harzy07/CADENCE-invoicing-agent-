// Shared error type and secret redaction. Every error message that leaves the
// server, or is logged, goes through redact() first.

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const runtimeSecrets = new Set(); // e.g. the current PayPal access token

function addRuntimeSecret(value) {
  if (value) runtimeSecrets.add(value);
}

function knownSecrets() {
  return [process.env.PAYPAL_CLIENT_SECRET, process.env.AI_API_KEY, process.env.AI2_API_KEY, ...runtimeSecrets]
    .filter((s) => typeof s === "string" && s.length >= 8);
}

function redact(value) {
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return s;
  for (const secret of knownSecrets()) s = s.split(secret).join("[redacted]");
  return s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]")
    .replace(/\b(sk|gsk)[-_][A-Za-z0-9_*-]{6,}/g, "[redacted]") // OpenAI/OpenRouter/Groq-style keys, incl. masked ones
    .replace(/\bA21AA[A-Za-z0-9_-]{20,}/g, "[redacted]"); // PayPal access tokens
}

module.exports = { AppError, addRuntimeSecret, redact };
