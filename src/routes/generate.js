const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");

const aiProvider = require("../utils/aiProvider");
const { SYSTEM_PROMPT } = require("../utils/systemPrompt");
const { detectLanguage, getClassName } = require("../utils/langDetect");
const { buildCacheKey, getFromCache, setInCache } = require("../utils/cache");
const { cleanCode } = require("../utils/codeCleaner");
const { fixJavaCode } = require("../utils/javaFixer");
const { validateGenerateRequest } = require("../middleware/validator");
const { deriveClassName, resolveJavaFileBase } = require("../utils/className");

// The provider caller is a module-level binding so tests can substitute
// a labeled fake (TEST SEAM, tests only — mirrors the deps seam in
// groqClient.js). Production code always uses aiProvider.callAI, which
// implements the sticky one-question-one-key failover.
let callAI = aiProvider.callAI;
function setCallAIForTests(fn) {
  callAI = typeof fn === "function" ? fn : aiProvider.callAI;
}
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
    // fixJavaCode only strips stray fence lines — it never renames
    // classes (see its header). The filename argument is unused.
    result = fixJavaCode(result, filename);
  }

  return result;
}

// Runs the actual upstream AI call under the concurrency semaphore.
// Exported indirectly through generateCode's coalescing map; only ONE
// instance of this runs per cache key at a time.
//
// After cleaning, the code goes through structural validation
// (src/utils/codeValidator.js). If it fails, the AI gets up to
// MAX_REPAIR_ATTEMPTS self-repair attempts: each repair prompt carries
// the validator's exact failure reasons and asks for a clean
// regeneration, the conversation accumulates so the model sees its own
// previous attempt, and the first PASSING result wins. All attempts go
// through the same callAI binding, so they stay on the same provider
// leg (sticky failover is enforced inside aiProvider). A provider
// error from any attempt propagates as its typed error — it is never
// masked by returning broken code.
//
// If every attempt fails validation, runUpstream returns the best
// attempt with validation.valid === false and the CALLER refuses to
// serve or cache it (502 GENERATION_INVALID). Known-broken code is
// never served and never cached.
const MAX_REPAIR_ATTEMPTS = 2;

async function runUpstream(prompt, filename, detectedLang) {
  const userPrompt = buildUserPrompt(prompt, filename, detectedLang);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const callOptions = {
    temperature: 0.05,
    top_p: 0.8,
    max_tokens: 2000,
  };

  const release = await aiSemaphore.acquire();
  try {
    const attempt = async (msgs) => {
      const result = await callAI(msgs, callOptions);
      const code = postProcess(result.content, detectedLang, filename);
      return { result, code, validation: validateCode(code, detectedLang) };
    };

    let latest = await attempt(messages);
    let best = latest;
    let conversation = [
      ...messages,
      { role: "assistant", content: latest.result.content },
    ];
    let repaired = false;

    for (
      let repair = 1;
      repair <= MAX_REPAIR_ATTEMPTS && !best.validation.valid && !latest.result.stub;
      repair++
    ) {
      logger.warn("Generated code failed validation, attempting self-repair", {
        lang: detectedLang,
        attempt: repair,
        problems: latest.validation.problems,
      });

      const feedback = {
        role: "user",
        content:
          `The code you just returned failed validation: ${latest.validation.problems.join("; ")}. ` +
          "Regenerate the COMPLETE corrected code from scratch, fixing every listed problem. " +
          "Return ONLY the corrected code. No explanations, no markdown.",
      };

      latest = await attempt([...conversation, feedback]);
      conversation = [
        ...conversation,
        feedback,
        { role: "assistant", content: latest.result.content },
      ];

      // First passing result wins outright; otherwise keep whichever
      // attempt has fewer problems as the best-so-far.
      if (
        latest.validation.valid ||
        latest.validation.problems.length < best.validation.problems.length
      ) {
        best = latest;
        repaired = true;
      }
    }

    return {
      finalCode: best.code,
      usage: best.result.usage,
      model: best.result.model,
      provider: best.result.provider || "groq",
      stub: !!best.result.stub,
      validation: best.validation,
      repaired,
    };
  } finally {
    release();
  }
}

