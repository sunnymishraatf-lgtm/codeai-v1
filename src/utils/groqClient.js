const Groq = require("groq-sdk");
const logger = require("./logger");

let groqClient = null;

function getClient() {
  if (!groqClient) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is not set in environment variables.");
    }
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGroqWithRetry(messages, options = {}, retries = 3) {
  const client = getClient();
  const model = options.model || process.env.MODEL || "llama-3.3-70b-versatile";
  const maxTokens = options.max_tokens || parseInt(process.env.MAX_TOKENS || "4096");

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature: 0.1,
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
        err?.code === "ETIMEDOUT";

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

module.exports = { callGroqWithRetry };
