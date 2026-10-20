// NVIDIA NIM backup provider (build.nvidia.com).
//
// OpenAI-compatible endpoint — baseUrl aligned with Sunny's NEUTRON app
// provider catalog (src/providers/catalog.ts):
//   baseUrl: https://integrate.api.nvidia.com/v1
//
// MODEL REALITY CHECK (live-tested with Sunny's real key on 2026-10-20):
// NVIDIA rotates/retires models. All three NEUTRON catalog models FAIL
// live right now — meta/llama-3.3-70b-instruct -> 410 Gone,
// nvidia/llama-3.3-nemotron-super-49b-v1 -> 410 Gone,
// meta/llama-3.1-70b-instruct -> 404. Sunny asked for NVIDIA's
// Nemotron family as the backup ("use neutron" = Nemotron), and the
// current Nemotron verified WORKING live — it returned a correct,
// complete C Fibonacci program — is nvidia/nemotron-3-ultra-550b-a55b,
// so it is the default. Fallbacks, also live-tested 2026-10-20:
// openai/gpt-oss-20b (returned correct Python code) and
// google/gemma-4-31b-it (answered, code output not sampled).
// NVIDIA_MODEL env var overrides the default choice.
//
// If the chosen model returns 404 (not found) or 410 (retired/gone),
// the next model in the list is tried before giving up.
//
// The API key comes ONLY from the NVIDIA_API_KEY environment variable.
// It is never hardcoded and never logged.

const logger = require("./logger");

const NVIDIA_BASE_URL =
  process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";

const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

// Live-verified chain (2026-10-20, Sunny's real key): Nemotron first
// (Sunny's requested family), then the other working models. The old
// NEUTRON catalog models return 410/404 live, so they are NOT in the
// chain anymore.
const MODEL_FALLBACKS = [
  "nvidia/nemotron-3-ultra-550b-a55b",
  "openai/gpt-oss-20b",
  "google/gemma-4-31b-it",
];

function hasNvidiaKey() {
  return !!process.env.NVIDIA_API_KEY;
}

function candidateModels() {
  const chosen = process.env.NVIDIA_MODEL || DEFAULT_MODEL;
  return [...new Set([chosen, ...MODEL_FALLBACKS])];
}

function isModelNotFound(err) {
  // 404 = model not found; 410 = model retired/gone (NVIDIA returns
  // 410 for decommissioned models — seen live on 2026-10-20).
  if (err?.status === 404 || err?.status === 410) return true;
  const msg = (err?.message || "").toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("unknown model") ||
    msg.includes("invalid model")
  );
}

async function callNvidiaOnce(messages, options, model) {
  const timeoutMs = parseInt(process.env.NVIDIA_TIMEOUT_MS || "30000", 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Key is used only in this header — never logged anywhere.
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens:
          options.max_tokens ||
          parseInt(process.env.MAX_TOKENS || "8192", 10),
        temperature: options.temperature ?? 0.1,
        top_p: options.top_p ?? 1,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const err = new Error(
        `NVIDIA API error ${response.status}: ${bodyText.slice(0, 300)}`
      );
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const usage = data?.usage || {};
    return { content, usage, model, provider: "nvidia" };
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(
        `NVIDIA API timed out after ${timeoutMs}ms`
      );
      timeoutErr.code = "ETIMEDOUT";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callNvidiaWithModelFallback(messages, options = {}) {
  if (!hasNvidiaKey()) {
    const err = new Error("NVIDIA_API_KEY is not set in environment variables.");
    err.code = "MISSING_API_KEY";
    err.status = 500;
    throw err;
  }

  const models = candidateModels();
  let lastErr = null;

  for (const model of models) {
    try {
      return await callNvidiaOnce(messages, options, model);
    } catch (err) {
      lastErr = err;
      if (isModelNotFound(err) && model !== models[models.length - 1]) {
        logger.warn("NVIDIA model unavailable, trying next model", {
          model,
          status: err?.status,
        });
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}

module.exports = {
  callNvidiaWithModelFallback,
  hasNvidiaKey,
  candidateModels,
  isModelNotFound,
  NVIDIA_MODELS: MODEL_FALLBACKS,
  DEFAULT_MODEL,
};
