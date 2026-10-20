# FIXES.md — codeai-v1 repair report

All work was additive: no existing routes, files, or features were
removed. Verified locally on Node 24, gcc 13.3, Python 3.12, javac 21.

---

## A. Proven bugs (reproduced first-hand) and their fixes

### 1. Plain C was never detected — prompts fell through to "auto"
- **Evidence:** `detectLanguage("binary search in c")` → `"auto"`;
  `"write a program in c to add two numbers"` → `"auto"`;
  `"c program to reverse a string"` → `"auto"`. `langDetect.js` had a
  `.c` extension mapping but **no C keyword rule at all**.
- **Fix:** rewrote detection with word-boundary matching and added a
  plain-C rule, ordered **after** C++/C# so they still win
  (`src/utils/langDetect.js`). Added `normalizeLanguage()` for explicit
  `lang` params (aliases: `py`, `js`, `ts`, `c++`, `c#`, `golang`, …),
  now applied in `src/middleware/validator.js`.

### 2. Every JavaScript prompt was misdetected as Java
- **Evidence:** `detectLanguage("javascript fetch example")` → `"java"`;
  `"write a javascript program to sort an array"` → `"java"`. Cause:
  substring matching — `"javascript"` contains `"java"`, and the Java
  rule ran first.
- **Fix:** word tokens now match with `\b` boundaries (`\bjava\b` does
  not match inside "javascript"). Regression tests added.

### 3. Decommissioned model name reported by health/startup logs
- **Evidence:** `GET /api/health` returned `"model":"llama3-70b-8192"`
  and the startup log printed the same, while `groqClient.js` actually
  called `llama-3.3-70b-versatile`. `llama3-70b-8192` is decommissioned;
  README also documented it as the default, so anyone setting `MODEL`
  from the README would break generation.
- **Fix:** default unified to `llama-3.3-70b-versatile` in
  `src/server.js`, `src/routes/admin.js`, README, `.env.example`.

### 4. `.env.example` referenced everywhere but missing from the repo
- **Evidence:** README Quick Start says `cp .env.example .env` and the
  project-structure diagram lists it; the file did not exist.
- **Fix:** created `.env.example` covering every env var the code reads.

### 5. Cache was dead code — every request hit the AI provider
- **Evidence:** in `src/routes/generate.js` the cache lookup and the
  `setInCache` call were commented out; `X-Cache` was hardcoded `MISS`.
- **Fix:** cache restored (lookup before generation, store after),
  which the classroom coalescing (section B) builds on.

### 6. Missing Groq key produced a misleading error
- **Evidence:** with no `GROQ_API_KEY`, `POST /generate` returned
  `502 {"error":"Code generation service unavailable."}` — nothing told
  the operator the server was simply not configured.
- **Fix:** a typed `MISSING_API_KEY` error now returns HTTP 500 with an
  explicit message naming the env vars to set (see section B for the
  two-provider wording).

### 7. Groq client silently ignored the route's sampling options
- **Evidence:** `generate.js` passes `temperature: 0.05, top_p: 0.8`
  but `groqClient.js` hardcoded `temperature: 0.1` and never sent
  `top_p`.
- **Fix:** client now honors `options.temperature` / `options.top_p`,
  and retries `APIConnectionError`s in addition to 429/502/503.

### 8. Sunny's terminal pattern 404'd: `GET /api?q=...&lang=...`
- **Evidence:** `curl "http://localhost:3101/api?q=write+binary+search&lang=java"`
  → `404 {"error":"Route not found: GET /api"}`.
- **Fix:** the generate router is now also mounted at `/api` (after the
  admin router, so `/api/health`, `/api/stats`, `/api/cache/flush` are
  unchanged). `GET /api?q=...&lang=...` returns plain-text code with
  the same validation, cache, and rate limiting. Documented in README
  and in the root endpoint listing.

## B. Requested changes & additions (not bugs)

### Limits raised (Sunny's request, final classroom values)
| Setting | Old | New | Where |
|---|---|---|---|
| Global rate limit | 30/min per IP | **1000/min per IP** | `RATE_LIMIT_MAX` |
| Generate rate limit | 20/min per IP | **500/min per IP** | `GENERATE_RATE_LIMIT` |
| `MAX_TOKENS` default | 4096 | **8192** | `groqClient.js` / `nvidiaClient.js` |
| Max prompt length | 5000 chars | **10000 chars** | `validator.js` |

