// callLLM(systemPrompt, userPrompt, options?) over any OpenAI-compatible
// Chat Completions endpoint: POST ${AI_BASE_URL}/chat/completions.
//
// - Primary provider: AI_BASE_URL, AI_API_KEY, AI_MODEL (AI_PROVIDER = optional display name).
// - Fallback provider: AI2_BASE_URL, AI2_API_KEY, AI2_MODEL (AI2_PROVIDER optional).
//   Used once, only when the primary returns HTTP 429, a 5xx, or times out.
// - Requests JSON output (response_format json_object); the caller puts the exact
//   JSON shape in the prompt and passes options.validate to check the result.
//   Malformed JSON is retried once on the same provider.
// - AI_MODE=mock returns options.mock() as labelled sample data (local development only).
//
// Never logs keys or prompts. Logs provider, model, HTTP status and timing only.
const { AppError, redact } = require("./safe");

const TIMEOUT_MS = 45_000; // per provider request
// Output cap. On reasoning models this covers thinking + answer, so it sits well
// above the ~300-token JSON answers. It is a ceiling, not what gets billed.
const MAX_OUTPUT_TOKENS = 2000;

// Models picked from each provider's current docs (Nov 2026). Used when the
// *_MODEL variable is empty or holds a provider name instead of a model ID.
const KNOWN_HOSTS = {
  "api.groq.com": { name: "Groq", defaultModel: "openai/gpt-oss-120b" },
  "generativelanguage.googleapis.com": { name: "Gemini", defaultModel: "gemini-3.8-flash" },
  "openrouter.ai": { name: "OpenRouter", defaultModel: "anthropic/claude-haiku-5.5" },
};

// Request body per provider, sending only parameters that provider's docs list
// for the model in use.
function buildBody(p, systemPrompt, userPrompt) {
  const body = {
    model: p.model,
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    response_format: { type: "json_object" },
  };
  const m = p.model.toLowerCase();

  if (p.host === "api.groq.com") {
    // Groq API reference: max_tokens is deprecated in favour of max_completion_tokens.
    body.max_completion_tokens = MAX_OUTPUT_TOKENS;
    body.temperature = 0.2;
    if (/^openai\/gpt-oss-(20b|120b)$/.test(m)) {
      body.reasoning_effort = "low"; // gpt-oss accepts low|medium|high only
      body.include_reasoning = false; // reasoning_format is not supported on gpt-oss
    } else if (m === "qwen/qwen3.8-27b") {
      body.reasoning_effort = "none"; // qwen3.8-27b accepts none|default|low|medium|high
    }
    return body;
  }

  if (p.host === "generativelanguage.googleapis.com") {
    // Gemini OpenAI compatibility: max_tokens caps thinking + visible output combined.
    body.max_tokens = MAX_OUTPUT_TOKENS;
    if (/^gemini-3/.test(m)) {
      // Gemini 3.x: thinking levels low|medium|high (3.8 Flash rejects "minimal").
      // Temperature is left at the model default, as Google recommends for Gemini 3.
      body.reasoning_effort = "low";
    } else {
      body.temperature = 0.2; // older models: no reasoning_effort sent
    }
    return body;
  }

  // Any other OpenAI-compatible host: only the widely supported basics.
  body.max_tokens = MAX_OUTPUT_TOKENS;
  body.temperature = 0.2;
  return body;
}
const PROVIDER_WORDS = new Set(["groq", "openrouter", "openai", "anthropic", "gemini", "google"]);

function readProvider(prefix) {
  const env = (k) => (process.env[`${prefix}_${k}`] || "").trim();
  const baseUrl = env("BASE_URL").replace(/\/+$/, "");
  const apiKey = env("API_KEY");
  if (!baseUrl && !apiKey) return null;

  let host = null;
  try { host = new URL(baseUrl).host; } catch { /* reported below */ }
  const known = KNOWN_HOSTS[host] || {};
  const rawModel = env("MODEL");
  const modelIsProviderName = PROVIDER_WORDS.has(rawModel.toLowerCase());
  return {
    prefix,
    name: env("PROVIDER") || known.name || host || prefix,
    baseUrl,
    host,
    apiKey,
    model: rawModel && !modelIsProviderName ? rawModel : known.defaultModel || "",
    modelDefaulted: !rawModel || modelIsProviderName,
  };
}

function providers() {
  return [readProvider("AI"), readProvider("AI2")].filter(Boolean);
}

function isMock() {
  return (process.env.AI_MODE || "").trim().toLowerCase() === "mock";
}

// Safe summary for /api/config and startup logs. No keys, no URLs beyond the host.
function describeConfig() {
  if (isMock()) return { mode: "mock", sample_data: true, providers: [] };
  return {
    mode: "live",
    sample_data: false,
    providers: providers().map((p, i) => ({
      role: i === 0 ? "primary" : "fallback",
      name: p.name,
      host: p.host,
      model: p.model || null,
      model_defaulted: p.modelDefaulted,
      api_key_set: Boolean(p.apiKey),
    })),
  };
}

