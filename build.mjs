// build.mjs
// Regenerates background.js from the source modules in src/. The shipped service worker
// is a single classic script (no module loading to break), so this concatenates the
// modules in dependency order, dropping `import` statements (including multi-line ones)
// and stripping leading `export ` keywords. The result is syntax-checked before it is
// accepted, so a bad strip can never ship. Run after any change under src/:  node build.mjs
import { execFileSync } from "node:child_process";
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
    // Whole import statements, however many lines they span, up to their closing quote.
    .replace(/^import\s[\s\S]*?["'];[^\S\n]*$/gm, "")
    .split("\n")
    .map((line) => line.replace(/^export /, ""))
    .join("\n")
    .replace(/^\n+/, "");
  parts.push(body);
  parts.push("");
}
fs.writeFileSync("background.js", parts.join("\n"));

// A classic worker script must parse standalone; fail the build loudly if it doesn't.
try {
  execFileSync(process.execPath, ["--check", "background.js"], { stdio: "pipe" });
} catch (e) {
  console.error("background.js failed its syntax check — NOT shippable:\n" + e.stderr);
  process.exit(1);
}
console.log("background.js regenerated from", ORDER.length, "modules (syntax check passed)");
