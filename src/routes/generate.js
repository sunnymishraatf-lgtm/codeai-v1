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
  let enriched = "";

  if (language === "java") {
    const className = getClassName(filename);

    enriched = `
Generate a COMPLETE Java program for: ${prompt}

STRICT REQUIREMENTS:
- Generate ONLY what is explicitly requested
- NEVER create Node classes unless explicitly required
- NEVER use linked lists unless explicitly requested
- NEVER use trees unless explicitly requested
- NEVER use graphs unless explicitly requested
- Use arrays or Java standard collections whenever possible
- Prefer ArrayList, HashMap, HashSet, Stack, Queue from java.util
- MUST use Java standard library implementations whenever possible
- MUST use java.util.PriorityQueue for priority queue operations
- NEVER create custom PriorityQueue classes
- NEVER implement custom heap data structures unless explicitly requested
- For simple problems, generate the simplest possible solution
- Do NOT create custom data structures unless explicitly requested
- Prefer direct standard library solutions
- No unrelated classes
- Exactly one public class
- Public class name must be: ${className}
- main(String[] args) must exist
- Code must compile immediately
- Return ONLY executable Java code

IMPORTANT:
- If the problem can be solved using HashMap, HashSet, ArrayList, Stack, Queue or arrays directly, use them directly
- Do not create extra helper classes unless absolutely necessary
- Do not overengineer simple problems
`;
  } else {
    enriched = `
Generate COMPLETE code for: ${prompt}

STRICT REQUIREMENTS:
- Generate ONLY requested functionality
- No unrelated logic
- No extra classes
- No explanations
- Return ONLY executable code
- For simple problems, generate the simplest possible solution
- Prefer direct standard library solutions
`;
  }

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

  const detectedLang =
    explicitLang || detectLanguage(prompt, filename);

  const cacheKey = buildCacheKey(
    prompt,
    filename,
    detectedLang
  );

  // const cached = getFromCache(cacheKey);

  // if (cached) {
  //   logger.info("Cache hit", {
  //     requestId,
  //     lang: detectedLang
  //   });

  //   res.setHeader("X-Cache", "HIT");
  //   res.setHeader("X-Language", detectedLang);
  //   res.setHeader("X-Request-Id", requestId);

  //   return res
  //     .status(200)
  //     .type("text/plain")
  //     .send(cached);
  // }

  const userPrompt = buildUserPrompt(
    prompt,
    filename,
    detectedLang
  );

  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT
    },
    {
      role: "user",
      content: userPrompt
    }
  ];

  logger.info("Generating code", {
    requestId,
    lang: detectedLang,
    filename
  });

  try {
    const { content, usage, model } =
      await callGroqWithRetry(
        messages,
        {
          temperature: 0.05,
          top_p: 0.8,
          max_tokens: 2000
        },
        3
      );

    const finalCode = postProcess(
      content,
      detectedLang,
      filename
    );

    // setInCache(cacheKey, finalCode);

    logger.info("Code generated", {
      requestId,
      lang: detectedLang,
      model,
      tokens: usage?.total_tokens
    });

    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Language", detectedLang);
    res.setHeader("X-Model", model);
    res.setHeader("X-Request-Id", requestId);
    res.setHeader(
      "X-Tokens-Used",
      usage?.total_tokens || 0
    );

    return res
      .status(200)
      .type("text/plain")
      .send(finalCode);

  } catch (err) {
    logger.error("Generation failed", {
      requestId,
      message: err.message
    });

    if (err?.status === 429) {
      return res.status(429).json({
        error: "Rate limit hit. Try again shortly.",
        requestId
      });
    }

    if (err?.status === 401) {
      return res.status(500).json({
        error: "Invalid Groq API key.",
        requestId
      });
    }

    return res.status(502).json({
      error: "Code generation service unavailable.",
      requestId
    });
  }
}

router.post("/", validateGenerateRequest, generateCode);
router.get("/", validateGenerateRequest, generateCode);

module.exports = router;