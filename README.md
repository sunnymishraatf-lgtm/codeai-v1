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

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | required | Your Groq API key |
| `PORT` | `3000` | Server port |
| `MODEL` | `llama3-70b-8192` | Groq model to use |
| `MAX_TOKENS` | `4096` | Max tokens per response |
| `RATE_LIMIT_MAX` | `30` | Requests per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `CACHE_TTL` | `3600` | Cache TTL in seconds |
| `API_SECRET_KEY` | *(none)* | Optional API key for auth |

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
npm test
```

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
│       ├── groqClient.js      # Groq API + retry logic
│       ├── systemPrompt.js    # AI system prompt
│       ├── langDetect.js      # Language auto-detection
│       ├── cache.js           # In-memory response cache
│       ├── codeCleaner.js     # Strip markdown/preamble
│       └── logger.js          # JSON structured logger
├── tests/
│   └── test.js                # Unit tests
├── .env.example
├── .gitignore
├── package.json
└── README.md
```