High per-IP limits are deliberate: a class of 50+ students shares one
public IP behind college Wi-Fi NAT, so low per-IP limits would block
everyone. All values remain env-overridable.

### Classroom concurrency (Sunny's request: 50+ simultaneous students)
- **Concurrency semaphore** (`src/utils/concurrency.js`): max
  `MAX_CONCURRENT_AI` (default 10) AI requests at once — one shared
  queue wrapping **both** providers. Extra requests wait up to
  `QUEUE_TIMEOUT_MS` (default 30000), then get a friendly HTTP 503
  ("Server busy… try again in a few seconds"), never a crash or hang.
- **Request coalescing:** concurrent identical question+language
  requests share one upstream call (in-flight map in `generate.js`),
  on top of the restored cache. Cache keys are provider-agnostic.
- **Load evidence** (local, TEST STUB mode — labeled fake responses,
  `X-Test-Stub: 1`, never presented as AI output):
  - 50 concurrent requests (30 identical + 20 distinct): **50× HTTP
    200 in 951ms**, upstream stub called only **21 times** (1 for the
    30 identical + 20 distinct) — coalescing proven; repeat request
    returned `X-Cache: HIT`.
  - Queue test (`MAX_CONCURRENT_AI=2`, `QUEUE_TIMEOUT_MS=400`, 2s
    stub delay, 6 distinct concurrent): **2× 200, 4× friendly 503**,
    server healthy afterwards.
  - No-key burst: **50 concurrent → 50× clean HTTP 500** config error
    in 178ms, no hangs; health stayed 200. No unhandled errors in any
    server log.

### NVIDIA backup provider (Sunny's request, aligned with NEUTRON)
- Failover chain (`src/utils/aiProvider.js`): **Groq → NVIDIA →
  honest combined error** (`ALL_PROVIDERS_FAILED`, HTTP 502, both
  reasons included, no secrets). Self-repair retries go through the
  same chain, so they apply to whichever provider answered.
- `src/utils/nvidiaClient.js`: OpenAI-compatible POST to
  `https://integrate.api.nvidia.com/v1/chat/completions`, Bearer auth
  from `NVIDIA_API_KEY` env only (never logged). Base URL aligned with
  NEUTRON's provider catalog (`~/workspace/neutron-agent/agent/src/
  providers/catalog.ts`).
- **Model correction (live-tested 2026-10-20 with Sunny's real key,
  by the parent agent):** NVIDIA rotates/retires models and ALL THREE
  NEUTRON catalog models fail live — `meta/llama-3.3-70b-instruct` →
  410 Gone, `nvidia/llama-3.3-nemotron-super-49b-v1` → 410 Gone,
  `meta/llama-3.1-70b-instruct` → 404 (several other listed models
  404 too). Sunny clarified the backup should be NVIDIA's **Nemotron**
  family ("use neutron" = Nemotron — not the NEUTRON project). The
  current Nemotron verified WORKING live, returning a correct C
  program, is **`nvidia/nemotron-3-ultra-550b-a55b`** — it is the
  default (`NVIDIA_MODEL` overridable). Fallback chain (all
  live-tested 2026-10-20): `[nemotron-3-ultra-550b-a55b,
  openai/gpt-oss-20b (correct Python code), google/gemma-4-31b-it
  (answered)]`. The old catalog models are excluded (410/404 dead),
  and the model-fallback matcher treats **410 Gone as well as 404**
  as "try the next model".
- Health now reports `providers: { groq: bool, nvidia: bool }`
  (booleans only). Responses carry `X-Provider: groq|nvidia`.
- Failover is unit-tested with labeled stubs (Groq throws → NVIDIA
  answers; both throw → combined error; none configured →
  MISSING_API_KEY). The NVIDIA endpoint + default model were verified
  live by the parent agent with Sunny's real key on 2026-10-20 (see
  the model correction above); **this app's own NVIDIA client code
  remains stub-tested locally** — the sandbox here cannot reach the
  API directly.

### Generated-code quality (Sunny's bar: "every code should work")
- `src/utils/codeValidator.js`: structural checks per language —
  C: `#include` + `main` + balanced delimiters; Java: public class +
  `main` + balanced delimiters; Python: balanced brackets +
  tab/space indentation sanity.
- **Self-repair loop** in the generate route: failed validation →
  one retry with the problems fed back to the provider → the better
  result wins. Outcome is exposed via `X-Validation` (and
  `X-Repaired` when a repair was used) headers.
