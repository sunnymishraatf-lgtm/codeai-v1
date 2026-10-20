process.env.NODE_ENV = "test";
process.env.GROQ_API_KEY = "test-key";
process.env.API_SECRET_KEY = "";

const assert = require("assert");
const { detectLanguage, getClassName } = require("../src/utils/langDetect");
const { buildCacheKey, getFromCache, setInCache, flushCache } = require("../src/utils/cache");
const { cleanCode } = require("../src/utils/codeCleaner");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log("\n=== Language Detection Tests ===");
test("detects java from prompt", () => {
  assert.strictEqual(detectLanguage("wap in java to print fibonacci", null), "java");
});
test("detects python from prompt", () => {
  assert.strictEqual(detectLanguage("binary search in python", null), "python");
});
test("detects cpp from prompt", () => {
  assert.strictEqual(detectLanguage("dijkstra in c++", null), "cpp");
});
test("detects java from filename", () => {
  assert.strictEqual(detectLanguage("anything", "Hello.java"), "java");
});
test("detects python from filename", () => {
  assert.strictEqual(detectLanguage("anything", "solution.py"), "python");
});
test("returns auto for unknown", () => {
  assert.strictEqual(detectLanguage("something random", null), "auto");
});
test("getClassName returns Main for null", () => {
  assert.strictEqual(getClassName(null), "Main");
});
test("getClassName strips extension", () => {
  assert.strictEqual(getClassName("hello.java"), "Hello");
});

console.log("\n=== Cache Tests ===");
test("cache miss returns null", () => {
  flushCache();
  const key = buildCacheKey("test prompt", null, "python");
  assert.strictEqual(getFromCache(key), null);
});
test("cache stores and retrieves", () => {
  flushCache();
  const key = buildCacheKey("fib in java", null, "java");
  setInCache(key, "public class Main {}");
  assert.strictEqual(getFromCache(key), "public class Main {}");
});
test("cache keys differ by language", () => {
  const k1 = buildCacheKey("test", null, "java");
  const k2 = buildCacheKey("test", null, "python");
  assert.notStrictEqual(k1, k2);
});
test("cache keys differ by filename", () => {
  const k1 = buildCacheKey("test", "a.java", "java");
  const k2 = buildCacheKey("test", "b.java", "java");
  assert.notStrictEqual(k1, k2);
});

console.log("\n=== Code Cleaner Tests ===");
test("strips triple backtick fences", () => {
  const raw = "```java\npublic class Main {}\n```";
  assert.strictEqual(cleanCode(raw), "public class Main {}");
});
test("strips python fences", () => {
  const raw = "```python\nprint('hello')\n```";
  assert.strictEqual(cleanCode(raw), "print('hello')");
});
test("handles code with no fences", () => {
  const raw = "public class Main {}";
  assert.strictEqual(cleanCode(raw), "public class Main {}");
});
test("removes preamble text", () => {
  const raw = "Here is the code:\n\npublic class Main {}";
  const result = cleanCode(raw);
  assert(!result.toLowerCase().startsWith("here"), "Should remove preamble");
});
test("handles empty string", () => {
  assert.strictEqual(cleanCode(""), "");
});
test("handles null", () => {
  assert.strictEqual(cleanCode(null), "");
});

