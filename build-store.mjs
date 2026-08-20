// build-store.mjs
// Packages the extension for Chrome Web Store upload into dist/.
//
//   node build-store.mjs                -> dist/store-upload.zip        (updates)
//   node build-store.mjs --first-upload -> dist/store-upload-first.zip (initial upload)
//
// What it does, and why:
// - Regenerates background.js from src/ first (same as `npm run build`), so the
//   uploaded worker always matches the source.
// - Stages ONLY runtime files into dist/store-upload/: manifest.json, background.js,
//   options.html, options.js, popup.*, icons/. No src/, no test/, no git metadata: the
//   store zip is the shippable subset. The staged directory is kept (and tracked) so the
//   unpacked build and the zip are always the same bytes -- never hand-edit it.
// - Strips the "key" field from the copied manifest. The Web Store rejects a first
//   upload whose manifest contains "key"; the store controls identity after that.
// - With --first-upload, includes key.pem at the zip root. On the INITIAL upload this
//   locks the store listing to the same extension ID the key pair produces
//   (cdplkgcjpmplghpflbgolpgafngfjlfo), which preserves chrome.storage.sync data for
//   existing installs. key.pem is looked for next to this script or one directory up.
//   Never include it in update uploads, and never commit it.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const firstUpload = process.argv.includes("--first-upload");

// 1) Rebuild the worker from source.
execSync("node build.mjs", { stdio: "inherit" });

// 2) Stage runtime files. This directory IS the unpacked build, so wipe it first:
//    a stale leftover would otherwise ship inside the zip.
const stage = "dist/store-upload";
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const f of ["background.js", "options.html", "options.js", "popup.html", "popup.js"]) {
  fs.copyFileSync(f, path.join(stage, f));
}
fs.mkdirSync(path.join(stage, "icons"));
for (const f of fs.readdirSync("icons").filter((f) => f.endsWith(".png"))) {
  fs.copyFileSync(path.join("icons", f), path.join(stage, "icons", f));
}

// 3) Manifest without the "key" field.
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
delete manifest.key;
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// 4) key.pem for the first upload only.
if (firstUpload) {
  const candidates = ["key.pem", "../key.pem"];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    console.error(
      "--first-upload needs key.pem (looked in ./ and ../). Without it the store assigns a NEW extension id and synced pins will not carry over."
    );
    process.exit(1);
  }
  fs.copyFileSync(found, path.join(stage, "key.pem"));
}

// 5) Collect the staged files, and normalize every mtime to a fixed instant.
//    Zip records mtimes, so without this an unchanged build still produces different
//    bytes each run -- and the pre-commit hook would churn the tracked zip forever.
//    Sorting the entries pins the archive order too (readdir order is not guaranteed).
const EPOCH = new Date("2020-01-01T00:00:00Z");
const entries = [];
(function walk(dir, rel = "") {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue; // never ship .DS_Store et al
    const abs = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) walk(abs, relPath);
    else {
      fs.utimesSync(abs, EPOCH, EPOCH);
      entries.push(relPath);
    }
  }
})(stage);

// 6) Zip with manifest.json at the ROOT of the archive (store requirement).
//    Delete any previous archive first: `zip` UPDATES an existing file rather than
//    replacing it, so a removed or renamed source file would linger in the upload.
//    -X drops uid/gid and other platform extras, the last source of nondeterminism.
const zipName = firstUpload ? "store-upload-first.zip" : "store-upload.zip";
fs.rmSync(path.join("dist", zipName), { force: true });
execFileSync("zip", ["-qX", `../${zipName}`, ...entries], { cwd: stage, stdio: "inherit" });

// 7) key.pem never belongs in the tracked unpacked build; it only lives in the zip.
if (firstUpload) fs.rmSync(path.join(stage, "key.pem"), { force: true });

const files = firstUpload ? "manifest, worker, options, popup, icons, key.pem" : "manifest, worker, options, popup, icons";
console.log(`dist/${zipName} + dist/store-upload/ written (${files}; manifest "key" stripped, v${manifest.version})`);