- `systemPrompt.js` gained explicit C (C11, headers, `int main`,
  return 0) and Python (idiomatic, no forced class, 4-space indent)
  rules; `generate.js` gained matching per-language user prompts for
  C and Python. Java still goes through `javaFixer` (post-processing
  only ever runs `javaFixer` for Java — C/Python output is untouched
  by it, verified in code and by the compile suite).

## C. Verification evidence

- `npm test`: **46 passed, 0 failed** (18 original + 28 new: C/JS
  detection regressions, aliases, per-language cleaning, validator,
  failover, semaphore).
- `npm run verify` (gcc 13.3, Python 3.12, **javac 21.0.12.1** —
  installed via `apt-get install -y default-jdk-headless`): 6 classic
  problems × C/Java/Python, messy labeled fixtures pushed through the
  app's own cleaner/fixer/validator, then really compiled and run —
  **18/18 PASS**, stdout asserted (binary search → `3`, fibonacci →
  `0 1 1 2 3 5 8 13 21 34`, palindrome → `palindrome`, factorial →
  `120`, prime → `prime`, bubble sort → `1 2 5 7 9`).
- Live curl checks (fixed server, no keys): root 200, health 200 with
  correct model + provider booleans, `POST /generate` → clean 500
  config error, `GET /api?q=...&lang=java` → clean 500 (was 404),
  missing prompt → 400.
- README note: the README contains no literal sample AI outputs
  (outputs depend on the live provider), so there was no README code
  to compile-check; the canonical verified examples live in
  `tests/compile-check.js` and are proven by `npm run verify`.

## D. Honest gaps

- **No live AI generation was verified through this app.** This
  sandbox cannot reach api.groq.com (dummy key → SDK "Connection
  error"). Separately, the parent agent verified the NVIDIA chat path
  live with Sunny's real key on 2026-10-20 (`nemotron-3-ultra`
  returned correct C code, `gpt-oss-20b` correct Python code) — but
  that was a direct API test, not a call
  through this app's client. The app's full pipeline (validation,
  self-repair, failover, coalescing) is proven with clearly-labeled
  stubs/fixtures and compile/run checks of fixture code only. First
  end-to-end run with real keys in the app's `.env` is the remaining
  check.
- Java compilation **was** verified in the end (JDK installed
  successfully during this session).
- Suspicion, not proven: the Groq SDK `^0.3.3` is old; it installed
  and constructed fine here, but a future major SDK bump is worth
  reviewing with a real key in hand.

## E. Post-deploy finishing touches (2026-10-20, after the live deploy)

