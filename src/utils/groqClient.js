const Groq = require("groq-sdk");
const logger = require("./logger");

// ---------------------------------------------------------------------------
// GROQ MODEL SELECTION
//
// MODEL REALITY CHECK (live evidence, 2026-10-20): Groq moved
// llama-3.3-70b-versatile to enterprise-only "contact sales" pricing in
// August 2026, so a normal free/self-serve key gets
// 404 model_not_found for it — the deployed app broke exactly that way,
// and setting MODEL=openai/gpt-oss-120b brought it back (verified live
// with real answers). The self-serve production model
// openai/gpt-oss-120b is therefore the default now.
//
// Groq retires models regularly, so a single pinned name is fragile:
// if the chosen model answers model_not_found, the next candidate in
// the list is tried automatically (mirroring the NVIDIA client).
// Set GROQ_MODELS="model-a,model-b,..." to replace the built-in
// fallback list; options.model / MODEL still take precedence as the
// first candidate.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "openai/gpt-oss-120b";

const MODEL_FALLBACKS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "qwen/qwen3-32b",
];

function candidateModels(options = {}) {
  const chosen = options.model || process.env.MODEL || null;

  if (process.env.GROQ_MODELS) {
    const list = process.env.GROQ_MODELS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) {
      // GROQ_MODELS replaces the built-in fallback list; an explicitly
      // chosen model (options.model / MODEL) still goes first.
      return [...new Set([...(chosen ? [chosen] : []), ...list])];
    }
  }

  return [...new Set([chosen || DEFAULT_MODEL, ...MODEL_FALLBACKS])];
}

function isModelNotFound(err) {
  // Only a genuine "this model does not exist / you have no access"
  // response may advance to the next candidate model. Groq returns
  // HTTP 404 with error code "model_not_found" for retired or
  // enterprise-gated models (seen live on 2026-10-20).
  if (err?.status !== 404) return false;
  const code = err?.code || err?.error?.code || err?.error?.type || "";
  if (code === "model_not_found") return true;
  const msg = (err?.message || "").toLowerCase();
  return msg.includes("model_not_found") || msg.includes("does not exist");
}

// ---------------------------------------------------------------------------
// PER-KEY CLIENTS (Plan A / Plan C)
// Two independent Groq keys are supported: the primary key
// (GROQ_API_KEY, Plan A) and an optional second key (GROQ_API_KEY_2,
// Plan C — used by the provider chain only after NVIDIA has also
// failed). Clients are cached per slot. Key values are never logged,
// never included in errors beyond naming the env var to set.
// ---------------------------------------------------------------------------
const KEY_SLOTS = {
  primary: "GROQ_API_KEY",
  secondary: "GROQ_API_KEY_2",
};

const groqClients = {};

function keySlotEnvVar(keySlot) {
  return KEY_SLOTS[keySlot] || KEY_SLOTS.primary;
}

function normalizeKeySlot(keySlot) {
  return keySlot === "secondary" ? "secondary" : "primary";
}

function hasGroqKey(keySlot = "primary") {
  return !!process.env[keySlotEnvVar(keySlot)];
}

function getClient(keySlot = "primary") {
  const slot = normalizeKeySlot(keySlot);
  const envVar = keySlotEnvVar(slot);
  if (!groqClients[slot]) {
    if (!process.env[envVar]) {
      const err = new Error(`${envVar} is not set in environment variables.`);
      err.code = "MISSING_API_KEY";
      err.status = 500;
      throw err;
    }
    groqClients[slot] = new Groq({ apiKey: process.env[envVar] });
  }
  return groqClients[slot];
}

// ---------------------------------------------------------------------------
// TEST STUB — TEST ONLY, NEVER REAL AI OUTPUT.
// When CODEAI_TEST_STUB=1 the client skips Groq entirely and returns a
// small, clearly-labeled fake program after a short delay. This exists so
// the classroom concurrency behaviour (queueing, coalescing, caching) can
// be load-tested locally without a real Groq key. Responses produced in
// this mode are marked with `stub: true` and the route sets an
// `X-Test-Stub: 1` header. Never enable this in production.
// ---------------------------------------------------------------------------
let stubCallCount = 0;
const stubCallCounts = { primary: 0, secondary: 0 };