async function generateCode(req, res) {
  const requestId = uuidv4();

  const prompt = req.codePrompt;
  const userFilename = req.codeFilename || "";
  const explicitLang = req.codeLang;

  const detectedLang =
    explicitLang || detectLanguage(prompt, userFilename);

  // Java class naming has two halves:
  // - REQUESTED name: terminal users never send a filename, so for Java
  //   with no explicit filename we derive one from the problem ("write
  //   binary search" -> "BinarySearch") and the user prompt ASKS the
  //   model to use it as its public class name. An explicit user
  //   filename always wins.
  // - RESPONSE filename (X-Filename): derived from the generated code
  //   itself — the class that actually contains main() — never the
  //   reverse. The server does not rename classes in generated code
  //   (see javaFixer.js and FIXES.md section G), so the filename
  //   follows whatever the model actually wrote.
  const requestedFilename =
    detectedLang === "java" && !userFilename
      ? deriveClassName(prompt) + ".java"
      : userFilename;

  // The cache key must be computable BEFORE generation, so it is built
  // from the prompt + the user's filename (or none) + language — never
  // from the code-derived response filename.
  const cacheKey = buildCacheKey(prompt, userFilename || null, detectedLang);

  const responseFilenameFor = (code) => {
    if (userFilename) return userFilename;
    if (detectedLang === "java") {
      return resolveJavaFileBase(code, prompt) + ".java";
    }
    return "";
  };

  const cached = getFromCache(cacheKey);

  if (cached) {
    logger.info("Cache hit", { requestId, lang: detectedLang });

    res.setHeader("X-Cache", "HIT");
    res.setHeader("X-Language", detectedLang);
    const hitFilename = responseFilenameFor(cached);
    if (hitFilename) res.setHeader("X-Filename", hitFilename);
    res.setHeader("X-Request-Id", requestId);

    return res.status(200).type("text/plain").send(cached);
  }

  logger.info("Generating code", {
    requestId,
    lang: detectedLang,
    filename: requestedFilename,
  });

  try {
    // Coalesce concurrent identical requests onto one upstream call.
    let shared = inFlight.get(cacheKey);
    if (!shared) {
      shared = runUpstream(prompt, requestedFilename, detectedLang)
        .then((result) => {
          // Only validated code may enter the cache. (Coalescing
          // follows the same rule: waiters on an invalid result all
          // get the GENERATION_INVALID error below, and nothing is
          // stored for the next identical request.)
          if (result.validation?.valid) {
            setInCache(cacheKey, result.finalCode);
          }
          return result;
        })
        .finally(() => {
          inFlight.delete(cacheKey);
        });
      inFlight.set(cacheKey, shared);
    }

    const { finalCode, usage, model, provider, stub, validation, repaired } =
      await shared;

    // Never serve known-broken code: if the initial attempt and every
    // repair failed validation, the question gets an honest typed
    // error instead of code that cannot compile.
    if (!validation?.valid) {
      logger.warn("Generation failed validation after all attempts; refusing to serve", {
        requestId,
        lang: detectedLang,
        problems: validation?.problems,
      });
      return res.status(502).json({
        error:
          "Couldn't generate valid code for this question — " +
          "please ask again or rephrase.",
        code: "GENERATION_INVALID",
        problems: validation?.problems || [],
        requestId,
      });
    }

    logger.info("Code generated", {
      requestId,
      lang: detectedLang,
      model,
      provider,
      tokens: usage?.total_tokens,
      stub,
      validation: "passed",
      repaired,
    });

    res.setHeader("X-Cache", "MISS");
    res.setHeader("X-Language", detectedLang);
    const responseFilename = responseFilenameFor(finalCode);
    if (responseFilename) res.setHeader("X-Filename", responseFilename);
    res.setHeader("X-Model", model);
    res.setHeader("X-Provider", provider);
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Tokens-Used", usage?.total_tokens || 0);
    res.setHeader("X-Validation", "passed");
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
// TEST SEAM (tests only): substitute the provider caller. See the
// declaration near the top of this file.
module.exports.setCallAIForTests = setCallAIForTests;