Two more fixes, both found/proven AFTER the service went live on
Render (https://codeai-v1-35ul.onrender.com). Additive only; the full
test suite grew from 46 to 61 tests, all green, and `npm run verify`
still passes 18/18.

### E1. Groq default model was dead for free keys — new default + fallback
- **Live evidence:** the deployed app, using Sunny's real (free) Groq
  key, answered every generation request with Groq's
  `404 model_not_found` for `llama-3.3-70b-versatile` ("does not exist
  or you do not have access to it"). Groq had moved Llama 3.3 70B (and
  Llama 3.1 8B) to enterprise-only "contact sales" pricing on
  2026-08-26. Setting `MODEL=openai/gpt-oss-120b` in the Render env
  immediately restored real answers (Java/C/Python verified live,
  compiled and run) — but the CODE default still pointed at the dead
  model, so any fresh setup without that env rescue would break again.
- **Fix:** default changed to `openai/gpt-oss-120b` everywhere it
  appears (`groqClient.js`, `server.js`, `admin.js` health,
  `.env.example`, README, `render.yaml`).
- **Fallback added** (`groqClient.js`, mirroring the NVIDIA client):
  candidates are `[options.model || MODEL || openai/gpt-oss-120b,
  openai/gpt-oss-20b, meta-llama/llama-4-scout-17b-16e-instruct,
  qwen/qwen3-32b]` (deduped). Only a genuine `model_not_found`
  (HTTP 404 with code `model_not_found` / "does not exist" message)
  advances to the next model; 429/502/503/connection errors keep the
  existing per-model retry-with-backoff, and other errors surface
  immediately without cycling models. `GROQ_MODELS` (comma-separated)
  replaces the built-in fallback list when set.
- **Tests (labeled stubs):** candidate-list defaults + `MODEL`
  precedence, `GROQ_MODELS` replacement, strict `isModelNotFound`
  matching, first-model-404 → second-model-answers, 401 does NOT cycle
  models (exactly one attempt).

### E2. Every Java answer used class "Main" — problem-specific naming
- **Root cause:** `systemPrompt.js` RULE 5 said "if filename missing
  → use Main", `javaFixer.js` defaulted the class name to "Main" when
  no filename was given — and terminal (curl) users never send a
  filename, so every student's file was `Main.java` with
  `public class Main`, and every program had to be renamed by hand
  before `javac` would accept the obvious filename.
- **Fix:** new `src/utils/className.js` — `deriveClassName(prompt)`
  strips request filler and language words, PascalCases the remaining
  problem words (max ~4 words / 40 chars, digit-leading names get a
  `Program` prefix), and falls back to `Solution`, never `Main`.
  Examples: "write binary search" → `BinarySearch`, "check
  palindrome" → `CheckPalindrome`, "fibonacci series" →
  `FibonacciSeries`, "reverse a linked list" → `ReverseLinkedList`,
  "bubble sort" → `BubbleSort`, "" → `Solution`.
- **Wiring:** in the generate route (shared by `POST /generate`,
  `GET /generate`, and the `GET /api` mount), a Java request with no
  explicit filename gets `filename = deriveClassName(prompt) + ".java"`,
  which flows through the existing user-prompt construction and
  `javaFixer` (so the class is renamed properly), and the response
  sets **`X-Filename: <Name>.java`** so terminal users know what to
  save the file as. An explicit user filename always wins.
- **Prompt rules:** RULE 5 rewritten — the public class must match
  the provided filename; with no filename it must be named after the
  problem, never a bare `Main` (unless literally asked for). New
  RULE 13 for ALL languages: functions/methods are named after the
  task (`binarySearch`, `is_palindrome`, `fibonacci_series`,
  `isPalindrome`), never `solve()`/`func()`/`myFunction()`, and
  `main()` demonstrates usage with a small example.
- **Tests:** 9 derivation cases + a stub-mode end-to-end test:
  `GET /api?q=write+binary+search&lang=java` (TEST STUB) returns code
  containing `public class BinarySearch` and header
  `X-Filename: BinarySearch.java`. The compile/run harness already
  used per-problem derived filenames, so it needed no weakening —
  still 18/18.

---

## E. Plan C (post-deploy addition, 2026-10-20)

Sunny's request: add a **second Groq API key** as a reserve, so when the
primary Groq key reaches its limit the app still has another engine.
The failover chain is now three legs, in Sunny's stated order:

- **Plan A:** Groq, primary key (`GROQ_API_KEY`)
- **Plan B:** NVIDIA NIM (`NVIDIA_API_KEY`, Nemotron)
- **Plan C:** Groq, second key (`GROQ_API_KEY_2`) — tried only when it
  is set AND both Plan A and Plan B have failed; skipped silently
  otherwise. Serving leg reported as `X-Provider: groq | nvidia | groq2`.

Implementation:
- `groqClient.js`: per-key clients (keyed cache by slot:
  `primary`/`secondary`), `options.keySlot` selects the key; a missing
  key for a slot throws the typed `MISSING_API_KEY` naming that slot's
  env var. Model fallback behaviour is identical for both slots. Key
  values are never logged. Test-stub counters are kept per slot.
- `aiProvider.js`: chain A → B → C; `ALL_PROVIDERS_FAILED` lists every
  attempted leg's reason; new `configuredProviders()` helper returns
  `{ groq, nvidia, groq2 }` booleans. The validation self-repair retry
  uses the same 3-leg chain (both route calls go through `callAI`,
  inside the classroom semaphore + cache/coalescing wrapper, so Plan C
  inherits both).
- Health (`/api/health`): `providers: { groq, nvidia, groq2 }` plus
  `groq2KeyConfigured`, same style as the existing booleans.
- The key itself is **set on Render by the operator**
  (`GROQ_API_KEY_2` env var; also declared `sync: false` in
  `render.yaml`) — never in code, never committed.

Tests: 6 new labeled-stub tests (Plan C answers after A+B fail; Plan C
unset → A→B only with combined error; Plan A healthy → B and C never
invoked; secondary slot missing-key error names `GROQ_API_KEY_2`;
per-slot stub counts; health groq2 flag unset/set). `npm test`:
67 passed, 0 failed. `npm run verify`: 18/18 unchanged.

## F. Sticky failover — one question = one key (2026-10-20)

Sunny's rule: "all the three api keys should not be used together for
1 question." Previously `aiProvider.js` tried Plan A → Plan B → Plan C
sequentially *inside one request* until something succeeded, so a
single bad question could burn calls on all three keys. That behavior
is replaced (this section supersedes the failover descriptions in
section B and the Plan C section above):

- **One question = one key.** Each request selects the FIRST
  configured leg not in cooldown — Groq (A) → NVIDIA (B) → Groq2 (C) —
  and calls ONLY that leg. Per-model fallback on the same key and the
  single validation self-repair retry stay on that same leg (audited
  in `generate.js`: both `callAI` invocations in `runUpstream` go
  through the same sticky selector; a failing repair does not fall
  over to another leg).
- **Circuit breaker per leg.** If the selected leg fails, it is
  benched and the request returns a typed `PROVIDER_FAILED_COOLDOWN`
  error (HTTP 502) naming the failed provider, the bench duration, and
  the plan the NEXT questions will use. The question is not retried on
  another key.
- **Cooldowns:** `PROVIDER_COOLDOWN_MS` (default 60000) for general
  failures; `RATE_LIMIT_COOLDOWN_MS` (default 300000) for 429/quota
  failures; a provider `Retry-After` hint overrides both (capped at
  15 min). On success a leg resets to up; on cooldown expiry the leg
  is eligible again in preference order, so Plan A naturally resumes.
- **All legs cooling:** HTTP 503 `ALL_PROVIDERS_COOLDOWN` with the
  earliest retry time — and zero provider calls are made.
- **Visibility:** `GET /api/health` gains `providerState`
  (`"up" | "cooldown"` per configured leg; `groq2` omitted when its
  key is unset). Breaker state is in-memory module state in
  `aiProvider.js`, shared by all chain instances.
- `ALL_PROVIDERS_FAILED` no longer exists; the generate route maps
  the two new typed errors (the all-cooldown 503 branch is matched
  before the generic queue-503 branch).

Tests: the four tests that encoded the old try-every-leg behavior were
rewritten to the sticky semantics, and 5 tests added (cooldown expiry
re-eligibility; 429 → rate-limit cooldown, not the general one;
Retry-After override + 15-min cap; self-repair stays on the same leg;
failing repair does not fall over). `npm test`: 72 passed, 0 failed.
`npm run verify`: 18/18 unchanged.

---

## G. Multi-class Java mangling + broken answers were cached (2026-10-20, post-deploy)

**Proven live, twice in one evening:** for "implement binary tree
using linked list" the API returned code that cannot compile — and the
second identical request served the same broken body from cache
(`x-cache: HIT`, `x-validation: failed`):

```java
class BinaryTreeLinkedList {
    static class BinaryTreeLinkedList {   // helper renamed to the SAME name
        int data;
        BinaryTreeLinkedList left, right;
        TreeNode(int data) { ... }       // orphan constructor: no TreeNode declared
    }
    ...
}
```

javac: "invalid method declaration; return type required".

**Root cause — our own post-processing did this** (`src/utils/javaFixer.js`,
introduced with the E2 naming work): the fixer RENAMED classes in
generated code to match a prompt-derived filename.

1. Its main-class detection loop overwrote `currentClass` on every
   `class X` line, so for a nested helper class declared before
   `main()` (`static class TreeNode`), the "main class" was recorded
   as the HELPER.
2. Its reference-fixing step then replaced every `TreeNode␣` token
   with the derived name — including the helper's own declaration
   (`static class TreeNode {` → `static class BinaryTreeLinkedList {`)
   and all its type references — duplicating the outer class name.
3. The rename patterns required a space or `new` after the name, so
   the constructor declaration `TreeNode(int data)` was never renamed,
   leaving an orphan constructor matching no declared class.
4. Its rename step anchored at line start, so the nested declaration
   never received the `public` treatment either — the output had no
   public class at all.
5. Compounding it, the generate route served the failed-validation
   result anyway and `setInCache` ran unconditionally, so the broken
   body was cached and re-served.

Reproduced locally byte-for-byte by feeding a plausible model output
(public outer class named per the prompt + nested `TreeNode` helper)
through the old `fixJavaCode`.

**Fixes:**

- **Filename follows the code, not the reverse.** `javaFixer` no
  longer renames anything — it only strips stray fence lines.
  `src/utils/className.js` gains `analyzeJavaClasses()` /
  `findJavaEntryClass()`: a brace-stack scan over string/comment-
  stripped code that finds the class whose body actually contains
  `public static void main` (fallback: the single top-level class,
  then the prompt-derived name). The response `X-Filename` is that
  class + `.java`, on both MISS and cache-HIT paths. The prompt still
  ASKS the model for the problem-specific class name; helper classes
  (`TreeNode`, `Node`, …) are returned exactly as generated. The
  cache key is built from prompt + user filename + language (it must
  exist before generation), never from the code-derived name.
- **Validator catches this breakage class** (`codeValidator.js`):
  (a) the same type name declared more than once → invalid
  (`declares class "X" more than once`); (b) a constructor-like
  declaration whose capitalized name matches no declared
  class/interface/enum/record → invalid (`constructor "X" does not
  match any declared class`). Names with no lowercase letters are
  skipped (enum constants with class bodies are not constructors);
  the pre-existing public-class rule is unchanged.
- **Repair loop:** up to **2** self-repair attempts (was 1). Each
  repair prompt carries the validator's exact failure reasons and
  instructs a clean regeneration; the conversation accumulates; the
  first passing result wins. Provider errors from a repair attempt
  now propagate as their typed error instead of being masked by
  serving the broken first attempt. All attempts stay on the same
  provider leg (same `callAI` binding; sticky selector untouched).
- **Never serve/cache known-broken code:** if all attempts fail
  validation, the route returns **502** with
  `code: "GENERATION_INVALID"` ("Couldn't generate valid code for
  this question — please ask again or rephrase."). Cache writes (and
  therefore coalesced sharing) happen only for validated results;
  a repeat of a failed question is a cache MISS that calls the
  provider again.

**Tests:** 9 new unit tests (entry-class analysis, fixer never
renames, duplicate/orphan validator reasons, enum false-positive
guard) + 4 new route tests via a labeled fake provider (two-class
answer served unchanged with `X-Filename: BinaryTree.java`;
invalid→valid repair sequence; always-invalid → 502
GENERATION_INVALID with 3 provider calls and a repeat MISS at 6;
valid answer still caches as a HIT). The pre-existing stub end-to-end
test was updated to the new contract: the stub's `public class Main`
is now served UNRENAMED with `X-Filename: Main.java` (it previously
asserted the rename to `BinarySearch`). `npm run verify` gains
Sunny's exact question as a Java regression case (multi-class
fixture whose main class is `BinaryTree`, deliberately NOT the
prompt-derived name; filename derived from the code; compiles and
runs: `Inorder traversal: [2, 3, 4, 5, 6, 7, 8]`).

