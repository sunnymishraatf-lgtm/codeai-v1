// ============================================================================
// COMPILE / RUN VERIFICATION SUITE  —  npm run verify
//
// Purpose: prove that code pushed through this app's own pipeline
// (codeCleaner -> javaFixer -> codeValidator) actually compiles and runs
// error-free for C, Java, and Python.
//
// Method: for 6 classic problems x 3 languages, plus a Java-only
// multi-class regression case (binary tree with a nested node class),
// take a REALISTIC MESSY raw output (markdown fences + chatter —
// hand-written FIXTURES, labeled as such; these are NOT claimed to be
// AI output), run it through the pipeline, write the result to a temp
// file, then really compile/run it. For Java the file is named after
// the class that actually contains main() in the fixture — the
// pipeline must never rename a class to make a filename fit:
//   C      -> gcc -std=c11 ... && ./prog
//   Python -> python3 file.py
//   Java   -> javac File.java && java Class   (SKIPPED, with a loud
//             warning, if javac is not installed on this machine —
//             structural validation still runs. A skip is never
//             reported as a pass.)
// Expected stdout is asserted for every case.
//
// Exit code is 1 if any non-skipped case fails.
// ============================================================================

process.env.NODE_ENV = "test";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const { cleanCode } = require("../src/utils/codeCleaner");
const { fixJavaCode } = require("../src/utils/javaFixer");
const { validateCode } = require("../src/utils/codeValidator");
const { findJavaEntryClass } = require("../src/utils/className");

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, ...opts }, (err, stdout, stderr) => {
      resolve({
        code: err ? err.code ?? 1 : 0,
        stdout: (stdout || "").toString(),
        stderr: (stderr || "").toString(),
      });
    });
  });
}

async function hasCmd(cmd) {
  const r = await run(cmd, ["--version"]);
  return r.code === 0 || r.stdout.length > 0 || r.stderr.length > 0;
}

