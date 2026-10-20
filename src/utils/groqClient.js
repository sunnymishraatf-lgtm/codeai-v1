const Groq = require("groq-sdk");
const logger = require("./logger");

let groqClient = null;

function getClient() {
  if (!groqClient) {
    if (!process.env.GROQ_API_KEY) {
      const err = new Error("GROQ_API_KEY is not set in environment variables.");
      err.code = "MISSING_API_KEY";
      err.status = 500;
      throw err;
    }
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
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

function isStubMode() {
  return process.env.CODEAI_TEST_STUB === "1";
}

function getStubCallCount() {
  return stubCallCount;
}

async function callStub(messages, options, model) {
  stubCallCount++;
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

async function callGroqWithRetry(messages, options = {}, retries = 3) {
  const model = options.model || process.env.MODEL || "llama-3.3-70b-versatile";

  if (isStubMode()) {
    return callStub(messages, options, model);
  }

  const client = getClient();
  const maxTokens = options.max_tokens || parseInt(process.env.MAX_TOKENS || "8192");
  const temperature = options.temperature ?? 0.1;
  const topP = options.top_p ?? 1;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
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
          status: err?.status,
          code: err?.code,
        });
        await sleep(delay);
        continue;
      }

      logger.error("Groq API call failed after retries", {
        attempt,
        status: err?.status,
        message: err?.message,
      });
      throw err;
    }
  }
}

module.exports = { callGroqWithRetry, isStubMode, getStubCallCount };
