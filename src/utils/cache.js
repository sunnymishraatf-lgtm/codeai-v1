const NodeCache = require("node-cache");
const crypto = require("crypto");

const cache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL || "3600", 10),
  checkperiod: 600,
  useClones: false,
});

function buildCacheKey(prompt, filename, language) {
  const normalized = (prompt || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const hash = crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex");

  const lang = (language || "auto").toLowerCase();
  const file = (filename || "unknown").toLowerCase();

  return `code:${lang}:${file}:${hash}`;
}

function getFromCache(key) {
  return cache.get(key) || null;
}

function setInCache(key, value) {
  cache.set(key, value);
}

function getCacheStats() {
  return cache.getStats();
}

function flushCache() {
  cache.flushAll();
}

module.exports = {
  buildCacheKey,
  getFromCache,
  setInCache,
  getCacheStats,
  flushCache,
};