console.log("\n=== C / JavaScript Detection Regression Tests ===");
const { normalizeLanguage } = require("../src/utils/langDetect");
test("detects plain c from 'in c'", () => {
  assert.strictEqual(detectLanguage("write a program in c to add two numbers", null), "c");
});
test("detects plain c from 'binary search in c'", () => {
  assert.strictEqual(detectLanguage("binary search in c", null), "c");
});
test("detects plain c from 'c program'", () => {
  assert.strictEqual(detectLanguage("c program to reverse a string", null), "c");
});
test("detects c from .c filename", () => {
  assert.strictEqual(detectLanguage("anything", "main.c"), "c");
});
test("javascript is NOT misdetected as java", () => {
  assert.strictEqual(detectLanguage("write a javascript program to sort an array", null), "javascript");
  assert.strictEqual(detectLanguage("javascript fetch example", null), "javascript");
});
test("c++ still wins over plain c", () => {
  assert.strictEqual(detectLanguage("merge sort in c++", null), "cpp");
});
test("c# still wins over plain c", () => {
  assert.strictEqual(detectLanguage("hello world in c#", null), "csharp");
});
test("normalizeLanguage maps aliases", () => {
  assert.strictEqual(normalizeLanguage("py"), "python");
  assert.strictEqual(normalizeLanguage("C++"), "cpp");
  assert.strictEqual(normalizeLanguage("js"), "javascript");
  assert.strictEqual(normalizeLanguage("java"), "java");
  assert.strictEqual(normalizeLanguage("c"), "c");
});

console.log("\n=== Per-Language Cleaner Tests ===");
test("C output keeps #include lines", () => {
  const raw = "```c\n#include <stdio.h>\nint main(void) { return 0; }\n```";
  const out = cleanCode(raw, "c");
  assert(out.includes("#include <stdio.h>"), "must keep #include");
  assert(out.includes("int main"), "must keep main");
});
test("Java output keeps imports and public class", () => {
  const raw = "```java\nimport java.util.Scanner;\npublic class Main { public static void main(String[] args) {} }\n```";
  const out = cleanCode(raw, "java");
  assert(out.includes("import java.util.Scanner;"), "must keep import");
  assert(out.includes("public class Main"), "must keep class");
});
test("Python indentation is preserved exactly", () => {
  const raw = "```python\ndef f():\n    if True:\n        return 1\n    return 0\n```";
  const out = cleanCode(raw, "python");
  assert(out.includes("\n        return 1"), "8-space indent must survive");
  assert(out.includes("\n    return 0"), "4-space indent must survive");
});

console.log("\n=== Class Name Derivation Tests ===");
const { deriveClassName } = require("../src/utils/className");
test("'write binary search' -> BinarySearch", () => {
  assert.strictEqual(deriveClassName("write binary search"), "BinarySearch");
});
test("'binary search in java' -> BinarySearch", () => {
  assert.strictEqual(deriveClassName("binary search in java"), "BinarySearch");
});
test("'check palindrome' -> CheckPalindrome", () => {
  assert.strictEqual(deriveClassName("check palindrome"), "CheckPalindrome");
});
test("'fibonacci series' -> FibonacciSeries", () => {
  assert.strictEqual(deriveClassName("fibonacci series"), "FibonacciSeries");
});
test("'reverse a linked list' -> ReverseLinkedList", () => {
  assert.strictEqual(deriveClassName("reverse a linked list"), "ReverseLinkedList");
});
test("'bubble sort' -> BubbleSort", () => {
  assert.strictEqual(deriveClassName("bubble sort"), "BubbleSort");
});
test("empty prompt -> Solution (never Main)", () => {
  assert.strictEqual(deriveClassName(""), "Solution");
  assert.strictEqual(deriveClassName(null), "Solution");
  assert.strictEqual(deriveClassName("write a program in java"), "Solution");
});
test("digit-leading name gets Program prefix", () => {
  const name = deriveClassName("2 sum problem");
  assert(!/^\d/.test(name), "must not start with a digit");
  assert(name.startsWith("Program"), "digit-leading names are prefixed");
});
test("derived name is capped and valid", () => {
  const name = deriveClassName("implement a very efficient algorithm for finding the kth smallest element in an unsorted array quickly");
  assert(name.length <= 40 + "Program".length, "length capped");
  assert(/^[A-Z][A-Za-z0-9]*$/.test(name), "valid class identifier");
});

