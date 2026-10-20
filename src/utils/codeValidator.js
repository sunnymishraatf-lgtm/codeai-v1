// Structural validation for generated code.
//
// This is NOT a compiler — it catches the common ways AI output breaks
// (missing entry point, missing includes, unbalanced braces, mangled
// Python indentation) so the route can attempt one self-repair retry
// before returning anything. The heavy proof (actually compiling and
// running C / Java / Python) lives in tests/compile-check.js
// (`npm run verify`).

function stripStringsAndComments(code, lang) {
  // Crude but effective: remove string/char literals so delimiters inside
  // them don't skew the balance counts.
  let out = code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  if (["python"].includes(lang)) {
    out = out
      .replace(/"""[\s\S]*?"""/g, "")
      .replace(/'''[\s\S]*?'''/g, "")
      .replace(/#.*$/gm, "");
  } else {
    out = out.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  return out;
}

function checkBalanced(code) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const closers = new Set(Object.values(pairs));
  const stack = [];
  for (const ch of code) {
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (closers.has(ch)) {
      if (stack.pop() !== ch) return false;
    }
  }
  return stack.length === 0;
}

function validateC(code, problems) {
  if (!/#include\s*</.test(code)) {
    problems.push("C code is missing a #include directive");
  }
  if (!/\bint\s+main\s*\(/.test(code) && !/\bvoid\s+main\s*\(/.test(code)) {
    problems.push("C code is missing a main function");
  }
  if (!checkBalanced(stripStringsAndComments(code, "c"))) {
    problems.push("C code has unbalanced braces/brackets/parentheses");
  }
}

function validateJava(code, problems) {
  if (!/public\s+class\s+\w+/.test(code)) {
    problems.push("Java code is missing a public class");
  }
  if (!/public\s+static\s+void\s+main\s*\(/.test(code)) {
    problems.push("Java code is missing public static void main");
  }
  if (!checkBalanced(stripStringsAndComments(code, "java"))) {
    problems.push("Java code has unbalanced braces/brackets/parentheses");
  }
}

function validatePython(code, problems) {
  if (!checkBalanced(stripStringsAndComments(code, "python"))) {
    problems.push("Python code has unbalanced brackets/parentheses");
  }

  // Indentation sanity: Python breaks if tabs and spaces are mixed in
  // leading whitespace, or if a line is indented with tabs while the
  // rest of the file uses spaces.
  const lines = code.split("\n");
  let sawSpaceIndent = false;
  let sawTabIndent = false;
  for (const line of lines) {
    const lead = line.match(/^[\t ]+/);
    if (!lead) continue;
    if (lead[0].includes("\t") && lead[0].includes(" ")) {
      problems.push("Python code mixes tabs and spaces in indentation");
      return;
    }
    if (lead[0].startsWith("\t")) sawTabIndent = true;
    else sawSpaceIndent = true;
  }
  if (sawTabIndent && sawSpaceIndent) {
    problems.push("Python code mixes tab-indented and space-indented lines");
  }
}

function validateCode(code, lang) {
  const problems = [];

  if (!code || typeof code !== "string" || code.trim().length === 0) {
    return { valid: false, problems: ["Generated code is empty"] };
  }

  switch ((lang || "").toLowerCase()) {
    case "c":
      validateC(code, problems);
      break;
    case "java":
      validateJava(code, problems);
      break;
    case "python":
      validatePython(code, problems);
      break;
    default:
      if (!checkBalanced(stripStringsAndComments(code, lang))) {
        problems.push("Code has unbalanced braces/brackets/parentheses");
      }
      break;
  }

  return { valid: problems.length === 0, problems };
}

module.exports = { validateCode, checkBalanced };
