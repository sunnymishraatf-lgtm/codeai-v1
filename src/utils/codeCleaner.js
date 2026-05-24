function stripMarkdownFences(code) {
  if (!code) return "";

  return code
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

function removePreamble(code) {
  if (!code) return "";

  const patterns = [
    /^(here is|here's|sure|certainly|below is)[^\n]*\n+/i,
    /^(explanation|note|output)[:\s][^\n]*\n+/i,
  ];

  let cleaned = code.trim();

  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, "");
  }

  return cleaned.trim();
}

function removeSafeLineComments(line, symbol) {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === "\\") {
      i++;
      continue;
    }

    if (!inDouble && !inTemplate && char === "'") {
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && !inTemplate && char === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && char === '`') {
      inTemplate = !inTemplate;
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (symbol === "//" && char === "/" && next === "/") {
        return line.slice(0, i).trimEnd();
      }

      if (symbol === "#" && char === "#") {
        return line.slice(0, i).trimEnd();
      }
    }
  }

  return line;
}

function removeAllComments(code, lang) {
  if (!code) return "";

  let result = code;

  if (["java", "cpp", "c", "javascript", "typescript", "go", "rust", "csharp", "swift", "kotlin"].includes(lang)) {
    result = result.replace(/\/\*[\s\S]*?\*\//g, "");
    result = result
      .split("\n")
      .map(line => removeSafeLineComments(line, "//"))
      .join("\n");
  }

  if (["python", "bash", "ruby", "r"].includes(lang)) {
    result = result
      .split("\n")
      .map((line, index) => {
        if (index === 0 && line.startsWith("#!")) {
          return line;
        }

        return removeSafeLineComments(line, "#");
      })
      .join("\n");

    result = result.replace(/"""[\s\S]*?"""/g, "");
    result = result.replace(/'''[\s\S]*?'''/g, "");
  }

  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

function cleanCode(rawOutput, lang) {
  let code = rawOutput || "";

  code = stripMarkdownFences(code);
  code = removePreamble(code);

  if (lang) {
    code = removeAllComments(code, lang);
  }

  return code.trim();
}

module.exports = {
  cleanCode,
  stripMarkdownFences,
  removePreamble,
  removeAllComments,
};
