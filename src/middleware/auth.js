const logger = require("../utils/logger");

function apiKeyAuth(req, res, next) {
  const apiKey = process.env.API_SECRET_KEY;
  if (!apiKey) {
    return next();
  }
  const provided =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    req.query.api_key;

  if (!provided || provided !== apiKey) {
    logger.warn("Unauthorized API access attempt", {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({ error: "Unauthorized: invalid or missing API key." });
  }
  next();
}

module.exports = { apiKeyAuth };
