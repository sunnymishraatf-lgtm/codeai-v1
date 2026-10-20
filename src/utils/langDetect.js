const EXTENSION_MAP = {
  ".java": "java",
  ".py": "python",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "c",
  ".js": "javascript",
  ".mjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".jsx": "javascript",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".r": "r",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".dart": "dart",
  ".lua": "lua",
  ".pl": "perl",
  ".hs": "haskell",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".vhd": "vhdl",
  ".vhdl": "vhdl",
};

// Language detection rules.
//
// Ordering and matching style matter here:
// - Symbolic tokens (c++, c#, .cpp, .cs, file extensions) are matched as
//   substrings because they are unambiguous.
// - Word tokens are matched with \b word boundaries. Plain substring
//   matching was a bug: "javascript" contains "java", so every JavaScript
//   prompt was misdetected as Java, and there was no rule at all for
//   plain C, so "binary search in c" fell through to "auto".
// - The plain-C rule runs AFTER cpp and csharp so "c++"/"c#" win first,
//   and \bc\b cannot match inside "c++" (the char after "c" is "+",
//   which is handled by the earlier cpp substring rule anyway).
const KEYWORD_MAP = [
  { substrings: [".java"], words: ["java"], lang: "java" },
  { substrings: [".py", "django", "flask", "numpy", "pandas"], words: ["python", "python3"], lang: "python" },
  { substrings: ["c++", ".cpp"], words: ["cpp"], lang: "cpp" },
  { substrings: ["c#", ".cs", "dotnet", ".net"], words: ["csharp"], lang: "csharp" },
  { substrings: [".js", "nodejs"], words: ["javascript", "node", "express", "react", "vue", "next"], lang: "javascript" },
  { substrings: [".ts"], words: ["typescript", "angular"], lang: "typescript" },
  { substrings: [".go"], words: ["golang"], lang: "go" },
  { substrings: [".rs", "cargo"], words: ["rust"], lang: "rust" },
  { substrings: [], words: ["sql", "mysql", "postgres", "sqlite", "database query"], lang: "sql" },
  { substrings: [], words: ["html", "css", "webpage", "landing page", "web page"], lang: "html" },
  { substrings: [".sh"], words: ["bash", "shell", "linux command"], lang: "bash" },
  { substrings: [], words: ["swift", "ios", "xcode"], lang: "swift" },
  { substrings: [], words: ["kotlin", "android"], lang: "kotlin" },
  { substrings: [".rb"], words: ["ruby", "rails"], lang: "ruby" },
  { substrings: [".php"], words: ["php", "laravel"], lang: "php" },
  { substrings: [".vhd"], words: ["vhdl", "entity", "architecture", "signal", "process", "fpga", "hdl"], lang: "vhdl" },
  // Plain C LAST among the C family: only reached when c++/c# did not match.
  { substrings: [".c"], words: ["c"], lang: "c" },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectLanguage(prompt, filename) {
  if (filename) {
    const ext = "." + filename.split(".").pop().toLowerCase();
    if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];
  }
  const lower = (prompt || "").toLowerCase();
  for (const entry of KEYWORD_MAP) {
    if (entry.substrings.some((kw) => lower.includes(kw))) {
      return entry.lang;
    }
    if (
      entry.words.some((kw) =>
        new RegExp(`\\b${escapeRegExp(kw)}\\b`).test(lower)
      )
    ) {
      return entry.lang;
    }
  }
  return "auto";
}

// Normalize an explicit language value (e.g. ?lang=py or "language": "C++")
// to the canonical names used everywhere else in the app.
const LANG_ALIASES = {
  py: "python",
  python3: "python",
  js: "javascript",
  node: "javascript",
  nodejs: "javascript",
  ts: "typescript",
  "c++": "cpp",
  golang: "go",
  rs: "rust",
  "c#": "csharp",
  cs: "csharp",
  sh: "bash",
};

function normalizeLanguage(lang) {
  if (!lang || typeof lang !== "string") return "";
  const cleaned = lang.trim().toLowerCase();
  return LANG_ALIASES[cleaned] || cleaned;
}

function getClassName(filename) {
  if (!filename) return "Main";
  const base = filename.replace(/\.[^.]+$/, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

module.exports = { detectLanguage, getClassName, normalizeLanguage, EXTENSION_MAP };
