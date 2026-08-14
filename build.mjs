// build.mjs
// Regenerates background.js from the source modules in src/. The shipped service worker
// is a single classic script (no module loading to break), so this concatenates the
// modules in dependency order, dropping `import` lines and stripping leading `export `
// keywords. Run after any change under src/:  node build.mjs
import fs from "node:fs";

const ORDER = ["src/matcher.js", "src/storage.js", "src/reconcile.js", "src/service-worker.js"];
const HEADER = [
  "// background.js",
  "// Auto Pin Tabs - single-file MV3 service worker (matcher + storage + reconcile + listeners).",
  "// Generated from the tested source modules; matcher logic is identical to the unit-tested matcher.js.",
  "",
];

const parts = [...HEADER];
for (const file of ORDER) {
  parts.push(`// ===== from ${file} =====`);
  const body = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .map((line) => line.replace(/^export /, ""))
    .join("\n");
  parts.push(body);
  parts.push("");
}
fs.writeFileSync("background.js", parts.join("\n"));
console.log("background.js regenerated from", ORDER.length, "modules");
