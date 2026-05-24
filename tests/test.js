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

console.log(`\n=============================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`=============================\n`);

if (failed > 0) process.exit(1);
