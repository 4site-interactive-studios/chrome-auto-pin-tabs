# Auto Pin Tabs — working notes

A Chrome MV3 extension, published on the Web Store. No dependencies, no bundler,
no framework. Node 18+ runs the tests and the two build scripts; that is the whole
toolchain.

## Generated files — read this before editing anything

Three tracked files are **generated**. Never hand-edit them:

| Generated                | Built from                        |
| ------------------------ | --------------------------------- |
| `background.js`          | `src/*.js` via `node build.mjs`   |
| `dist/store-upload/`     | runtime files via `build-store.mjs` |
| `dist/store-upload.zip`  | same pass as `dist/store-upload/` |

Chrome loads the root `background.js`, **not** `src/`. Editing `src/` alone ships
nothing. `build.mjs` concatenates the four modules in a fixed order
(`matcher` → `storage` → `reconcile` → `service-worker`), strips their `import`/`export`
lines to keep the result a single classic service worker, and runs `node --check` on the
output — a multi-line import once shipped a broken worker, hence the syntax gate.

A pre-commit hook keeps all three in sync automatically (see below), so in normal work
you edit `src/` and commit; the build happens for you. Run `npm run build:store` by hand
only when you need the artifacts before committing.

## The pre-commit hook

`.githooks/pre-commit` is tracked and wired through `core.hooksPath`. On any commit
touching a build input (`src/`, `manifest.json`, `options.*`, `popup.*`, `icons/`, either
build script) it rebuilds all three generated files and stages them into that same commit.
Docs- and test-only commits skip the rebuild.

It also **hard-blocks** a commit where `manifest.json` and `package.json` disagree on
`version`. Both are published surfaces. Bump them together.

If the hook is not running, it is not installed in this clone — `core.hooksPath` is local
config and does not travel with a clone or a push:

```
git config core.hooksPath .githooks
```

`git commit --no-verify` bypasses it. Don't reach for that to get past the version guard;
fix the versions.

**The store zip is built reproducibly on purpose** — fixed mtimes, sorted entries, `zip -X`.
Zip records mtimes, so without that an unchanged rebuild yields different bytes and the hook
would churn the tracked zip on every commit. Do not reintroduce nondeterminism into
`build-store.mjs`. Two consecutive builds must be byte-identical:

```
node build-store.mjs && shasum -a 256 dist/store-upload.zip
```

## Tests

```
npm test
```

`package.json`'s `test` script **enumerates each test file explicitly**. A new
`test/*.test.mjs` that isn't appended to that list silently never runs. The suites are
plain Node with no test framework; most test pure logic directly, and the ones that touch
extension APIs (`reconcile`, `messages`, `cleanup`) stub a `chrome` global themselves.

Tests import from `src/`, while Chrome runs `background.js`. That is exactly why the
build's syntax check and the pre-commit rebuild matter: a green test run does not by
itself prove the shipped worker is valid.

## Never commit `key.pem`

It is the private key pairing with the manifest `key` field, it is gitignored, and it was
already purged from this repo's history once. It belongs only in a `--first-upload` zip,
which is also gitignored. Don't add it, don't paste its contents, don't echo it into logs.

## Store packaging

`npm run build:store` produces the update package. `node build-store.mjs --first-upload`
bundles `key.pem` to preserve the extension ID — that upload is already done, so it should
not be needed again. `build-store.mjs` strips the manifest `key` field from the copy it
ships; the Web Store rejects an upload that contains it.

`STORE.md` has the submission walkthrough and dashboard answers. `PRIVACY.md` is the
privacy policy the listing links to. `README.md` documents the extension's behavior for
users and has the fuller developer notes.

## Conventions

- No dependencies. Keep it that way unless there's a strong reason; `package.json` exists
  for tooling only and Chrome ignores it.
- Comments explain *why*, not *what* — the existing code and build scripts are commented
  in that style. Match it.
- Pin matching lives in `src/matcher.js` and is the most test-covered part of the codebase.
  Changing matching behavior without adding a case to `test/matcher.test.mjs` is a red flag.
