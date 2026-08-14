// build-store.mjs
// Packages the extension for Chrome Web Store upload into dist/.
//
//   node build-store.mjs                -> dist/store-upload.zip        (updates)
//   node build-store.mjs --first-upload -> dist/store-upload-first.zip (initial upload)
//
// What it does, and why:
// - Regenerates background.js from src/ first (same as `npm run build`), so the
//   uploaded worker always matches the source.
// - Copies ONLY runtime files: manifest.json, background.js, options.html, options.js,
//   icons/. No src/, no test/, no git metadata: the store zip is the shippable subset.
// - Strips the "key" field from the copied manifest. The Web Store rejects a first
//   upload whose manifest contains "key"; the store controls identity after that.
// - With --first-upload, includes key.pem at the zip root. On the INITIAL upload this
//   locks the store listing to the same extension ID the key pair produces
//   (cdplkgcjpmplghpflbgolpgafngfjlfo), which preserves chrome.storage.sync data for
//   existing installs. key.pem is looked for next to this script or one directory up.
//   Never include it in update uploads, and never commit it.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const firstUpload = process.argv.includes("--first-upload");

// 1) Rebuild the worker from source.
execSync("node build.mjs", { stdio: "inherit" });

// 2) Stage runtime files.
const stage = "dist/stage";
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const f of ["background.js", "options.html", "options.js"]) {
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

// 5) Zip with manifest.json at the ROOT of the archive (store requirement).
const zipName = firstUpload ? "store-upload-first.zip" : "store-upload.zip";
execSync(`cd ${stage} && zip -qr ../${zipName} .`, { stdio: "inherit" });
fs.rmSync(stage, { recursive: true, force: true });

const files = firstUpload ? "manifest, worker, options, icons, key.pem" : "manifest, worker, options, icons";
console.log(`dist/${zipName} written (${files}; manifest "key" stripped, v${manifest.version})`);
