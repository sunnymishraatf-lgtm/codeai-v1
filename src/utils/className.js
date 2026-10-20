// Derive a problem-specific PascalCase Java class name from a prompt.
//
// Terminal users never send a filename, so without this every Java answer
// came back as "public class Main" and students had to rename the class
// before javac would even accept the file. The generate route uses this
// to build a derived filename ("BinarySearch.java") which then flows
// through the existing user-prompt + javaFixer machinery, so the class
// in the returned code matches the problem.
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

module.exports = { deriveClassName };