function isStubMode() {
  return process.env.CODEAI_TEST_STUB === "1";
}

function getStubCallCount() {
  return stubCallCount;
}

function getStubCallCountForSlot(keySlot = "primary") {
  return stubCallCounts[normalizeKeySlot(keySlot)] || 0;
}

async function callStub(messages, options, model, keySlot = "primary") {
  stubCallCount++;
  stubCallCounts[normalizeKeySlot(keySlot)]++;
  const delay = parseInt(process.env.CODEAI_TEST_STUB_DELAY_MS || "300", 10);
  logger.warn("TEST STUB in use — returning fake code, NOT real AI output", {
    stubCall: stubCallCount,
    delay,
  });
  await sleep(delay);
  return {
    content:
      "// TEST STUB - NOT REAL AI OUTPUT\n" +
      "public class Main {\n" +
      "    public static void main(String[] args) {\n" +
      "        System.out.println(\"stub\");\n" +
      "    }\n" +
      "}\n",
    usage: { total_tokens: 0 },
    model: model + " (TEST STUB)",
    stub: true,
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// deps.createCompletion is a TEST seam: unit tests inject a labeled fake
// completion function instead of the real Groq SDK call. Production code
// never passes it.
async function callGroqWithRetry(messages, options = {}, retries = 3, deps = {}) {
  const models = candidateModels(options);
  const keySlot = normalizeKeySlot(options.keySlot);

  if (isStubMode()) {
    return callStub(messages, options, models[0], keySlot);
  }

  const createCompletion =
    deps.createCompletion ||
    (async (params) => getClient(keySlot).chat.completions.create(params));

  const maxTokens = options.max_tokens || parseInt(process.env.MAX_TOKENS || "8192");
  const temperature = options.temperature ?? 0.1;
  const topP = options.top_p ?? 1;

  let lastErr = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await createCompletion({
          model,
          max_tokens: maxTokens,
          temperature,
          top_p: topP,
          messages,
        });

        const content = response?.choices?.[0]?.message?.content || "";
        const usage = response?.usage || {};
        return { content, usage, model };
      } catch (err) {
        // Model retired / not accessible: retrying the same model is
        // pointless — move on to the next candidate model.
        if (isModelNotFound(err)) {
          lastErr = err;
          break;
        }

        const isRetryable =
          err?.status === 429 ||
          err?.status === 503 ||
          err?.status === 502 ||
          err?.code === "ECONNRESET" ||
          err?.code === "ETIMEDOUT" ||
          err?.name === "APIConnectionError";

        if (isRetryable && attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          logger.warn(`Groq API attempt ${attempt} failed, retrying in ${delay}ms`, {
            model,
            status: err?.status,
            code: err?.code,
          });
          await sleep(delay);
          continue;
        }

        logger.error("Groq API call failed after retries", {
          model,
          attempt,
          status: err?.status,
          message: err?.message,
        });
        throw err;
      }
    }

    if (lastErr && model !== models[models.length - 1]) {
      logger.warn("Groq model unavailable, trying next model", {
        model,
        status: lastErr?.status,
      });
    }
  }

  // Every candidate model answered model_not_found.
  logger.error("Groq API call failed: no candidate model available", {
    models,
    message: lastErr?.message,
  });
  throw lastErr;
}

module.exports = {
  callGroqWithRetry,
  isStubMode,
  getStubCallCount,
  getStubCallCountForSlot,
  hasGroqKey,
  candidateModels,
  isModelNotFound,
  GROQ_MODELS: MODEL_FALLBACKS,
  DEFAULT_MODEL,
  KEY_SLOTS,
};
