// Provider failover layer — Plan A / Plan B / Plan C.
//
// Sunny's stated order:
//   Plan A: Groq, primary key   (GROQ_API_KEY)
//   Plan B: NVIDIA NIM          (NVIDIA_API_KEY, Nemotron default)
//   Plan C: Groq, second key    (GROQ_API_KEY_2) — a completely
//           separate Groq account/key, used only if it is set AND
//           both Plan A and Plan B have failed (e.g. Plan A's key hit
//           its rate/quota limit). Skipped silently when not set.
//
// If no provider is configured, a clear MISSING_API_KEY error is
// thrown. If every configured leg fails, an ALL_PROVIDERS_FAILED
// error carries every leg's failure reason (never any secret values).
// The serving leg is reported as provider: "groq" | "nvidia" |
// "groq2" and surfaced to clients via the X-Provider header.
//
// Both generate-route calls (initial attempt and the validation
// self-repair retry) go through this same chain, inside the route's
// concurrency semaphore + cache/coalescing wrapper.
//
// The TEST STUB mode (CODEAI_TEST_STUB=1, see groqClient.js) short-
// circuits everything via the primary slot: it is TEST ONLY and
// clearly labeled as such.

const {
  callGroqWithRetry,
  isStubMode,
  hasGroqKey: groqSlotHasKey,
} = require("./groqClient");
const { callNvidiaWithModelFallback, hasNvidiaKey } = require("./nvidiaClient");
const logger = require("./logger");

function hasGroqKey() {
  return groqSlotHasKey("primary");
}

function hasGroq2Key() {
  return groqSlotHasKey("secondary");
}

// Which legs are configured right now (booleans only — used by the
// health endpoint; never exposes key values).
function configuredProviders() {
  return {
    groq: hasGroqKey(),
    nvidia: hasNvidiaKey(),
    groq2: hasGroq2Key(),
  };
}

// Default Plan C transport: the Groq client with the secondary key
// slot. Same model fallback list and retry behaviour as Plan A.
function callGroqSecondary(messages, options = {}) {
  return callGroqWithRetry(messages, { ...options, keySlot: "secondary" }, 3);
}

function createProviderChain(deps) {
  const groqCall = deps?.groqCall || callGroqWithRetry;
  const nvidiaCall = deps?.nvidiaCall || callNvidiaWithModelFallback;
  const groq2Call = deps?.groq2Call || callGroqSecondary;
  const groqConfigured = deps?.groqConfigured || hasGroqKey;
  const nvidiaConfigured = deps?.nvidiaConfigured || hasNvidiaKey;
  const groq2Configured = deps?.groq2Configured || hasGroq2Key;
  const stubMode = deps?.stubMode || isStubMode;

  async function callAI(messages, options = {}) {
    if (stubMode()) {
      const result = await groqCall(messages, options, 3);
      return { ...result, provider: result.provider || "groq" };
    }

    const failures = [];

    // Plan A — Groq, primary key.
    if (groqConfigured()) {
      try {
        const result = await groqCall(messages, options, 3);
        return { ...result, provider: "groq" };
      } catch (err) {
        failures.push(`Groq: ${err.message}`);
        logger.warn("Groq (Plan A) failed, falling back to NVIDIA", {
          status: err?.status,
          errorMessage: err.message,
        });
      }
    }

    // Plan B — NVIDIA NIM.
    if (nvidiaConfigured()) {
      try {
        const result = await nvidiaCall(messages, options);
        return { ...result, provider: "nvidia" };
      } catch (err) {
        failures.push(`NVIDIA: ${err.message}`);
        logger.warn("NVIDIA (Plan B) failed, falling back to Groq second key", {
          status: err?.status,
          errorMessage: err.message,
        });
      }
    }

    // Plan C — Groq, second key (only when configured).
    if (groq2Configured()) {
      try {
        const result = await groq2Call(messages, options);
        return { ...result, provider: "groq2" };
      } catch (err) {
        failures.push(`Groq second key (Plan C): ${err.message}`);
        logger.error("Groq second key (Plan C) also failed", {
          status: err?.status,
          errorMessage: err.message,
        });
      }
    }

    if (failures.length === 0) {
      const err = new Error(
        "No AI provider is configured: set GROQ_API_KEY (Plan A, " +
          "primary) and/or NVIDIA_API_KEY (Plan B, backup) and/or " +
          "GROQ_API_KEY_2 (Plan C, second Groq key) in the server " +
          ".env file (see .env.example)."
      );
      err.code = "MISSING_API_KEY";
      err.status = 500;
      throw err;
    }

    const err = new Error(
      `All AI providers failed. ${failures.join(" | ")}`
    );
    err.code = "ALL_PROVIDERS_FAILED";
    err.status = 502;
    throw err;
  }

  return { callAI };
}

const defaultChain = createProviderChain();

module.exports = {
  callAI: defaultChain.callAI,
  createProviderChain,
  configuredProviders,
  hasGroqKey,
  hasGroq2Key,
  hasNvidiaKey,
};