`npm test`: **85 passed, 0 failed** (was 72). `npm run verify`:
**19/19** (was 18; +1 for the tree case).

This section supersedes the naming wiring described in E2 (the route
no longer routes the derived name through javaFixer; javaFixer no
longer renames) and the "one retry" wording in section B.

---

## H. Phase-2 bug hunt — whole request lifecycle (2026-10-20)

Method: an adversarial battery (59 checks) run BEFORE any fix:
19 classroom questions (8 Java, 6 C, 5 Python) with realistic
model-style outputs driven through the real route + pipeline and
compiled/run with gcc/javac/python3; 12 direct post-processing
probes; 19 request-lifecycle probes against the real server plus
coalescing/semaphore burst probes; 9 provider-layer probes.
Pre-fix battery: **49 passed, 10 failed**. Post-fix: **59/59**.

### Bugs found (each reproduced first) and fixed

**H1. Block-comment stripping ate string contents (C, Java).**
`removeAllComments` removed `/* ... */` with a regex that knew
nothing about string literals. Evidence (battery probe): cleaning
`printf("/* done */\n")` produced `printf("\n")`; at route level the
C file-copy program lost its printed `/* done */` marker.
Fix: comment removal is now a whole-text scanner that tracks
`'...'`, `"..."` and `` `...` `` literals; a block comment is
replaced by a single space so tokens can never fuse (`int/**/x` →
`int x`).

