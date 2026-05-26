#!/usr/bin/env node
/**
 * Trims the deployment image down to fit under Replit Autoscale's 8 GiB
 * cap. Runs AFTER `next build` (which was invoked with NEXT_OUTPUT=
 * standalone) and AFTER `backend npm install`. Strategy:
 *
 *   1. Copy `public/` and `.next/static/` into `.next/standalone/` —
 *      Next.js standalone output expects them inside that dir at runtime.
 *   2. Optionally remove root `node_modules/` (replaced by the much smaller
 *      `.next/standalone/node_modules/` that Next.js traced). Saves ~5 GB
 *      in deployment images, but must not run during local validation.
 *   3. Remove every other `.next/*` entry except `standalone/`.
 *   4. Remove caches, dev artifacts, and other heavy junk that should
 *      never be in a production image.
 *
 * Backend lives at `backend/` with its own `backend/node_modules` — that
 * tree is left intact because `scripts/start-all.cjs` spawns it as a
 * separate Node process from that directory.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NEXT_DIR = path.join(ROOT, ".next");
const STANDALONE = path.join(NEXT_DIR, "standalone");
const PRUNE_WORKSPACE =
  process.env.POSTBUILD_SLIM_PRUNE_WORKSPACE === "1" ||
  process.env.REPLIT_DEPLOYMENT === "1";

function log(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), scope: "postbuild-slim", msg, ...extra }) + "\n");
}

function rm(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
  log("removed", { path: path.relative(ROOT, p) });
}

function cpDir(src, dst) {
  if (!fs.existsSync(src)) { log("skip copy (missing src)", { src }); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  log("copied", { src: path.relative(ROOT, src), dst: path.relative(ROOT, dst) });
}

if (!fs.existsSync(STANDALONE)) {
  log("no standalone output found — was the build run with NEXT_OUTPUT=standalone?", { standalone: STANDALONE });
  process.exit(1);
}

cpDir(path.join(ROOT, "public"), path.join(STANDALONE, "public"));
cpDir(path.join(NEXT_DIR, "static"), path.join(STANDALONE, ".next", "static"));

for (const entry of fs.readdirSync(NEXT_DIR)) {
  if (entry === "standalone") continue;
  rm(path.join(NEXT_DIR, entry));
}

if (PRUNE_WORKSPACE) {
  rm(path.join(ROOT, "node_modules"));

  for (const junk of [
    ".cache",
    ".local",
    "artifacts",
    "attached_assets",
    "test-results",
    ".playwright-cli",
    ".test-dist",
    "output",
    "backend/.cache",
    "backend/.npm",
    "backend/dist",
    "backend/coverage",
    "backend/.next",
    "backend/tests",
    "backend/test",
    "backend/coverage_html",
  ]) {
    rm(path.join(ROOT, junk));
  }
} else {
  log("workspace prune skipped", {
    reason: "set POSTBUILD_SLIM_PRUNE_WORKSPACE=1 or REPLIT_DEPLOYMENT=1 to remove root artifacts",
  });
}

log("done");