// ---------------------------------------------------------------------------
// FIXTURES — messy raw outputs (fences + chatter), one per problem/language.
// ---------------------------------------------------------------------------
const PROBLEMS = [
  {
    id: "binary-search",
    expectedStdout: "3",
    c: "Here is the code:\n\n```c\n#include <stdio.h>\nint main(void) {\n    int arr[] = {1, 3, 5, 7, 9, 11};\n    int n = 6, target = 7, lo = 0, hi = n - 1, ans = -1;\n    while (lo <= hi) {\n        int mid = lo + (hi - lo) / 2;\n        if (arr[mid] == target) { ans = mid; break; }\n        else if (arr[mid] < target) lo = mid + 1;\n        else hi = mid - 1;\n    }\n    printf(\"%d\\n\", ans);\n    return 0;\n}\n```",
    java: "Sure, here is your solution:\n\n```java\npublic class Main {\n    public static void main(String[] args) {\n        int[] arr = {1, 3, 5, 7, 9, 11};\n        int target = 7, lo = 0, hi = arr.length - 1, ans = -1;\n        while (lo <= hi) {\n            int mid = lo + (hi - lo) / 2;\n            if (arr[mid] == target) { ans = mid; break; }\n            else if (arr[mid] < target) lo = mid + 1;\n            else hi = mid - 1;\n        }\n        System.out.println(ans);\n    }\n}\n```",
    python: "Here is the code:\n\n```python\ndef binary_search(arr, target):\n    lo, hi = 0, len(arr) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if arr[mid] == target:\n            return mid\n        elif arr[mid] < target:\n            lo = mid + 1\n        else:\n            hi = mid - 1\n    return -1\n\nprint(binary_search([1, 3, 5, 7, 9, 11], 7))\n```",
  },
  {
    id: "fibonacci",
    expectedStdout: "0 1 1 2 3 5 8 13 21 34",
    c: "```c\n#include <stdio.h>\nint main(void) {\n    long a = 0, b = 1;\n    for (int i = 0; i < 10; i++) {\n        printf(\"%ld\", a);\n        if (i < 9) printf(\" \");\n        long next = a + b;\n        a = b;\n        b = next;\n    }\n    printf(\"\\n\");\n    return 0;\n}\n```",
    java: "```java\npublic class Main {\n    public static void main(String[] args) {\n        long a = 0, b = 1;\n        for (int i = 0; i < 10; i++) {\n            System.out.print(a);\n            if (i < 9) System.out.print(\" \");\n            long next = a + b;\n            a = b;\n            b = next;\n        }\n        System.out.println();\n    }\n}\n```",
    python: "```python\na, b = 0, 1\nout = []\nfor _ in range(10):\n    out.append(str(a))\n    a, b = b, a + b\nprint(\" \".join(out))\n```",
  },
  {
    id: "palindrome",
    expectedStdout: "palindrome",
    c: "```c\n#include <stdio.h>\n#include <string.h>\nint main(void) {\n    const char *s = \"racecar\";\n    int n = strlen(s), ok = 1;\n    for (int i = 0; i < n / 2; i++) {\n        if (s[i] != s[n - 1 - i]) { ok = 0; break; }\n    }\n    printf(\"%s\\n\", ok ? \"palindrome\" : \"not palindrome\");\n    return 0;\n}\n```",
    java: "```java\npublic class Main {\n    public static void main(String[] args) {\n        String s = \"racecar\";\n        boolean ok = true;\n        for (int i = 0; i < s.length() / 2; i++) {\n            if (s.charAt(i) != s.charAt(s.length() - 1 - i)) { ok = false; break; }\n        }\n        System.out.println(ok ? \"palindrome\" : \"not palindrome\");\n    }\n}\n```",
    python: "```python\ns = \"racecar\"\nprint(\"palindrome\" if s == s[::-1] else \"not palindrome\")\n```",
  },
  {
    id: "factorial",
    expectedStdout: "120",
    c: "```c\n#include <stdio.h>\nint main(void) {\n    long fact = 1;\n    for (int i = 2; i <= 5; i++) fact *= i;\n    printf(\"%ld\\n\", fact);\n    return 0;\n}\n```",
    java: "```java\npublic class Main {\n    public static void main(String[] args) {\n        long fact = 1;\n        for (int i = 2; i <= 5; i++) fact *= i;\n        System.out.println(fact);\n    }\n}\n```",
    python: "```python\nfact = 1\nfor i in range(2, 6):\n    fact *= i\nprint(fact)\n```",
  },
  {
    id: "prime-check",
    expectedStdout: "prime",
    c: "```c\n#include <stdio.h>\n#include <math.h>\nint main(void) {\n    int n = 29, ok = 1;\n    if (n < 2) ok = 0;\n    for (int i = 2; i * i <= n; i++) {\n        if (n % i == 0) { ok = 0; break; }\n    }\n    printf(\"%s\\n\", ok ? \"prime\" : \"not prime\");\n    return 0;\n}\n```",
    java: "```java\npublic class Main {\n    public static void main(String[] args) {\n        int n = 29;\n        boolean ok = n >= 2;\n        for (int i = 2; i * i <= n; i++) {\n            if (n % i == 0) { ok = false; break; }\n        }\n        System.out.println(ok ? \"prime\" : \"not prime\");\n    }\n}\n```",
    python: "```python\nn = 29\nok = n >= 2 and all(n % i != 0 for i in range(2, int(n ** 0.5) + 1))\nprint(\"prime\" if ok else \"not prime\")\n```",
  },
  {
    id: "bubble-sort",
    expectedStdout: "1 2 5 7 9",
    c: "```c\n#include <stdio.h>\nint main(void) {\n    int arr[] = {5, 2, 9, 1, 7};\n    int n = 5;\n    for (int i = 0; i < n - 1; i++) {\n        for (int j = 0; j < n - 1 - i; j++) {\n            if (arr[j] > arr[j + 1]) {\n                int t = arr[j]; arr[j] = arr[j + 1]; arr[j + 1] = t;\n            }\n        }\n    }\n    for (int i = 0; i < n; i++) {\n        printf(\"%d\", arr[i]);\n        if (i < n - 1) printf(\" \");\n    }\n    printf(\"\\n\");\n    return 0;\n}\n```",
    java: "```java\npublic class Main {\n    public static void main(String[] args) {\n        int[] arr = {5, 2, 9, 1, 7};\n        for (int i = 0; i < arr.length - 1; i++) {\n            for (int j = 0; j < arr.length - 1 - i; j++) {\n                if (arr[j] > arr[j + 1]) {\n                    int t = arr[j]; arr[j] = arr[j + 1]; arr[j + 1] = t;\n                }\n            }\n        }\n        for (int i = 0; i < arr.length; i++) {\n            System.out.print(arr[i]);\n            if (i < arr.length - 1) System.out.print(\" \");\n        }\n        System.out.println();\n    }\n}\n```",
    python: "```python\narr = [5, 2, 9, 1, 7]\nfor i in range(len(arr) - 1):\n    for j in range(len(arr) - 1 - i):\n        if arr[j] > arr[j + 1]:\n            arr[j], arr[j + 1] = arr[j + 1], arr[j]\nprint(\" \".join(str(x) for x in arr))\n```",
  },
  {
    // Regression case for the multi-class mangling bug (FIXES.md G),
    // using Sunny's exact question. The fixture's main class is
    // "BinaryTree" — NOT the prompt-derived "BinaryTreeLinkedList" —
    // with a nested TreeNode helper class. The pipeline must keep both
    // class names exactly as written, derive the filename from the
    // code (BinaryTree.java), and the result must compile and run.
    id: "binary-tree-linked-list",
    prompt: "write a java program to implement binary tree using linked list",
    expectedStdout: "Inorder traversal: [2, 3, 4, 5, 6, 7, 8]",
    expectedEntryClass: "BinaryTree",
    mustContain: ["static class TreeNode", "TreeNode(int data)"],
    java: "Here is the code:\n\n```java\nimport java.util.*;\n\npublic class BinaryTree {\n    static class TreeNode {\n        int data;\n        TreeNode left, right;\n        TreeNode(int data) { this.data = data; }\n    }\n    private TreeNode root;\n    public void insert(int value) { root = insertRec(root, value); }\n    private TreeNode insertRec(TreeNode node, int value) {\n        if (node == null) return new TreeNode(value);\n        if (value < node.data) node.left = insertRec(node.left, value);\n        else if (value > node.data) node.right = insertRec(node.right, value);\n        return node;\n    }\n    private void inorder(TreeNode node, List<Integer> list) {\n        if (node == null) return;\n        inorder(node.left, list);\n        list.add(node.data);\n        inorder(node.right, list);\n    }\n    public static void main(String[] args) {\n        BinaryTree tree = new BinaryTree();\n        int[] values = {5, 3, 7, 2, 4, 6, 8};\n        for (int v : values) tree.insert(v);\n        List<Integer> result = new ArrayList<>();\n        tree.inorder(tree.root, result);\n        System.out.println(\"Inorder traversal: \" + result);\n    }\n}\n```",
  },
];

