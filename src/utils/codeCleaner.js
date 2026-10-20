// Post-processing step 1: strip markdown fences, preamble chatter, and
// comments from raw model output.
//
// HISTORY (FIXES.md section H): the previous implementation damaged
// real code, proven by the Phase-2 battery:
//   - block comments were removed with a regex that did not know
//     about string literals, so a C/Java string containing "/* ... */"
//     lost its contents;
//   - Python "comments" removal globally deleted every """...""" and
//     '''...''' span — those are STRINGS, not comments — destroying
//     assigned triple-quoted strings (a route-level SyntaxError) and
//     function docstrings;
//   - line comments were stripped one line at a time with the string
//     state reset on every line, so a `//` or `#` line inside a
//     multi-line string (JS template literal, Python triple-quoted
//     string) was eaten as if it were a comment;
//   - fence stripping replaced every ``` occurrence anywhere,
//     including inside string literals.
//
// The scanners below walk the WHOLE text once, tracking string state
// across lines. They are structural heuristics, not parsers: a regex
// literal containing an unescaped "//" (JS) or a Go raw string ending
// in a backslash can still desync them — the same limits the old
// per-line code had, minus the proven damage above.

function stripMarkdownFences(code) {
  if (!code) return "";

  // Line-based: a fence is a line of its own (optionally with a
  // language tag). ``` sequences inside code (e.g. a string literal
  // holding markdown) are content, not fences, and are kept.
  const lines = code.split("\n");
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```\s*[a-zA-Z+#-]*\s*$/.test(trimmed)) continue; // fence-only line
    if (out.length === 0 && /^```\s*[a-zA-Z+#-]+\s+/.test(trimmed)) {
      // Opening fence sharing its line with code: "```java public class …"
      out.push(trimmed.replace(/^```\s*[a-zA-Z+#-]+\s+/, ""));
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
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

// Remove // and /* */ comments from C-family code while respecting
// '...', "..." and `...` literals across the whole text (template
// literals may span lines). A block comment is replaced by a single
// space so adjacent tokens can never fuse (`int/**/x` -> `int x`);
// newlines inside block comments are preserved so line numbers stay
// meaningful. An unterminated '...' or "..." literal resyncs at the
// newline (neither may legally span lines in these languages).
function stripCStyleComments(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  let state = "code"; // code | line | block | single | double | template

  while (i < n) {
    const ch = code[i];
    const next = i + 1 < n ? code[i + 1] : "";

    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block"; out += " "; i += 2; continue; }
      if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "`") state = "template";
      out += ch;
      i++;
      continue;
    }

    if (state === "line") {
      if (ch === "\n") { state = "code"; out += ch; }
      i++;
      continue;
    }

    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; i += 2; continue; }
      if (ch === "\n") out += "\n";
      i++;
      continue;
    }

    // String states.
    if (ch === "\\" && next) { out += ch + next; i += 2; continue; }
    if (state === "single" && ch === "'") state = "code";
    else if (state === "double" && ch === '"') state = "code";
    else if (state === "template" && ch === "`") state = "code";
    else if ((state === "single" || state === "double") && ch === "\n") state = "code";
    out += ch;
    i++;
  }
  return out;
}

// Remove # comments from Python-family code while respecting '...',
// "...", '''...''' and """...""" literals across the whole text.
// Triple-quoted spans are strings (docstrings, multi-line content) —
// they are NEVER removed. A shebang line (#!...) is preserved.
function stripHashComments(code) {
  let out = "";
  let i = 0;
  const n = code.length;

  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    if (nl === -1) return code;
    out = code.slice(0, nl + 1);
    i = nl + 1;
  }

  let state = "code"; // code | comment | single | double | tripleSingle | tripleDouble

  while (i < n) {
    const ch = code[i];

    if (state === "code") {
      if (ch === "#") { state = "comment"; i++; continue; }
      if (ch === '"' || ch === "'") {
        if (code.startsWith(ch.repeat(3), i)) {
          state = ch === '"' ? "tripleDouble" : "tripleSingle";
          out += ch.repeat(3);
          i += 3;
          continue;
        }
        state = ch === '"' ? "double" : "single";
        out += ch;
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    if (state === "comment") {
      if (ch === "\n") { state = "code"; out += ch; }
      i++;
      continue;
    }

    // String states.
    const next = i + 1 < n ? code[i + 1] : "";
    if (ch === "\\" && next) { out += ch + next; i += 2; continue; }
    if (state === "tripleSingle" && code.startsWith("'''", i)) {
      out += "'''"; i += 3; state = "code"; continue;
    }
    if (state === "tripleDouble" && code.startsWith('"""', i)) {
      out += '"""'; i += 3; state = "code"; continue;
    }
    if (state === "single" && ch === "'") state = "code";
    else if (state === "double" && ch === '"') state = "code";
    else if ((state === "single" || state === "double") && ch === "\n") state = "code";
    out += ch;
    i++;
  }
  return out;
}

const C_STYLE_LANGS = [
  "java", "cpp", "c", "javascript", "typescript",
  "go", "rust", "csharp", "swift", "kotlin",
];
const HASH_LANGS = ["python", "bash", "ruby", "r"];

function removeAllComments(code, lang) {
  if (!code) return "";

  if (C_STYLE_LANGS.includes(lang)) return stripCStyleComments(code);
  if (HASH_LANGS.includes(lang)) return stripHashComments(code);
  return code;
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