**H2. Python triple-quoted strings were deleted as "comments".**
The cleaner globally removed every `"""..."""` / `'''...'''` span.
Those are strings: an assigned `TEXT = """alpha\nbeta"""` came back
as `TEXT =` — a route-level **SyntaxError** in the battery's Python
file-handling case — and function docstrings were silently deleted.
Fix: triple-quoted spans are tracked as string state and never
removed; only real `#` comments are stripped.

**H3. Comment stripping lost string state at line boundaries.**
Line comments were stripped per line with string state reset each
line, so a `//` line inside a multi-line JS template literal was
eaten as a comment (battery probe: the middle line of a template
literal vanished) and a `#` line inside a Python multi-line string
was exposed to the same treatment. Fix: the H1/H2 scanners walk the
whole text once, so string state persists across lines; unterminated
single/double-quoted literals resync at the newline.

**H4. Fence stripping ate ``` inside string literals.**
`stripMarkdownFences` replaced every ``` occurrence anywhere;
`print("```")`-style content lost its string. Fix: fences are now
line-based — only a line that is solely a fence (optional language
tag), or an opening fence prefix sharing its line with code, is
removed.

**H5. POST ignored a query-string prompt (400) while GET accepted it.**
`validateGenerateRequest` only fell back to `req.query` for GET, yet
filename and language already fell back for every method. Evidence:
`POST /api/generate?prompt=x` with an empty body → 400; the same URL
as GET → 200. Fix: body fields still win, but the query string is
now the fallback for all methods.