async function checkC(problem, dir) {
  const file = path.join(dir, "main.c");
  const exe = path.join(dir, "prog");
  const code = cleanCode(problem.c, "c");
  const v = validateCode(code, "c");
  if (!v.valid) return { status: "FAIL", detail: "validator: " + v.problems.join("; ") };
  fs.writeFileSync(file, code);
  const comp = await run("gcc", ["-std=c11", "-Wall", "-o", exe, file, "-lm"]);
  if (comp.code !== 0) return { status: "FAIL", detail: "gcc: " + comp.stderr.trim().slice(0, 300) };
  const exec = await run(exe, []);
  if (exec.code !== 0) return { status: "FAIL", detail: "run exit " + exec.code + ": " + exec.stderr.trim().slice(0, 200) };
  if (!exec.stdout.includes(problem.expectedStdout))
    return { status: "FAIL", detail: `stdout "${exec.stdout.trim()}" missing "${problem.expectedStdout}"` };
  return { status: "PASS", detail: `compiled + ran, stdout: ${exec.stdout.trim()}` };
}

async function checkPython(problem, dir) {
  const file = path.join(dir, "main.py");
  const code = cleanCode(problem.python, "python");
  const v = validateCode(code, "python");
  if (!v.valid) return { status: "FAIL", detail: "validator: " + v.problems.join("; ") };
  fs.writeFileSync(file, code);
  const exec = await run("python3", [file]);
  if (exec.code !== 0) return { status: "FAIL", detail: "python3: " + exec.stderr.trim().slice(0, 300) };
  if (!exec.stdout.includes(problem.expectedStdout))
    return { status: "FAIL", detail: `stdout "${exec.stdout.trim()}" missing "${problem.expectedStdout}"` };
  return { status: "PASS", detail: `ran, stdout: ${exec.stdout.trim()}` };
}

