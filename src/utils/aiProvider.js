// Provider selection — Plan A / Plan B / Plan C with STICKY failover.
//
// Sunny's rule (2026-10-20): "all the three api keys should not be used
// together for 1 question." One question = one key:
//
//   Plan A: Groq, primary key   (GROQ_API_KEY)
//   Plan B: NVIDIA NIM          (NVIDIA_API_KEY, Nemotron default)
//   Plan C: Groq, second key    (GROQ_API_KEY_2) — only if set.
//
// Each request selects the FIRST configured leg that is not in
// cooldown and calls ONLY that leg. A leg's internal per-model
// fallback (same key, different model) and the route's single
// validation self-repair retry stay on that same leg — models are not
// keys.
//
// If the selected leg's call ultimately fails, the leg is BENCED
// (circuit breaker) for a cooldown and the request returns an honest
// error — it is NOT silently retried on the next leg. The NEXT
// question then automatically selects the next eligible leg. When a
// cooldown expires, the leg becomes eligible again in preference
// order, so Plan A naturally resumes once it is healthy; if it fails
// again it is re-benched.
//
// Cooldowns (env-overridable):
//   PROVIDER_COOLDOWN_MS    default 60000  — general failures
//   RATE_LIMIT_COOLDOWN_MS  default 300000 — 429 / quota failures
// A provider-supplied retry-after hint wins when present (capped at
// 15 minutes).
//
// If every configured leg is cooling down, requests fail fast with a
// 503 (ALL_PROVIDERS_COOLDOWN) and NO provider is called at all. If
// no provider key is configured at all, a MISSING_API_KEY error is
// thrown (unchanged).
//
// Breaker state is module-level (a property of the keys, not of a
// chain instance), in-memory only, and shared by every chain created
// from this module — including the one behind the health endpoint's
// providerState view. The serving leg is reported as
// provider: "groq" | "nvidia" | "groq2" (X-Provider header).

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

// ---------------------------------------------------------------------------
// Circuit-breaker state (per leg). Shared module state on purpose:
// benching Plan A must be visible to every caller and to /api/health.
// ---------------------------------------------------------------------------
const legState = {
  groq: { downUntil: 0, lastError: null, lastFailedAt: null },
  nvidia: { downUntil: 0, lastError: null, lastFailedAt: null },
  groq2: { downUntil: 0, lastError: null, lastFailedAt: null },
};

function resetProviderState() {
  for (const name of Object.keys(legState)) {
    legState[name] = { downUntil: 0, lastError: null, lastFailedAt: null };
  }
}

const MAX_COOLDOWN_MS = 15 * 60 * 1000;

function generalCooldownMs() {
  const v = parseInt(process.env.PROVIDER_COOLDOWN_MS || "60000", 10);
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}

function rateLimitCooldownMs() {
  const v = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || "300000", 10);
  return Number.isFinite(v) && v >= 0 ? v : 300000;
}

function isRateLimitFailure(err) {
  if (err?.status === 429) return true;
  const msg = (err?.message || "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("quota") ||
    msg.includes("limit reached") ||
    msg.includes("too many requests")
  );
}

