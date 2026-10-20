# CodeAI API

A production-grade terminal-based AI code generation API powered by Groq.

## Quick Start

```bash
# 1. Clone / extract project
cd codeai-project

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and add your GROQ_API_KEY

# 4. Start server
npm start          # production
npm run dev        # development (auto-reload)
```

## AI Providers (sticky failover — one question = one key)

Requests are served by three provider legs in preference order, but
**one question uses exactly one key**. Each request selects the first
configured leg that is not in cooldown and calls ONLY that leg:

```
Plan A: Groq, primary key    (GROQ_API_KEY)
Plan B: NVIDIA NIM           (NVIDIA_API_KEY)
Plan C: Groq, second key     (GROQ_API_KEY_2) — optional; skipped when unset
```

**Sticky failover (circuit breaker per leg):** if the selected leg's
call fails, that leg is *benched* for a cooldown and the request
returns an honest `502` error — the question is **not** silently
retried on the next key, so one bad question can never burn calls on
all three keys. The *next* questions automatically select the next
eligible leg in preference order. When a cooldown expires, the leg
becomes eligible again — Plan A naturally resumes once it is healthy
(and is re-benched if it fails again). A leg's internal per-model
fallback (same key, different model) and the validation
self-repair retries stay on the same leg: models are not keys.

If **every** configured leg is in cooldown, requests fail fast with
`503` (plus the earliest retry time) and no provider is called at all.

| Cooldown | Default | Applies when |
|---|---|---|
| `PROVIDER_COOLDOWN_MS` | `60000` (1 min) | General provider failures |
| `RATE_LIMIT_COOLDOWN_MS` | `300000` (5 min) | HTTP 429 / quota / daily-limit failures |

A provider-supplied `Retry-After` hint overrides both when present
(capped at 15 minutes). Breaker state is in-memory and visible at
`GET /api/health` as `providerState: { groq: "up"|"cooldown", ... }`
(the `groq2` entry appears only when Plan C is configured).