console.log("\n=== Code Validator Tests ===");
const { validateCode } = require("../src/utils/codeValidator");
test("valid C passes", () => {
  const r = validateCode("#include <stdio.h>\nint main(void) { printf(\"hi\"); return 0; }", "c");
  assert.strictEqual(r.valid, true, JSON.stringify(r.problems));
});
test("C without main fails", () => {
  const r = validateCode("#include <stdio.h>\nint add(int a, int b) { return a + b; }", "c");
  assert.strictEqual(r.valid, false);
});
test("C with unbalanced braces fails", () => {
  const r = validateCode("#include <stdio.h>\nint main(void) { return 0;", "c");
  assert.strictEqual(r.valid, false);
});
test("valid Java passes", () => {
  const r = validateCode("public class Main { public static void main(String[] args) {} }", "java");
  assert.strictEqual(r.valid, true, JSON.stringify(r.problems));
});
test("Java without main fails", () => {
  const r = validateCode("public class Main { int x; }", "java");
  assert.strictEqual(r.valid, false);
});
test("valid Python passes", () => {
  const r = validateCode("def f():\n    return [1, 2, (3, 4)]\n", "python");
  assert.strictEqual(r.valid, true, JSON.stringify(r.problems));
});
test("Python with mixed tabs/spaces fails", () => {
  const r = validateCode("def f():\n\treturn 1\ndef g():\n    return 2\n", "python");
  assert.strictEqual(r.valid, false);
});
test("empty code fails", () => {
  assert.strictEqual(validateCode("", "python").valid, false);
});

console.log("\n=== Concurrency Semaphore Tests ===");
const { Semaphore } = require("../src/utils/concurrency");
test("semaphore never exceeds max concurrent", async () => {
  // Covered properly in the async section below; this is a placeholder
  // guard so the sync harness structure stays unchanged.
  assert.strictEqual(typeof Semaphore, "function");
});

console.log(`\n=============================`);
console.log(`Results (sync): ${passed} passed, ${failed} failed`);
console.log(`=============================\n`);