// Extract a provider retry-after hint (ms) from common error shapes:
// retryAfterMs / retryAfterSeconds / retryAfter (seconds) fields, or a
// Retry-After header (seconds or HTTP date) on err.headers /
// err.response.headers (plain object or Headers instance).
function retryAfterMs(err) {
  if (!err) return null;
  if (Number.isFinite(err.retryAfterMs)) return err.retryAfterMs;
  if (Number.isFinite(err.retryAfterSeconds)) return err.retryAfterSeconds * 1000;

  let raw = null;
  const headers = err.headers || err.response?.headers;
  if (headers) {
    if (typeof headers.get === "function") {
      raw = headers.get("retry-after");
    } else {
      raw = headers["retry-after"] ?? headers["Retry-After"] ?? null;
    }
  }
  if (raw == null && err.retryAfter != null) raw = err.retryAfter;
  if (raw == null) return null;

  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

function cooldownFor(err) {
  let ms = isRateLimitFailure(err) ? rateLimitCooldownMs() : generalCooldownMs();
  const hint = retryAfterMs(err);
  if (hint != null) ms = hint;
  return Math.min(Math.max(ms, 0), MAX_COOLDOWN_MS);
}

function humanizeMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m} min`;
}

function createProviderChain(deps = {}) {
  const groqCall = deps.groqCall || callGroqWithRetry;
  const nvidiaCall = deps.nvidiaCall || callNvidiaWithModelFallback;
  const groq2Call = deps.groq2Call || callGroqSecondary;
  const groqConfigured = deps.groqConfigured || hasGroqKey;
  const nvidiaConfigured = deps.nvidiaConfigured || hasNvidiaKey;
  const groq2Configured = deps.groq2Configured || hasGroq2Key;
  const stubMode = deps.stubMode || isStubMode;

  const configuredFns = {
    groq: groqConfigured,
    nvidia: nvidiaConfigured,
    groq2: groq2Configured,
  };

  const legs = [
    {
      name: "groq",
      label: "Plan A (Groq)",
      configured: groqConfigured,
      call: (messages, options) => groqCall(messages, options, 3),
    },
    {
      name: "nvidia",
      label: "Plan B (NVIDIA)",
      configured: nvidiaConfigured,
      call: (messages, options) => nvidiaCall(messages, options),
    },
    {
      name: "groq2",
      label: "Plan C (Groq, second key)",
      configured: groq2Configured,
      call: (messages, options) => groq2Call(messages, options),
    },
  ];

  function configuredLegs() {
    return legs.filter((leg) => leg.configured());
  }

  function getProviderState(now = Date.now()) {
    const out = {};
    for (const leg of legs) {
      if (!leg.configured()) continue; // unconfigured legs are omitted (notably groq2)
      out[leg.name] = legState[leg.name].downUntil > now ? "cooldown" : "up";
    }
    return out;
  }

  function getProviderStateDetail(now = Date.now()) {
    const out = {};
    for (const leg of legs) {
      if (!leg.configured()) continue;
      const st = legState[leg.name];
      out[leg.name] = {
        state: st.downUntil > now ? "cooldown" : "up",
        downUntil: st.downUntil > now ? new Date(st.downUntil).toISOString() : null,
        lastError: st.lastError,
        lastFailedAt: st.lastFailedAt,
      };
    }
    return out;
  }

  // The leg the NEXT request would select if `excludeName` were
  // benched: first configured leg not in cooldown, or (if all are
  // cooling) the one whose cooldown ends soonest.
  function nextLegAfter(excludeName, now) {
    const others = configuredLegs().filter((l) => l.name !== excludeName);
    const eligible = others.find((l) => legState[l.name].downUntil <= now);
    if (eligible) return { leg: eligible, availableNow: true };
    if (others.length === 0) return null;
    const soonest = others.reduce((a, b) =>
      legState[a.name].downUntil <= legState[b.name].downUntil ? a : b
    );
    return { leg: soonest, availableNow: false };
  }

  async function callAI(messages, options = {}) {
    if (stubMode()) {
      const result = await groqCall(messages, options, 3);
      return { ...result, provider: result.provider || "groq" };
    }

    const configured = configuredLegs();
    if (configured.length === 0) {
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

    const now = Date.now();
    const leg = configured.find((l) => legState[l.name].downUntil <= now);

    if (!leg) {
      const earliest = Math.min(
        ...configured.map((l) => legState[l.name].downUntil)
      );
      const err = new Error(
        "All configured AI providers are cooling down after recent " +
          "failures (one question = one key, so no provider was called " +
          `for this request). Earliest retry: ${new Date(earliest).toISOString()}.`
      );
      err.code = "ALL_PROVIDERS_COOLDOWN";
      err.status = 503;
      err.retryAt = new Date(earliest).toISOString();
      throw err;
    }

    try {
      const result = await leg.call(messages, options);
      // Success: the leg is healthy again.
      legState[leg.name] = { downUntil: 0, lastError: null, lastFailedAt: null };
      return { ...result, provider: leg.name };
    } catch (err) {
      if (err?.code === "MISSING_API_KEY") {
        // The key vanished after the configured check — not a provider
        // failure; surface it without benching anything.
        throw err;
      }

      const cooldownMs = cooldownFor(err);
      const failedAt = Date.now();
      legState[leg.name] = {
        downUntil: failedAt + cooldownMs,
        lastError: { message: err.message, status: err?.status ?? null },
        lastFailedAt: new Date(failedAt).toISOString(),
      };

      const next = nextLegAfter(leg.name, failedAt);
      logger.warn("Provider leg failed; benched (sticky failover)", {
        provider: leg.name,
        status: err?.status,
        errorMessage: err.message,
        cooldownMs,
        nextProvider: next?.leg?.name ?? null,
      });

      let nextText;
      if (!next) {
        nextText = "no other provider is configured";
      } else if (next.availableNow) {
        nextText = `the next questions will automatically use ${next.leg.label}`;
      } else {
        nextText =
          `all other providers are still cooling down; the next available is ` +
          `${next.leg.label} at ${new Date(legState[next.leg.name].downUntil).toISOString()}`;
      }

      const wrapped = new Error(
        `${leg.label} failed: ${err.message}. One question = one key: ` +
          `this question was NOT retried on another provider. ` +
          `${leg.label} has been benched for ${humanizeMs(cooldownMs)}; ` +
          `${nextText}.`
      );
      wrapped.code = "PROVIDER_FAILED_COOLDOWN";
      wrapped.status = 502;
      wrapped.provider = leg.name;
      wrapped.cause = err;
      wrapped.cooldownMs = cooldownMs;
      wrapped.benchedUntil = new Date(failedAt + cooldownMs).toISOString();
      wrapped.nextProvider = next?.leg?.name ?? null;
      throw wrapped;
    }
  }

  return { callAI, getProviderState, getProviderStateDetail, resetState: resetProviderState };
}

const defaultChain = createProviderChain();

// providerState for the health endpoint: built from the DEFAULT
// chain's configured checks (real env) over the shared breaker state.
function providerState() {
  return defaultChain.getProviderState();
}

function providerStateDetail() {
  return defaultChain.getProviderStateDetail();
}

module.exports = {
  callAI: defaultChain.callAI,
  createProviderChain,
  configuredProviders,
  providerState,
  providerStateDetail,
  resetProviderState,
  hasGroqKey,
  hasGroq2Key,
  hasNvidiaKey,
};