**The honest tradeoff:** the one question that discovers a dead key
gets an error (telling the student to ask again); every question after
it is silently served by the next plan until the benched key recovers.

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | *(at least one provider key is required)* | Groq API key — Plan A (primary provider) |
| `NVIDIA_API_KEY` | *(at least one provider key is required)* | NVIDIA NIM API key — Plan B (backup provider) |
| `GROQ_API_KEY_2` | *(optional)* | Second Groq API key — Plan C (reserve leg; serves questions once Plan A and Plan B are benched) |
| `NVIDIA_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b` | NVIDIA model (Nemotron — Sunny's requested backup family). **NVIDIA rotates/retires models** — this default was verified working live on 2026-10-20 with a real key (returned correct C code). Fallback chain: `nvidia/nemotron-3-ultra-550b-a55b` → `openai/gpt-oss-20b` (verified, correct Python code) → `google/gemma-4-31b-it` (verified answering). If the chosen model returns 404 or 410, the server automatically tries the next model. The three older NEUTRON-app catalog models currently fail live (410 Gone / 410 Gone / 404) and are no longer in the chain. Set `NVIDIA_MODEL` to override. |

**Groq models rotate too.** `llama-3.3-70b-versatile` was moved to
enterprise-only pricing in Aug 2026 (free keys get `404
model_not_found`), so the Groq default is now `openai/gpt-oss-120b`.
If the chosen Groq model answers `model_not_found`, the server
automatically tries the next model in the fallback chain (see
`GROQ_MODELS` below) instead of failing the request.

The response carries an `X-Provider: groq|nvidia|groq2` header so you can see
which provider answered. Generated code is structurally validated
(C / Java / Python checks) before it is returned; if validation fails,
the provider gets up to two self-repair attempts with the validator's
exact failure reasons fed back. Only code that PASSES validation is
ever served or cached: if every attempt fails, the request returns
`502` with `code: "GENERATION_INVALID"` instead of broken code. The
`X-Validation` header reports the outcome.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | required* | Your Groq API key — Plan A (primary) |
| `NVIDIA_API_KEY` | required* | Your NVIDIA NIM API key — Plan B (backup) |
| `GROQ_API_KEY_2` | *(none)* | Optional second Groq API key — Plan C (reserve leg; used for the questions that follow a Plan A + Plan B benching, e.g. Plan A's key hit its limit) |
| `PROVIDER_COOLDOWN_MS` | `60000` | How long a failed provider leg stays benched (general failures) |
| `RATE_LIMIT_COOLDOWN_MS` | `300000` | How long a rate-limited (429/quota) provider leg stays benched |
| `NVIDIA_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b` | NVIDIA model (see failover section; verified live 2026-10-20) |
| `PORT` | `3000` | Server port |
| `MODEL` | `openai/gpt-oss-120b` | Groq model to use. **Do not set `llama-3.3-70b-versatile`**: Groq moved it to enterprise-only pricing in Aug 2026, so free/self-serve keys get `404 model_not_found` (this broke the live deployment on 2026-10-20; `gpt-oss-120b` is the verified fix) |
| `GROQ_MODELS` | *(built-in list)* | Optional comma-separated Groq fallback list. If the chosen model answers `model_not_found`, the next model is tried automatically. Built-in chain: `openai/gpt-oss-120b` → `openai/gpt-oss-20b` → `meta-llama/llama-4-scout-17b-16e-instruct` → `qwen/qwen3-32b` |
| `MAX_TOKENS` | `8192` | Max tokens per response |
| `RATE_LIMIT_MAX` | `1000` | Global requests per window per IP (high on purpose — see Classroom use) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `GENERATE_RATE_LIMIT` | `500` | Generate requests per minute per IP |
| `MAX_CONCURRENT_AI` | `10` | Max simultaneous AI provider requests; extras queue |
| `QUEUE_TIMEOUT_MS` | `30000` | Max queue wait before a friendly HTTP 503 |
| `CACHE_TTL` | `3600` | Cache TTL in seconds |
| `API_SECRET_KEY` | *(none)* | Optional API key for auth |

\* At least one provider key must be set, or generation returns a clear
"server is not configured" error.

## Classroom use

This API is built to survive a whole class using it at once (50+
concurrent students):

- **Shared IP:** students on college Wi-Fi sit behind one NAT address,
  so per-IP rate limits are set high (1000/min global, 500/min
  generate). A low per-IP limit would block the entire class after a
  few questions.
- **Concurrency cap:** at most `MAX_CONCURRENT_AI` (default 10) AI
  requests run at once; the rest queue for up to `QUEUE_TIMEOUT_MS`
  (default 30s) and then get a friendly HTTP 503 instead of hanging.
- **Cache + request coalescing:** identical question+language requests
  are cached for an hour, and if 30 students ask the same question at
  the same moment, they share **one** provider call.
- **Honest bottleneck:** the real ceiling is the AI provider's own
  limits (e.g. Groq free-tier requests/tokens per minute). Caching and
  coalescing stretch it a long way; a paid Groq tier (or the NVIDIA
  backup) is the upgrade path when a class outgrows the free tier.

## API Endpoints

### `POST /generate`
Generate code from a prompt.

**Body:**
```json
{
  "prompt": "fibonacci series in java",
  "filename": "Fibonacci.java",
  "language": "java"
}
```

**Response:** Raw code as `text/plain`

---

### `GET /generate?q=<prompt>`
Generate code via GET.

```
GET /generate?q=binary+search+in+python
```

---

### `GET /api?q=<prompt>&lang=<language>`
Terminal-friendly GET endpoint — the question and language go straight
in the URL and the answer comes back as plain-text code:

```bash
curl "https://<your-site>/api?q=write+binary+search&lang=java"
curl "https://<your-site>/api?q=fibonacci&lang=c"
curl "https://<your-site>/api?q=reverse+a+string&lang=python" > reverse.py
```

Supported `lang` values include `c`, `java`, `python`, `cpp`,
`javascript`, and everything the auto-detector knows (aliases like
`py`, `js`, `c++` work too). If `lang` is omitted, the language is
detected from the question.

**Naming:** for Java questions the server derives a problem-specific
class name from the question (`BinarySearch` for
`?q=write+binary+search&lang=java`) and asks the model to use it — so
answers don't come back as a generic `Main`. Helper classes the model
adds (a `TreeNode` inside a tree program, a `Node` inside a linked
list) are kept exactly as generated: the server NEVER renames classes
in returned code. The `X-Filename` header follows the code itself —
it names the class that actually contains `main()`
(`X-Filename: BinaryTree.java` when the model's main class is
`BinaryTree`), so the file you save always matches the code you got
(an explicit `filename` in the request always wins). In every
language, functions are named after the task (`binarySearch`,
`is_palindrome`, …), never generic placeholders.

---

### `GET /api/health`
Health check.

---

### `GET /api/stats`
Server and cache statistics (requires `X-Api-Key` header if `API_SECRET_KEY` is set).

---

### `POST /api/cache/flush`
Flush the in-memory cache.

---

## curl Examples

```bash
# Basic POST
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"fibonacci in java"}'

# GET request
curl "http://localhost:3000/generate?q=binary+search+in+python"

# Save output directly to file
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"dijkstra algorithm","filename":"dijkstra.py"}' \
  -o dijkstra.py

# With API key auth
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_secret_key" \
  -d '{"prompt":"merge sort in c++","filename":"mergesort.cpp"}' \
  -o mergesort.cpp
```

## Supported Languages

Java, Python, C++, C, JavaScript, TypeScript, Go, Rust, Ruby, PHP, C#, Swift, Kotlin, Scala, SQL, HTML/CSS, Bash, Dart, Lua, Perl, Haskell, Elixir, Erlang — and more via auto-detection.

## Running Tests

```bash
npm test        # unit tests: detection, cleaning, validation,
                # provider failover (stubbed), concurrency semaphore
npm run verify  # compile/run verification: 6 classic problems x
                # C / Java / Python are pushed through the app's own
                # cleaning+validation pipeline (from labeled messy
                # fixtures) and then really compiled with gcc / javac
                # and run with python3 / java; stdout is asserted.
                # Java cases SKIP loudly if javac is not installed.
```

Note: this README intentionally shows no sample AI outputs — outputs
depend on the live provider. The canonical, verified example solutions
live in `tests/compile-check.js` and are proven by `npm run verify`.

## Project Structure

```
codeai-project/
├── src/
│   ├── server.js              # Express app + entry point
│   ├── routes/
│   │   ├── generate.js        # Code generation route
│   │   └── admin.js           # Health, stats, cache routes
│   ├── middleware/
│   │   ├── auth.js            # API key auth
│   │   ├── errorHandler.js    # Error + 404 handlers
│   │   └── validator.js       # Request validation
│   └── utils/
│       ├── groqClient.js      # Groq API + retry + model fallback (primary provider)
│       ├── className.js       # Derives the requested Java class name from the prompt; finds the entry class in generated Java so X-Filename follows the code
│       ├── nvidiaClient.js    # NVIDIA NIM API + model fallback (backup)
│       ├── aiProvider.js      # Sticky failover (one question = one key): Groq (A) -> NVIDIA (B) -> Groq 2nd key (C)
│       ├── concurrency.js     # AI concurrency semaphore + queue
│       ├── codeValidator.js   # Structural validation of generated code
│       ├── systemPrompt.js    # AI system prompt
│       ├── langDetect.js      # Language auto-detection
│       ├── cache.js           # In-memory response cache
│       ├── codeCleaner.js     # Strip markdown/preamble
│       └── logger.js          # JSON structured logger
├── tests/
│   ├── test.js                # Unit tests
│   └── compile-check.js       # Compile/run verification (npm run verify)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```
