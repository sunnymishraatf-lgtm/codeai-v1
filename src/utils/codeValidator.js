// Structural validation for generated code.
//
// This is NOT a compiler — it catches the common ways AI output breaks
// (missing entry point, missing includes, unbalanced braces, mangled
// Python indentation, duplicate Java class names, orphan Java
// constructors) so the route can attempt self-repair retries before
// returning anything. The heavy proof (actually compiling and
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

// All type names a Java file declares (class / interface / enum /
// record), in declaration order, duplicates included.
function declaredJavaTypes(strippedCode) {
  const names = [];
  const re = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(strippedCode)) !== null) names.push(m[1]);
  return names;
}

function validateJava(code, problems) {
  if (!/public\s+class\s+\w+/.test(code)) {
    problems.push("Java code is missing a public class");
  }
  if (!/public\s+static\s+void\s+main\s*\(/.test(code)) {
    problems.push("Java code is missing public static void main");
  }
  const stripped = stripStringsAndComments(code, "java");
  if (!checkBalanced(stripped)) {
    problems.push("Java code has unbalanced braces/brackets/parentheses");
  }

  const declared = declaredJavaTypes(stripped);

  // Duplicate type names: two types with the same simple name in one
  // file (e.g. an outer class and a nested helper both renamed to the
  // same name by a bad post-processor) confuse javac and students
  // alike — the file no longer means what it says.
  const counts = new Map();
  for (const name of declared) counts.set(name, (counts.get(name) || 0) + 1);
  for (const [name, count] of counts) {
    if (count > 1) {
      problems.push(`Java code declares class "${name}" more than once`);
    }
  }

  // Orphan constructors: a member declaration `Name(...) { ... }` with
  // no return type is a constructor, so Name must be one of the types
  // the file declares. A leftover `TreeNode(int data) { ... }` inside a
  // class that declares no TreeNode is exactly the javac error
  // "invalid method declaration; return type required".
  const declaredSet = new Set(declared);
  const ctorRe =
    /(?:^|[{};])\s*(?:(?:public|private|protected)\s+)?([A-Z][A-Za-z0-9_$]*)\s*\([^{}]*\)\s*(?:throws\s+[A-Za-z0-9_$.,\s]+?)?\{/gm;
  const reported = new Set();
  let cm;
  while ((cm = ctorRe.exec(stripped)) !== null) {
    const name = cm[1];
    if (declaredSet.has(name) || reported.has(name)) continue;
    // Names with no lowercase letters are conventionally enum
    // constants with class bodies (RED(1) { ... }), not constructors.
    if (!/[a-z]/.test(name)) continue;
    reported.add(name);
    problems.push(
      `Java code has a constructor "${name}" that does not match any declared class`
    );
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

module.exports = { validateCode, checkBalanced, stripStringsAndComments, declaredJavaTypes };