Also in this commit (same root area): the old global
`\n{3,}` → `\n\n` collapse in `removeAllComments` was dropped — it
could rewrite blank lines inside multi-line strings — and the
compile-check runners now execute programs with `cwd` set to their
temp dir so file-IO fixtures can never write into the repo.

### Checked, not reproduced (verified working, no change made)

- **Question battery:** all 8 Java cases (linked list, array stack,
  queue, inheritance incl. a URL inside a string literal, exception
  handling, file handling, multithreading, CRUD class set) and the
  remaining C/Python cases passed pre-fix; the only failures were
  H1/H2 above.
- **Groq model fallback** advances ONLY on `model_not_found`: 401
  surfaces after exactly 1 attempt; 429/503 retry the SAME model
  with backoff and then throw (battery + new unit test).
  **NVIDIA**: candidate order (Nemotron Ultra first) and
  `isModelNotFound` matching only 404/410 verified; chain-level
  fallback order was already covered by the §F sticky tests.
- **Retry-After parsing:** HTTP-date form honored (~120 s), numeric
  `retryAfter` honored, garbage value falls back to the general
  cooldown. Observed but NOT changed: a *string* `retryAfterSeconds`
  ("45") is ignored and the 429 default (300 s) applies — provider
  SDKs surface this field as a number and both header forms are
  parsed, so this is a typing choice, not a proven failure.
- **Lifecycle:** empty/whitespace q → 400; q > 10000 chars → 400
  "Prompt too long"; `lang=JAVA` and `lang=" java "` work; POST body
  prompt provably beats query q (cache-key evidence); unknown route
  → 404 JSON; DELETE → 404 (Express has no 405 here); HEAD
  /api/health → 200; OPTIONS preflight answered with CORS headers;
  RateLimit headers present on /api responses (from the global
  limiter); undetectable language → `auto`, no crash; URL-reserved
  characters in q work when properly encoded.
- **Cache/coalescing/semaphore:** same q + different lang and
  different q + same lang never collide; 5 concurrent identical
  requests = 1 provider call, 3 distinct = 3 calls; after a burst of
  10 provider errors and a burst of 12 GENERATION_INVALIDs, 12 fresh
  requests were all served (no semaphore slot leaks on either path);
  `providerState` recovers when a cooldown expires (§F chain tests +
  health test).
- **Known residual limits (documented, unchanged):** the comment
  scanners are structural heuristics — a JS regex literal containing
  an unescaped `//`, or a Go raw string ending in a backslash, can
  still desync them (the old per-line code had the same limits);
  javaFixer's fence-line filter was inspected and left alone (it
  only ever sees already-cleaned code; no damaging sample could be
  produced).

### Regression tests added

12 cleaner string-safety tests + 3 validator-middleware tests + 1
Groq 429 test in `npm test`; `npm run verify` gains the two battery
failures as permanent fixtures (C file-copy, Python file-handling).

`npm test`: **101 passed, 0 failed** (was 85). `npm run verify`:
**21/21** (was 19). Battery: **59/59** (was 49/59).