// ---------------------------------------------------------------------------
// Async tests (failover chain + semaphore) with clearly-labeled stubs.
// These stubs are TEST ONLY — they are not real AI responses.
// ---------------------------------------------------------------------------
(async () => {
  const { createProviderChain } = require("../src/utils/aiProvider");
  let aPassed = 0;
  let aFailed = 0;

  async function atest(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      aPassed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      aFailed++;
    }
  }

  console.log("=== Provider Failover Tests (stubbed providers, TEST ONLY) ===");
  await atest("Groq success -> provider=groq, NVIDIA untouched", async () => {
    let nvidiaCalled = false;
    const chain = createProviderChain({
      groqConfigured: () => true,
      nvidiaConfigured: () => true,
      stubMode: () => false,
      groqCall: async () => ({ content: "code", usage: {}, model: "g" }),
      nvidiaCall: async () => {
        nvidiaCalled = true;
        return { content: "n", usage: {}, model: "n" };
      },
    });
    const r = await chain.callAI([], {});
    assert.strictEqual(r.provider, "groq");
    assert.strictEqual(nvidiaCalled, false);
  });
  await atest("Groq throws -> NVIDIA stub answers, provider=nvidia", async () => {
    const chain = createProviderChain({
      groqConfigured: () => true,
      nvidiaConfigured: () => true,
      stubMode: () => false,
      groqCall: async () => {
        const e = new Error("groq down");
        e.status = 503;
        throw e;
      },
      nvidiaCall: async () => ({ content: "nv code", usage: {}, model: "nv" }),
    });
    const r = await chain.callAI([], {});
    assert.strictEqual(r.provider, "nvidia");
    assert.strictEqual(r.content, "nv code");
  });
  await atest("Groq missing, NVIDIA configured -> NVIDIA used directly", async () => {
    const chain = createProviderChain({
      groqConfigured: () => false,
      nvidiaConfigured: () => true,
      stubMode: () => false,
      groqCall: async () => {
        throw new Error("must not be called");
      },
      nvidiaCall: async () => ({ content: "nv", usage: {}, model: "nv" }),
    });
    const r = await chain.callAI([], {});
    assert.strictEqual(r.provider, "nvidia");
  });
  await atest("both providers throw -> ALL_PROVIDERS_FAILED with both reasons", async () => {
    const chain = createProviderChain({
      groqConfigured: () => true,
      nvidiaConfigured: () => true,
      stubMode: () => false,
      groqCall: async () => {
        throw new Error("groq boom");
      },
      nvidiaCall: async () => {
        throw new Error("nvidia boom");
      },
    });
    await assert.rejects(
      () => chain.callAI([], {}),
      (err) =>
        err.code === "ALL_PROVIDERS_FAILED" &&
        err.message.includes("groq boom") &&
        err.message.includes("nvidia boom")
    );
  });
  await atest("no providers configured -> MISSING_API_KEY", async () => {
    const chain = createProviderChain({
      groqConfigured: () => false,
      nvidiaConfigured: () => false,
      stubMode: () => false,
      groqCall: async () => ({}),
      nvidiaCall: async () => ({}),
    });
    await assert.rejects(
      () => chain.callAI([], {}),
      (err) => err.code === "MISSING_API_KEY"
    );
  });
  await atest("NVIDIA default is Nemotron Ultra (live-verified), fallbacks are the other live-verified models", async () => {
    const { candidateModels, NVIDIA_MODELS, isModelNotFound } = require("../src/utils/nvidiaClient");
    delete process.env.NVIDIA_MODEL;
    const models = candidateModels();
    // Live-verified with Sunny's real key on 2026-10-20: Nemotron
    // Ultra returned correct C code, gpt-oss-20b correct Python code,
    // gemma-4 answered. The old NEUTRON catalog models failed live
    // (410/410/404) and are excluded from the chain.
    assert.strictEqual(models[0], "nvidia/nemotron-3-ultra-550b-a55b");
    assert.deepStrictEqual(NVIDIA_MODELS, [
      "nvidia/nemotron-3-ultra-550b-a55b",
      "openai/gpt-oss-20b",
      "google/gemma-4-31b-it",
    ]);
    for (const m of NVIDIA_MODELS) assert(models.includes(m), `missing ${m}`);
    assert.strictEqual(isModelNotFound({ status: 404 }), true);
    assert.strictEqual(isModelNotFound({ status: 410 }), true);
    assert.strictEqual(isModelNotFound({ status: 500 }), false);
  });

  console.log("\n=== Groq Model Fallback Tests (labeled stubs, TEST ONLY) ===");
  await atest("Groq candidate list defaults to gpt-oss-120b chain", async () => {
    const { candidateModels } = require("../src/utils/groqClient");
    delete process.env.MODEL;
    delete process.env.GROQ_MODELS;
    assert.deepStrictEqual(candidateModels({}), [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "qwen/qwen3-32b",
    ]);
    process.env.MODEL = "custom/model-x";
    assert.strictEqual(candidateModels({})[0], "custom/model-x");
    delete process.env.MODEL;
  });
  await atest("Groq: GROQ_MODELS env replaces the fallback list", async () => {
    const { candidateModels } = require("../src/utils/groqClient");
    delete process.env.MODEL;
    process.env.GROQ_MODELS = "custom/one, custom/two";
    try {
      assert.deepStrictEqual(candidateModels({}), ["custom/one", "custom/two"]);
    } finally {
      delete process.env.GROQ_MODELS;
    }
  });
  await atest("Groq: isModelNotFound only matches 404 model_not_found", async () => {
    const { isModelNotFound } = require("../src/utils/groqClient");
    const e404 = new Error("The model `x` does not exist or you do not have access to it.");
    e404.status = 404;
    e404.code = "model_not_found";
    assert.strictEqual(isModelNotFound(e404), true);
    assert.strictEqual(isModelNotFound({ status: 404, message: "plain not found" }), false);
    assert.strictEqual(isModelNotFound({ status: 429, code: "model_not_found" }), false);
    assert.strictEqual(isModelNotFound({ status: 500 }), false);
  });
  await atest("Groq: first model model_not_found -> second model answers", async () => {
    const { callGroqWithRetry } = require("../src/utils/groqClient");
    delete process.env.MODEL;
    delete process.env.GROQ_MODELS;
    const tried = [];
    // TEST STUB (labeled fake): simulates Groq answering 404
    // model_not_found for the first candidate and success for the next.
    const createCompletion = async ({ model }) => {
      tried.push(model);
      if (model === "openai/gpt-oss-120b") {
        const e = new Error(
          "The model `openai/gpt-oss-120b` does not exist or you do not have access to it."
        );
        e.status = 404;
        e.code = "model_not_found";
        throw e;
      }
      return {
        choices: [{ message: { content: "code-from-" + model } }],
        usage: { total_tokens: 1 },
      };
    };
    const r = await callGroqWithRetry(
      [{ role: "user", content: "x" }],
      {},
      3,
      { createCompletion }
    );
    assert.strictEqual(r.model, "openai/gpt-oss-20b");
    assert.strictEqual(r.content, "code-from-openai/gpt-oss-20b");
    assert.deepStrictEqual(tried, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });
  await atest("Groq: non-model error does NOT cycle models", async () => {
    const { callGroqWithRetry } = require("../src/utils/groqClient");
    delete process.env.MODEL;
    delete process.env.GROQ_MODELS;
    const tried = [];
    // TEST STUB (labeled fake): a 401 auth error must surface at once.
    const createCompletion = async ({ model }) => {
      tried.push(model);
      const e = new Error("Invalid API Key");
      e.status = 401;
      throw e;
    };
    await assert.rejects(
      () => callGroqWithRetry([{ role: "user", content: "x" }], {}, 3, { createCompletion }),
      (err) => err.status === 401
    );
    assert.deepStrictEqual(tried, ["openai/gpt-oss-120b"]);
  });

  console.log("\n=== Stub-Mode End-to-End Naming Test (TEST ONLY) ===");
  await atest("GET /api?q=write+binary+search&lang=java -> BinarySearch class + X-Filename (stub mode)", async () => {
    process.env.CODEAI_TEST_STUB = "1";
    process.env.PORT = "3217";
    const { server } = require("../src/server");
    try {
      const res = await fetch(
        "http://127.0.0.1:3217/api?q=" +
          encodeURIComponent("write binary search") +
          "&lang=java"
      );
      const body = await res.text();
      assert.strictEqual(res.status, 200, body.slice(0, 200));
      assert.strictEqual(res.headers.get("x-test-stub"), "1");
      assert.strictEqual(res.headers.get("x-filename"), "BinarySearch.java");
      assert(
        body.includes("public class BinarySearch"),
        "expected derived class name in code, got: " + body.slice(0, 160)
      );
    } finally {
      delete process.env.CODEAI_TEST_STUB;
      server.close();
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    }
  });

  console.log("\n=== Semaphore Behavior Tests ===");
  await atest("at most N tasks run concurrently, rest queue", async () => {
    const sem = new Semaphore(2, 5000);
    let running = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      release();
    };
    await Promise.all([task(), task(), task(), task(), task()]);
    assert.strictEqual(peak, 2);
  });
  await atest("queue timeout rejects with QUEUE_TIMEOUT", async () => {
    const sem = new Semaphore(1, 60);
    const release = await sem.acquire();
    await assert.rejects(
      () => sem.acquire(),
      (err) => err.code === "QUEUE_TIMEOUT" && err.status === 503
    );
    release();
  });

  console.log(`\n=============================`);
  console.log(
    `Results (total): ${passed + aPassed} passed, ${failed + aFailed} failed`
  );
  console.log(`=============================\n`);

  // Explicit exit: the stub e2e test boots the real server (and its
  // cache timers) inside this process, so don't rely on a natural exit.
  process.exit(failed + aFailed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Async test runner crashed:", err);
  process.exit(1);
});