class RetryableError extends Error {} // 429, 5xx, timeout -> try the fallback provider
class MalformedError extends Error {} // bad JSON or wrong shape -> retry same provider once

async function chat(p, systemPrompt, userPrompt) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(buildBody(p, systemPrompt, userPrompt)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      console.warn(`[llm] ${p.name} (${p.model}) timed out after ${TIMEOUT_MS / 1000}s`);
      throw new RetryableError(`${p.name} timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw new AppError(502, "AI_UNREACHABLE", `Could not reach ${p.name}: ${redact(err.cause?.code || err.message)}`);
  }

  const text = await res.text();
  console.log(`[llm] ${p.name} (${p.model}) -> HTTP ${res.status} in ${Date.now() - started} ms`);
  let data = null;
  try { data = JSON.parse(text); } catch { /* handled below */ }

  if (!res.ok) {
    const err = Array.isArray(data) ? data[0]?.error : data?.error; // Gemini can wrap errors in an array
    const msg = redact(err?.message || data?.message || `HTTP ${res.status}`);
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`${p.name} returned ${res.status}: ${msg}`);
    const code = res.status === 401 || res.status === 403 ? "AI_AUTH_FAILED" : "AI_ERROR";
    throw new AppError(502, code, `${p.name} returned ${res.status}: ${msg}`);
  }

  const choice = data?.choices?.[0];
  if (!choice) throw new MalformedError("no choices in response");
  if (choice.message?.refusal) throw new AppError(422, "AI_REFUSED", `${p.name} refused: ${redact(choice.message.refusal)}`);
  if (choice.finish_reason === "length") throw new MalformedError("output cut off at max_tokens");
  return choice.message?.content || "";
}

function parseJson(text, validate) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value;
  try { value = JSON.parse(cleaned); } catch { throw new MalformedError("output is not valid JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MalformedError("output is not a JSON object");
  const problems = validate ? validate(value) : [];
  if (problems.length) throw new MalformedError(problems.slice(0, 5).join("; "));
  return value;
}

// Returns { data, ai: { provider, model, fallback_used, sample_data } }.
async function callLLM(systemPrompt, userPrompt, { validate, mock } = {}) {
  if (isMock()) {
    if (process.env.NODE_ENV === "production") throw new AppError(503, "AI_MOCK_DISABLED", "AI_MODE=mock is for local development only and is disabled when NODE_ENV=production.");
    if (!mock) throw new AppError(500, "AI_MOCK_UNSUPPORTED", "No sample data is defined for this AI task.");
    return { data: mock(), ai: { provider: "Sample data (AI_MODE=mock)", model: null, fallback_used: false, sample_data: true } };
  }

  const list = providers();
  const primary = list[0];
  if (!primary || !primary.apiKey) throw new AppError(503, "AI_NOT_CONFIGURED", "No AI key is configured. Set AI_BASE_URL, AI_API_KEY and AI_MODEL in .env, or set AI_MODE=mock for local sample data.");
  for (const p of list) {
    if (!p.host) throw new AppError(503, "AI_NOT_CONFIGURED", `${p.prefix}_BASE_URL must be a full URL, for example https://api.groq.com/openai/v1.`);
    if (!p.model) throw new AppError(503, "AI_NOT_CONFIGURED", `${p.prefix}_MODEL is empty and there is no default model for ${p.host}.`);
  }
  const usable = list.filter((p) => p.apiKey);

  let lastRetryable;
  for (let i = 0; i < usable.length; i++) {
    const p = usable[i];
    if (i > 0) console.warn(`[llm] falling back to ${p.name} (${redact(lastRetryable.message)})`);
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const data = parseJson(await chat(p, systemPrompt, userPrompt), validate);
          return { data, ai: { provider: p.name, model: p.model, fallback_used: i > 0, sample_data: false } };
        } catch (err) {
          if (!(err instanceof MalformedError)) throw err;
          console.warn(`[llm] ${p.name} attempt ${attempt}: malformed output (${redact(err.message)})${attempt === 1 ? ", retrying once" : ""}`);
          if (attempt === 2) throw new AppError(502, "AI_MALFORMED", `${p.name} returned malformed JSON twice: ${redact(err.message)}`);
        }
      }
    } catch (err) {
      if (!(err instanceof RetryableError)) throw err;
      lastRetryable = err;
    }
  }
  const hint = usable.length > 1 ? " The fallback provider failed too." : " No fallback provider (AI2_*) is configured.";
  throw new AppError(503, "AI_UNAVAILABLE", `${redact(lastRetryable.message)}.${hint}`);
}

module.exports = { callLLM, describeConfig, buildBody };
