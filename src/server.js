require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const generateRoute = require("./routes/generate");
const adminRoute = require("./routes/admin");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const { apiKeyAuth } = require("./middleware/auth");
const logger = require("./utils/logger");

const app = express();
const PORT = parseInt(process.env.PORT || "3000");

app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

if (process.env.NODE_ENV !== "test") {
  app.use(morgan("combined", {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
  max: parseInt(process.env.RATE_LIMIT_MAX || "30"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
  keyGenerator: (req) =>
    req.headers["x-api-key"] || req.ip || "unknown",
});

const generateLimiter = rateLimit({
  windowMs: 60000,
  max: parseInt(process.env.GENERATE_RATE_LIMIT || "20"),
  message: { error: "Code generation rate limit exceeded. Try again in a minute." },
  keyGenerator: (req) =>
    req.headers["x-api-key"] || req.ip || "unknown",
});

app.use(globalLimiter);

app.use("/api", adminRoute);
app.use("/generate", generateLimiter, apiKeyAuth, generateRoute);
app.use("/api/generate", generateLimiter, apiKeyAuth, generateRoute);

app.get("/", (req, res) => {
  res.json({
    name: "CodeAI API",
    version: "1.0.0",
    endpoints: {
      "POST /generate": "Generate code from a prompt",
      "GET /generate?q=...": "Generate code via GET request",
      "GET /api/health": "Health check",
      "GET /api/stats": "Server statistics (requires API key)",
      "POST /api/cache/flush": "Flush cache (requires API key)",
    },
    usage: {
      curl_post: 'curl -X POST http://localhost:3000/generate -H "Content-Type: application/json" -d \'{"prompt":"fibonacci in java"}\'',
      curl_get: 'curl "http://localhost:3000/generate?q=binary+search+in+python"',
      save_to_file: 'curl -X POST http://localhost:3000/generate -H "Content-Type: application/json" -d \'{"prompt":"dijkstra in python","filename":"dijkstra.py"}\' -o dijkstra.py',
    },
  });
});

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(PORT, () => {
  logger.info(`CodeAI API server started`, {
    port: PORT,
    env: process.env.NODE_ENV || "development",
    model: process.env.MODEL || "llama3-70b-8192",
    groqKeySet: !!process.env.GROQ_API_KEY,
  });
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    logger.info("Server closed.");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down...");
  server.close(() => process.exit(0));
});

module.exports = { app, server };
