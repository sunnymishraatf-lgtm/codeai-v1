const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { callGroqWithRetry } = require("../utils/groqClient");
const { SYSTEM_PROMPT } = require("../utils/systemPrompt");
const { detectLanguage, getClassName } = require("../utils/langDetect");
const { buildCacheKey, getFromCache, setInCache } = require("../utils/cache");
const { cleanCode } = require("../utils/codeCleaner");
const { fixJavaCode } = require("../utils/javaFixer");
const { validateGenerateRequest } = require("../middleware/validator");
const logger = require("../utils/logger");

function buildUserPrompt(prompt, filename, language) {
  let enriched = prompt;

  if (filename) enriched += `\nFilename: ${filename}`;
  if (language && language !== "auto") enriched += `\nLanguage: ${language}`;

  if (language === "java") {
    const className = getClassName(filename);
    enriched += `\nRules for this Java code:`;
    enriched += `\n- The public class MUST be named: ${className}`;
    enriched += `\n- The main(String[] args) method MUST be inside class ${className}`;
    enriched += `\n- All other classes (Node, Stack, Queue, etc.) must NOT have the public keyword`;
    enriched += `\n- File must compile with: javac ${filename || className + ".java"}`;
  }

  enriched += `\nCRITICAL: Return ONLY raw executable code. No comments. No markdown. No backticks. No explanation.`;
  return enriched;
}

function postProcess(code, language, filename) {
  let result = cleanCode(code, language);
  if (language === "java") {
    result = fixJavaCode(result, filename || "Main.java");
  }
  return result;
}

async function generateCode(req, res) {
  const requestId = uuidv4();
  const prompt = req.codePrompt;
  const filename = req.codeFilename;
  const explicitLang = req.codeLang;

  const detectedLang = explicitLang || detectLanguage(prompt, filename);
  const cacheKey = buildCacheKey(prompt, filename, detectedLang);

  const cached = getFromCache(cacheKey);
  if (cached) {
    logger.info("Cache hit", { requestId, lang: detectedLang });
    res.setHeader("X-Cache", "HIT");
    res.setHeader("X-Language", detectedLang);
    res.setHeader("X-Request-Id", requestId);
    return res.status(200).type("text/plain").send(cached);
  }

  const userPrompt = buildUserPrompt(prompt, filename, detectedLang);
  const messages = [{ role: "user", content: userPrompt }];

  logger.info("Generating code", { requestId, lang: detectedLang, filename });

  try {
    const { content, usage, model } = await callGroqWithRetry(messages, {}, 3);
    const finalCode = postProcess(content, detectedLang, filename);

    setInCache(cacheKey, finalCode);

    logger.info("Code generated", { requestId, lang: detectedLang, model, tokens: usage?.total_tokens });

    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Language", detectedLang);
    res.setHeader("X-Model", model);
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Tokens-Used", usage?.total_tokens || 0);

    return res.status(200).type("text/plain").send(finalCode);
  } catch (err) {
    logger.error("Generation failed", { requestId, message: err.message });
    if (err?.status === 429) return res.status(429).json({ error: "Rate limit hit. Try again shortly.", requestId });
    if (err?.status === 401) return res.status(500).json({ error: "Invalid Groq API key.", requestId });
    return res.status(502).json({ error: "Code generation service unavailable.", requestId });
  }
}

router.post("/", validateGenerateRequest, generateCode);
router.get("/", validateGenerateRequest, generateCode);

module.exports = router;
