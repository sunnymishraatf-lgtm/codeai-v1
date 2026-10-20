const { normalizeLanguage } = require("../utils/langDetect");

function validateGenerateRequest(req, res, next) {
  const { prompt, q, question } = req.body || {};
  // Body fields win over the query string (for every method), and the
  // query string is the fallback for every method — filename and
  // language below already fall back to req.query unconditionally, so
  // the prompt does too. (Before FIXES.md H, a POST whose prompt was
  // only in the query string got a 400 while a GET with the same URL
  // worked.)
  const query =
    prompt || q || question || req.query?.q || req.query?.prompt || null;

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({
      error: "Missing required field: 'prompt' (also accepted: 'q', 'question')",
    });
  }

  if (query.trim().length > 10000) {
    return res.status(400).json({ error: "Prompt too long. Maximum 10000 characters." });
  }

  req.codePrompt = query.trim();
  req.codeFilename = (req.body?.filename || req.query?.filename || "").trim();
  req.codeLang = normalizeLanguage(
    req.body?.language || req.body?.lang || req.query?.lang || ""
  );

  next();
}

module.exports = { validateGenerateRequest };
