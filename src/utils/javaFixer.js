// Java post-processing — deliberately conservative.
//
// HISTORY (the bug this rewrite fixes, FIXES.md section G): this module
// used to RENAME classes in generated code to match a filename derived
// from the student's question. Its main-class detection took the LAST
// `class X` line seen before main() — for multi-class answers (a tree
// with a nested TreeNode helper) that is the HELPER class, not the
// class containing main. It then blanket-renamed every occurrence of
// the helper's name to the derived name: the helper's own declaration
// and all its type references were renamed, its constructor was not
// (the pattern needed a space after the name), producing a duplicate
// class name and an orphan constructor — code that cannot compile.
//
// RULE NOW: the filename follows the code, never the reverse. The
// model names its classes (the user prompt ASKS for the problem-
// specific name), the route derives X-Filename from the class that
// actually contains main() (see className.js analyzeJavaClasses), and
// this function only strips stray markdown fence lines that survived
// cleaning. It must NEVER rename, add, or remove a class or member.
//
// The `filename` parameter is kept for call-site compatibility and is
// intentionally unused.
function fixJavaCode(code, filename) {
  if (!code) return code;

  return code
    .split("\n")
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n")
    .trim();
}

module.exports = { fixJavaCode };
