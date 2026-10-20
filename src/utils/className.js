// Derive a problem-specific PascalCase Java class name from a prompt.
//
// Terminal users never send a filename, so without this every Java answer
// came back as "public class Main" and students had to rename the class
// before javac would even accept the file. The generate route uses this
// to build a derived filename ("BinarySearch.java") which flows into the
// user prompt as the REQUESTED public class name, so the model names its
// class after the problem.
//
// The filename in the RESPONSE, however, follows the generated code,
// never the reverse: analyzeJavaClasses() below finds the class that
// actually contains main() in the model's output, and that name becomes
// X-Filename. Nothing on the server ever renames a class in generated
// code (an earlier javaFixer did, and mangled multi-class answers —
// see FIXES.md section G).
//
// Examples:
//   "write binary search"      -> BinarySearch
//   "binary search in java"    -> BinarySearch
//   "check palindrome"         -> CheckPalindrome
//   "fibonacci series"         -> FibonacciSeries
//   "reverse a linked list"    -> ReverseLinkedList
//   "bubble sort"              -> BubbleSort
//   ""                         -> Solution   (fallback, never "Main")

// Words that carry no problem meaning: request filler + language names.
const FILLER_WORDS = new Set([
  "write", "a", "an", "the", "program", "programme", "to", "in", "code",
  "for", "wap", "please", "print", "using", "function", "method",
  "of", "on", "that", "which", "returns", "returning", "return",
  "whether", "is", "are", "given",
  "implement", "create", "generate", "build", "develop", "make",
  // language names / file-ish tokens (the language is chosen separately)
  "java", "python", "py", "javascript", "js", "typescript", "ts",
  "c", "cpp", "csharp", "go", "golang", "rust", "kotlin", "swift",
  "php", "ruby", "rb",
]);

const FALLBACK = "Solution";
const MAX_WORDS = 4;
const MAX_CHARS = 40;

function deriveClassName(prompt) {
  if (!prompt || typeof prompt !== "string") return FALLBACK;

  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !FILLER_WORDS.has(w));

  if (words.length === 0) return FALLBACK;

  let name = words
    .slice(0, MAX_WORDS)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

  // Cap total length (~40 chars); a truncated PascalCase name is still a
  // valid, meaningful class name.
  if (name.length > MAX_CHARS) name = name.slice(0, MAX_CHARS);
  if (!name) return FALLBACK;

  // A class name cannot start with a digit.
  if (/^\d/.test(name)) name = "Program" + name;

  return name;
}

// ---------------------------------------------------------------------------
// Structural analysis of generated Java code.
// ---------------------------------------------------------------------------

const { stripStringsAndComments } = require("./codeValidator");

// Scan Java source and report:
//   entryClass      — the type whose body contains `public static void
//                     main(`, i.e. the innermost type on the brace stack
//                     when main is seen (null when there is no main).
//   topLevelClasses — types declared at brace depth 0, in order.
//   declaredClasses — every declared type name, in order.
//
// Strings and comments are stripped first so braces or the word
// "class" inside them cannot skew the scan. This is a structural
// heuristic, not a parser — it exists so the response filename can
// follow the code the model actually wrote.
function analyzeJavaClasses(code) {
  const result = { entryClass: null, topLevelClasses: [], declaredClasses: [] };
  if (!code || typeof code !== "string") return result;

  const stripped = stripStringsAndComments(code, "java");
  const tokenRe =
    /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)|\bpublic\s+static\s+void\s+main\s*\(|[{}]/g;

  let depth = 0;
  let pending = null; // last type name seen, waiting for its opening brace
  const stack = []; // { name, depth } — depth = brace depth of the type body
  let m;
  while ((m = tokenRe.exec(stripped)) !== null) {
    if (m[1] !== undefined) {
      pending = m[1];
      result.declaredClasses.push(m[1]);
    } else if (m[0] === "{") {
      depth++;
      if (pending) {
        stack.push({ name: pending, depth });
        if (depth === 1) result.topLevelClasses.push(pending);
        pending = null;
      }
    } else if (m[0] === "}") {
      while (stack.length && stack[stack.length - 1].depth === depth) {
        stack.pop();
      }
      depth--;
    } else {
      // main(): the innermost enclosing type is the entry class.
      if (!result.entryClass && stack.length) {
        result.entryClass = stack[stack.length - 1].name;
      }
    }
  }
  return result;
}

// The class a Java file should be named after: the one containing
// main(), else the single top-level class, else null.
function findJavaEntryClass(code) {
  const { entryClass, topLevelClasses } = analyzeJavaClasses(code);
  if (entryClass) return entryClass;
  if (topLevelClasses.length === 1) return topLevelClasses[0];
  return null;
}

// Base name (no extension) for the response filename: the entry class
// from the code itself; deriveClassName(prompt) only when the code has
// no identifiable entry class.
function resolveJavaFileBase(code, prompt) {
  return findJavaEntryClass(code) || deriveClassName(prompt);
}

module.exports = {
  deriveClassName,
  analyzeJavaClasses,
  findJavaEntryClass,
  resolveJavaFileBase,
};
