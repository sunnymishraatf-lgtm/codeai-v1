function fixJavaCode(code, filename) {
  if (!code) return code;

  const className = filename
    ? filename.replace(/\.java$/i, "")
    : "Main";

  let lines = code.split("\n");

  // Find which class contains main()
  let mainClassName = null;
  let currentClass = null;
  for (const line of lines) {
    const classMatch = line.match(/(?:public\s+)?class\s+(\w+)/);
    if (classMatch) currentClass = classMatch[1];
    if (line.includes("public static void main") && currentClass) {
      mainClassName = currentClass;
    }
  }

  if (!mainClassName) return code;

  // Step 1: Remove public from ALL classes
  lines = lines.map(line =>
    line.replace(/^(\s*)public\s+(class\s+)/, "$1$2")
  );

  // Step 2: Rename the class that has main() to match filename
  // and make it public
  let renamed = false;
  lines = lines.map(line => {
    if (!renamed) {
      const match = line.match(/^(\s*)class\s+(\w+)(.*)$/);
      if (match && match[2] === mainClassName) {
        renamed = true;
        return `${match[1]}public class ${className}${match[3]}`;
      }
    }
    return line;
  });

  // Step 3: Fix any constructor calls that used the old class name
  if (mainClassName !== className) {
    lines = lines.map(line =>
      line.replace(
        new RegExp(`\\bnew\\s+${mainClassName}\\s*\\(`, "g"),
        `new ${className}(`
      ).replace(
        new RegExp(`\\b${mainClassName}\\s+`, "g"),
        `${className} `
      )
    );
  }

  // Step 4: Strip any remaining markdown fences aggressively
  const result = lines
    .filter(line => !line.trim().startsWith("```"))
    .join("\n")
    .trim();

  return result;
}

module.exports = { fixJavaCode };
