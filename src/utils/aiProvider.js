// Provider failover layer.
//
// Order: Groq (primary) -> NVIDIA NIM (backup) -> honest combined error.
// If Groq is not configured, fails, rate-limits, or times out, NVIDIA is
// tried automatically. If neither provider is configured, a clear
// MISSING_API_KEY error is thrown. If both are tried and both fail, an
// ALL_PROVIDERS_FAILED error carries both failure reasons (never any
// secret values).
//
// The TEST STUB mode (CODEAI_TEST_STUB=1, see groqClient.js) short-
// circuits everything: it is TEST ONLY and clearly labeled as such.

const { callGroqWithRetry, isStubMode } = require("./groqClient");
const { callNvidiaWithModelFallback, hasNvidiaKey } = require("./nvidiaClient");
const logger = require("./logger");

function hasGroqKey() {
  return !!process.env.GROQ_API_KEY;
}

function createProviderChain(deps) {
  const groqCall = deps?.groqCall || callGroqWithRetry;
  const nvidiaCall = deps?.nvidiaCall || callNvidiaWithModelFallback;
  const groqConfigured = deps?.groqConfigured || hasGroqKey;
  const nvidiaConfigured = deps?.nvidiaConfigured || hasNvidiaKey;
  const stubMode = deps?.stubMode || isStubMode;

  async function callAI(messages, options = {}) {
    if (stubMode()) {
      const result = await groqCall(messages, options, 3);
      return { ...result, provider: result.provider || "groq" };
    }

    const failures = [];

    if (groqConfigured()) {
      try {
        const result = await groqCall(messages, options, 3);
        return { ...result, provider: "groq" };
      } catch (err) {
        failures.push(`Groq: ${err.message}`);
        logger.warn("Groq failed, falling back to NVIDIA", {
          status: err?.status,
          errorMessage: err.message,
        });
      }
    }

    if (nvidiaConfigured()) {
      try {
        const result = await nvidiaCall(messages, options);
        return { ...result, provider: "nvidia" };
      } catch (err) {
        failures.push(`NVIDIA: ${err.message}`);
        logger.error("NVIDIA fallback also failed", {
          status: err?.status,
          errorMessage: err.message,
        });
      }
    }

    if (failures.length === 0) {
      const err = new Error(
        "No AI provider is configured: set GROQ_API_KEY (primary) " +
          "and/or NVIDIA_API_KEY (backup) in the server .env file " +
          "(see .env.example)."
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
  hasGroqKey,
  hasNvidiaKey,
};
