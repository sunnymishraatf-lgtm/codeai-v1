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

const KEYWORD_MAP = [
  { keywords: ["java", ".java", "wap in java", "write a program in java", "in java"], lang: "java" },
  { keywords: ["python", ".py", "wap in python", "write in python", "django", "flask", "numpy", "pandas", "in python"], lang: "python" },
  { keywords: ["c++", "cpp", ".cpp", "wap in c++", "write in c++", "in c++"], lang: "cpp" },
  { keywords: ["c#", "csharp", ".cs", "dotnet", ".net"], lang: "csharp" },
  { keywords: ["javascript", "node", "nodejs", "express", ".js", "react", "vue", "next"], lang: "javascript" },
  { keywords: ["typescript", ".ts", "angular"], lang: "typescript" },
  { keywords: ["golang", ".go"], lang: "go" },
  { keywords: ["rust", ".rs", "cargo"], lang: "rust" },
  { keywords: ["sql", "mysql", "postgres", "sqlite", "database query"], lang: "sql" },
  { keywords: ["html", "css", "webpage", "landing page", "web page"], lang: "html" },
  { keywords: ["bash", "shell", "linux command", ".sh"], lang: "bash" },
  { keywords: ["swift", "ios", "xcode"], lang: "swift" },
  { keywords: ["kotlin", "android"], lang: "kotlin" },
  { keywords: ["ruby", ".rb", "rails"], lang: "ruby" },
  { keywords: ["php", ".php", "laravel"], lang: "php" },
  { keywords: ["vhdl", ".vhd", "entity", "architecture", "signal", "process", "fpga", "hdl"], lang: "vhdl" },
];

function detectLanguage(prompt, filename) {
  if (filename) {
    const ext = "." + filename.split(".").pop().toLowerCase();
    if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];
  }
  const lower = (prompt || "").toLowerCase();
  for (const entry of KEYWORD_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      return entry.lang;
    }
  }
  return "auto";
}

function getClassName(filename) {
  if (!filename) return "Main";
  const base = filename.replace(/\.[^.]+$/, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

module.exports = { detectLanguage, getClassName, EXTENSION_MAP };
