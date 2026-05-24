function validateGenerateRequest(req, res, next) {
  const { prompt, q, question } = req.body || {};
  const query = prompt || q || question || (req.method === "GET" ? req.query.q || req.query.prompt : null);

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({
      error: "Missing required field: 'prompt' (also accepted: 'q', 'question')",
    });
  }

  if (query.trim().length > 5000) {
    return res.status(400).json({ error: "Prompt too long. Maximum 5000 characters." });
  }

  req.codePrompt = query.trim();
  req.codeFilename = (req.body?.filename || req.query?.filename || "").trim();
  req.codeLang = (req.body?.language || req.body?.lang || req.query?.lang || "").trim().toLowerCase();

  next();
}

module.exports = { validateGenerateRequest };
