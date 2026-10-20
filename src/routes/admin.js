const express = require("express");
const router = express.Router();
const { getCacheStats, flushCache } = require("../utils/cache");
const { apiKeyAuth } = require("../middleware/auth");
const os = require("os");

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    env: process.env.NODE_ENV || "development",
    model: process.env.MODEL || "openai/gpt-oss-120b",
    groqKeyConfigured: !!process.env.GROQ_API_KEY,
    nvidiaKeyConfigured: !!process.env.NVIDIA_API_KEY,
    providers: {
      groq: !!process.env.GROQ_API_KEY,
      nvidia: !!process.env.NVIDIA_API_KEY,
    },
  });
});

router.get("/stats", apiKeyAuth, (req, res) => {
  const cacheStats = getCacheStats();
  res.json({
    cache: cacheStats,
    memory: process.memoryUsage(),
    platform: process.platform,
    nodeVersion: process.version,
    cpuCount: os.cpus().length,
    loadAvg: os.loadavg(),
    uptime: Math.floor(process.uptime()),
  });
});

router.post("/cache/flush", apiKeyAuth, (req, res) => {
  flushCache();
  res.json({ success: true, message: "Cache flushed." });
});

module.exports = router;
