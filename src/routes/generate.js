const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");

const { callAI } = require("../utils/aiProvider");
const { SYSTEM_PROMPT } = require("../utils/systemPrompt");
const { detectLanguage, getClassName } = require("../utils/langDetect");
const { buildCacheKey, getFromCache, setInCache } = require("../utils/cache");
const { cleanCode } = require("../utils/codeCleaner");
const { fixJavaCode } = require("../utils/javaFixer");
const { validateGenerateRequest } = require("../middleware/validator");
const { deriveClassName } = require("../utils/className");
const { aiSemaphore } = require("../utils/concurrency");
const { validateCode } = require("../utils/codeValidator");
const logger = require("../utils/logger");

// In-flight request coalescing: concurrent requests with the same cache
// key share ONE upstream AI call and all receive the same result. In a
// classroom, 30 students asking "binary search in java" at once cost a
// single Groq request instead of 30.
const inFlight = new Map();

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
  } else if (language === "c") {
    enriched = `
Generate a COMPLETE C program for: ${prompt}

STRICT REQUIREMENTS:
- Standard C (C11), compile with: gcc -std=c11
- Include the headers actually needed (stdio.h, stdlib.h, string.h, stdbool.h, math.h as appropriate)
- Exactly one main function: int main(void) or int main(int argc, char *argv[])
- main must return 0 on success
- Generate ONLY what is explicitly requested
- No unrelated functions or extra features
- For simple problems, generate the simplest possible solution
- Prefer direct standard library solutions
- No explanations
- Return ONLY executable C code
`;
  } else if (language === "python") {
    enriched = `
Generate COMPLETE Python code for: ${prompt}

STRICT REQUIREMENTS:
- Clean, idiomatic Python 3
- Do NOT force the solution into a class unless the problem explicitly asks for one
- Use plain functions and the standard library whenever possible
- Include a simple example / driver under if __name__ == "__main__": when it helps the code run immediately
- Correct indentation (4 spaces), no tabs
- Generate ONLY what is explicitly requested
- No unrelated logic
- No explanations
- Return ONLY executable Python code
- For simple problems, generate the simplest possible solution
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

// Runs the actual upstream AI call under the concurrency semaphore.
// Exported indirectly through generateCode's coalescing map; only ONE
// instance of this runs per cache key at a time.
//
// After cleaning, the code goes through structural validation
// (src/utils/codeValidator.js). If it fails, the AI gets ONE self-repair
// retry with the validation problems fed back; the better of the two
// results is returned and the final validation status is reported to the
// caller (surfaced as the X-Validation response header).
async function runUpstream(prompt, filename, detectedLang) {
  const userPrompt = buildUserPrompt(prompt, filename, detectedLang);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const release = await aiSemaphore.acquire();
  try {
    const first = await callAI(messages, {
      temperature: 0.05,
      top_p: 0.8,
      max_tokens: 2000,
    });

    let finalCode = postProcess(first.content, detectedLang, filename);
    let validation = validateCode(finalCode, detectedLang);
    let repaired = false;

    if (!validation.valid && !first.stub) {
      logger.warn("Generated code failed validation, attempting self-repair", {
        lang: detectedLang,
        problems: validation.problems,
      });

      const repairMessages = [
        ...messages,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content:
            `Your previous code failed validation: ${validation.problems.join("; ")}. ` +
            "Return the corrected, complete code only. No explanations, no markdown.",
        },
      ];

      try {
        const second = await callAI(repairMessages, {
          temperature: 0.05,
          top_p: 0.8,
          max_tokens: 2000,
        });
        const secondCode = postProcess(second.content, detectedLang, filename);
        const secondValidation = validateCode(secondCode, detectedLang);

        // Keep whichever attempt is better (valid beats invalid; fewer
        // problems beats more).
        if (
          secondValidation.valid ||
          secondValidation.problems.length < validation.problems.length
        ) {
          finalCode = secondCode;
          validation = secondValidation;
          repaired = true;
        }
      } catch (repairErr) {
        logger.error("Self-repair attempt failed, returning first result", {
          message: repairErr.message,
        });
      }
    }

    return {
      finalCode,
      usage: first.usage,
      model: first.model,
      provider: first.provider || "groq",
      stub: !!first.stub,
      validation,
      repaired,
    };
  } finally {
    release();
  }
}

async function generateCode(req, res) {
  const requestId = uuidv4();

  const prompt = req.codePrompt;
  let filename = req.codeFilename;
  const explicitLang = req.codeLang;

  const detectedLang =
    explicitLang || detectLanguage(prompt, filename);

  // Java class naming: terminal users never send a filename, so without
  // this every Java answer came back as "public class Main". For Java
  // requests with no explicit filename, derive one from the problem
  // ("write binary search" -> "BinarySearch.java"). It flows through
  // the user prompt and javaFixer, so the returned class is
  // problem-specific, and the X-Filename header tells the user what to
  // save the file as. An explicit user filename always wins.
  if (detectedLang === "java" && !filename) {
    filename = deriveClassName(prompt) + ".java";
  }

  const cacheKey = buildCacheKey(prompt, filename, detectedLang);

  const cached = getFromCache(cacheKey);

  if (cached) {
    logger.info("Cache hit", { requestId, lang: detectedLang });

    res.setHeader("X-Cache", "HIT");
    res.setHeader("X-Language", detectedLang);
    if (filename) res.setHeader("X-Filename", filename);
    res.setHeader("X-Request-Id", requestId);

    return res.status(200).type("text/plain").send(cached);
  }

  logger.info("Generating code", {
    requestId,
    lang: detectedLang,
    filename,
  });

  try {
    // Coalesce concurrent identical requests onto one upstream call.
    let shared = inFlight.get(cacheKey);
    if (!shared) {
      shared = runUpstream(prompt, filename, detectedLang)
        .then((result) => {
          setInCache(cacheKey, result.finalCode);
          return result;
        })
        .finally(() => {
          inFlight.delete(cacheKey);
        });
      inFlight.set(cacheKey, shared);
    }

    const { finalCode, usage, model, provider, stub, validation, repaired } =
      await shared;

    logger.info("Code generated", {
      requestId,
      lang: detectedLang,
      model,
      provider,
      tokens: usage?.total_tokens,
      stub,
      validation: validation?.valid ? "passed" : validation?.problems,
      repaired,
    });

    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Language", detectedLang);
    if (filename) res.setHeader("X-Filename", filename);
    res.setHeader("X-Model", model);
    res.setHeader("X-Provider", provider);
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Tokens-Used", usage?.total_tokens || 0);
    res.setHeader(
      "X-Validation",
      validation?.valid
        ? "passed"
        : `failed: ${(validation?.problems || []).join("; ")}`
    );
    if (repaired) res.setHeader("X-Repaired", "1");
    if (stub) res.setHeader("X-Test-Stub", "1");

    return res.status(200).type("text/plain").send(finalCode);
  } catch (err) {
    logger.error("Generation failed", {
      requestId,
      errorMessage: err.message,
    });

    if (err?.code === "MISSING_API_KEY") {
      return res.status(500).json({
        error:
          "Server is not configured: no AI provider key is set. " +
          "Set GROQ_API_KEY (primary) and/or NVIDIA_API_KEY (backup) " +
          "in the server .env file (see .env.example) and restart.",
        requestId,
      });
    }

    // Sticky failover (one question = one key): the single provider
    // serving this question failed and has been benched; the question
    // was NOT retried on the other keys. The next questions will be
    // served by the next plan automatically.
    if (err?.code === "PROVIDER_FAILED_COOLDOWN") {
      return res.status(502).json({
        error:
          "The AI provider serving this question failed " +
          "(Plan A: Groq, Plan B: NVIDIA, Plan C: Groq second key — " +
          "one question uses one key, so it was not retried on " +
          "another key). That provider has been benched briefly and " +
          "the next questions will automatically use the next plan. " +
          "Please ask again.",
        detail: err.message,
        provider: err.provider,
        nextProvider: err.nextProvider,
        requestId,
      });
    }

    // Every configured provider is in cooldown: no provider was
    // called for this request at all.
    if (err?.code === "ALL_PROVIDERS_COOLDOWN") {
      return res.status(503).json({
        error:
          "All AI providers are cooling down after recent failures. " +
          "Please try again in a few moments.",
        detail: err.message,
        retryAt: err.retryAt,
        requestId,
      });
    }

    if (err?.code === "QUEUE_TIMEOUT" || err?.status === 503) {
      return res.status(503).json({
        error:
          "Server busy: too many simultaneous AI requests. " +
          "Please try again in a few seconds.",
        requestId,
      });
    }

    if (err?.status === 429) {
      return res.status(429).json({
        error: "Rate limit hit. Try again shortly.",
        requestId,
      });
    }

    if (err?.status === 401) {
      return res.status(500).json({
        error: "Invalid Groq API key.",
        requestId,
      });
    }

    return res.status(502).json({
      error: "Code generation service unavailable.",
      requestId,
    });
  }
}

router.post("/", validateGenerateRequest, generateCode);
router.get("/", validateGenerateRequest, generateCode);

module.exports = router;