async function checkJava(problem, dir, javacAvailable) {
  let code = cleanCode(problem.java, "java");
  code = fixJavaCode(code);
  const v = validateCode(code, "java");
  if (!v.valid) return { status: "FAIL", detail: "validator: " + v.problems.join("; ") };
  // The filename follows the code, never the reverse: the entry class
  // is the class that actually contains main() in the fixture, and the
  // pipeline must not have renamed anything to get there.
  const className = findJavaEntryClass(code);
  if (!className)
    return { status: "FAIL", detail: "no entry class (class containing main) found" };
  if (problem.expectedEntryClass && className !== problem.expectedEntryClass)
    return { status: "FAIL", detail: `entry class "${className}" != expected "${problem.expectedEntryClass}"` };
  for (const frag of problem.mustContain || []) {
    if (!code.includes(frag))
      return { status: "FAIL", detail: `pipeline altered the code: missing "${frag}"` };
  }
  if (!javacAvailable)
    return { status: "SKIP", detail: "javac NOT installed — structural validation only, compile NOT verified" };
  const filename = className + ".java";
  const file = path.join(dir, filename);
  fs.writeFileSync(file, code);
  const comp = await run("javac", [file]);
  if (comp.code !== 0) return { status: "FAIL", detail: "javac: " + comp.stderr.trim().slice(0, 300) };
  const exec = await run("java", ["-cp", dir, className]);
  if (exec.code !== 0) return { status: "FAIL", detail: "java run: " + exec.stderr.trim().slice(0, 200) };
  if (!exec.stdout.includes(problem.expectedStdout))
    return { status: "FAIL", detail: `stdout "${exec.stdout.trim()}" missing "${problem.expectedStdout}"` };
  return { status: "PASS", detail: `compiled + ran, stdout: ${exec.stdout.trim()}` };
}

(async () => {
  const javacAvailable = await hasCmd("javac");
  const gccAvailable = await hasCmd("gcc");
  const pythonAvailable = await hasCmd("python3");

  console.log("\n=== Compile/Run Verification (fixtures through the app pipeline) ===");
  console.log(`gcc: ${gccAvailable ? "yes" : "NO"} | python3: ${pythonAvailable ? "yes" : "NO"} | javac: ${javacAvailable ? "yes" : "NO — Java compile checks will SKIP"}\n`);

  let pass = 0, fail = 0, skip = 0;
  const rows = [];

  for (const problem of PROBLEMS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeai-verify-"));
    const results = {};
    if (problem.c) results.c = gccAvailable ? await checkC(problem, dir) : { status: "SKIP", detail: "gcc missing" };
    if (problem.python) results.python = pythonAvailable ? await checkPython(problem, dir) : { status: "SKIP", detail: "python3 missing" };
    if (problem.java) results.java = await checkJava(problem, dir, javacAvailable);
    for (const lang of ["c", "java", "python"]) {
      const r = results[lang];
      if (!r) continue;
      if (r.status === "PASS") pass++;
      else if (r.status === "SKIP") skip++;
      else fail++;
      rows.push([problem.id, lang, r.status, r.detail]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  for (const [id, lang, status, detail] of rows) {
    const mark = status === "PASS" ? "✓" : status === "SKIP" ? "–" : "✗";
    console.log(`  ${mark} ${id.padEnd(14)} ${lang.padEnd(7)} ${status.padEnd(5)} ${detail}`);
  }

  console.log(`\n=============================`);
  console.log(`Compile/run results: ${pass} passed, ${fail} failed, ${skip} skipped`);
  console.log(`=============================\n`);

  if (fail > 0) process.exit(1);
})().catch((err) => {
  console.error("compile-check crashed:", err);
  process.exit(1);
});
