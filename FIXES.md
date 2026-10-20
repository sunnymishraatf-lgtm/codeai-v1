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
