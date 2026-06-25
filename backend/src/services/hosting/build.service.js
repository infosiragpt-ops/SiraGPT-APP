'use strict';

/**
 * hosting/build.service — detect a build plan and run a one-shot production
 * build inside an already-cloned workspace, then resolve the real output dir.
 *
 * Mirrors the spawn / log / Windows-safe-kill conventions of
 * github/workspace-runner.service.js but runs to completion (not a dev server).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scrubbedBuildEnv, assertSafeBuildCommand, assertSafeRelPath } = require('./safety');

const IS_WIN = process.platform === 'win32';
const BUILD_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — install + build
// Grace after SIGTERM before escalating to SIGKILL — a build (or a
// SIGTERM-trapping npm/postinstall grandchild) that ignores the polite signal
// would otherwise leak as an orphaned process on the platform host.
const SIGKILL_GRACE_MS = Number(process.env.SIRAGPT_BUILD_SIGKILL_GRACE_MS) || 5000;
const OUTPUT_CANDIDATES = ['dist', 'build', 'out', '.output/public', 'public'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function dirHasFiles(p) {
  try {
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

/**
 * Decide how to build a project.
 * @returns {{ kind:'node'|'static'|'none', framework:string, buildCommand:string|null, outputDir:string }}
 */
function detectBuildPlan(localPath) {
  const pkg = readJson(path.join(localPath, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const scripts = pkg.scripts || {};
    if (deps.next) {
      // Static hosting needs an exported site (`output: 'export'` → out/).
      return { kind: 'node', framework: 'next', buildCommand: 'npm run build', outputDir: 'out' };
    }
    if (deps.vite || /vite/.test(scripts.build || '')) {
      return { kind: 'node', framework: 'vite', buildCommand: 'npm run build', outputDir: 'dist' };
    }
    if (scripts.build) {
      return { kind: 'node', framework: 'custom', buildCommand: 'npm run build', outputDir: 'dist' };
    }
    // package.json but nothing to build → treat as static if there's an index.
    if (fs.existsSync(path.join(localPath, 'index.html'))) {
      return { kind: 'static', framework: 'static', buildCommand: null, outputDir: '.' };
    }
    return { kind: 'none', framework: pkg.name ? 'node' : 'unknown', buildCommand: null, outputDir: '.' };
  }
  if (fs.existsSync(path.join(localPath, 'index.html'))) {
    return { kind: 'static', framework: 'static', buildCommand: null, outputDir: '.' };
  }
  return { kind: 'none', framework: 'unknown', buildCommand: null, outputDir: '.' };
}

/** Pick the real output dir after a build: prefer the hint, else known dirs. */
function resolveOutputDir(localPath, hintDir) {
  // SECURITY: a user-supplied outputDir must stay inside the workspace — reject
  // absolute paths and `..` so the deploy can't read/upload platform files.
  assertSafeRelPath(hintDir, 'outputDir');
  if (hintDir && hintDir !== '.') {
    const abs = path.join(localPath, hintDir);
    if (dirHasFiles(abs)) return hintDir;
  } else if (hintDir === '.') {
    return '.';
  }
  for (const cand of OUTPUT_CANDIDATES) {
    if (dirHasFiles(path.join(localPath, cand))) return cand;
  }
  return hintDir || '.';
}

/**
 * Run `npm install && <buildCommand>` in localPath, streaming logs via onLog.
 * Resolves on exit 0, rejects (with logs captured) otherwise. A static project
 * with no buildCommand resolves immediately.
 */
function runBuild(localPath, { buildCommand, onLog = () => {}, signal, env: extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (!buildCommand) {
      onLog('[build] static project — no build step');
      return resolve({ skipped: true });
    }
    // SECURITY: buildCommand is user-supplied and runs through a shell on the
    // PLATFORM host — reject shell metacharacters so it can't break out of the
    // intended `npm install && <cmd>`.
    let safeBuildCommand;
    try {
      safeBuildCommand = assertSafeBuildCommand(buildCommand);
    } catch (err) {
      onLog(`[build] ${err.message}`);
      return reject(err);
    }
    const full = `npm install && ${safeBuildCommand}`;
    onLog(`[build] ${full}`);
    const proc = spawn(full, {
      cwd: localPath,
      shell: true,
      // NOTE: do NOT set NODE_ENV=production here — that makes `npm install`
      // skip devDependencies (vite, typescript live there), breaking the build.
      // SECURITY: an untrusted repo's install/build scripts run here, so use a
      // scrubbed env (allowlist) — NEVER spread process.env, which would leak
      // ENCRYPTION_KEY (seals every user's hosting creds), JWT_SECRET, Stripe
      // keys, DATABASE_URL, etc. into the build.
      env: scrubbedBuildEnv(extraEnv),
      windowsHide: true,
    });

    const onData = (d) => String(d).split('\n').forEach((l) => l.trim() && onLog(l.replace(/\s+$/, '')));
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    let killTimer = null;
    const onAbort = () => {
      try {
        if (IS_WIN) {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          proc.kill('SIGTERM');
          // Escalate to SIGKILL if it's still alive after the grace window.
          killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, SIGKILL_GRACE_MS);
          killTimer.unref?.();
        }
      } catch {
        /* ignore */
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      onLog('[build] timed out');
      onAbort();
    }, BUILD_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`Build failed to start: ${err.message}`));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      if (code === 0) resolve({ code });
      else reject(new Error(`Build exited with code ${code}`));
    });
  });
}

const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.ts',
  'src/main.jsx',
  'src/main.js',
  'src/index.tsx',
  'src/index.jsx',
  'main.tsx',
  'main.jsx',
];

/**
 * Vite footgun guard: a Vite build only bundles the app if `index.html`
 * contains a `<script type="module" src="…main.*">` entry. AI-generated
 * projects often omit it, producing a blank deployed page. If we detect a Vite
 * project whose index.html is missing the entry script, inject it before the
 * build so the bundle (and assets) are actually generated. Idempotent + safe.
 */
function ensureViteEntry(localPath, onLog = () => {}) {
  try {
    const pkg = readJson(path.join(localPath, 'package.json'));
    const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
    if (!deps.vite) return false; // only Vite uses index.html as the entry
    const indexPath = path.join(localPath, 'index.html');
    if (!fs.existsSync(indexPath)) return false;
    let html = fs.readFileSync(indexPath, 'utf8');
    if (/<script[^>]*type=["']module["'][^>]*\bsrc=/.test(html)) return false; // already has entry
    const entry = ENTRY_CANDIDATES.find((c) => fs.existsSync(path.join(localPath, c)));
    if (!entry) return false;
    const tag = `    <script type="module" src="/${entry}"></script>\n`;
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${tag}  </body>`);
    else html += `\n${tag}`;
    fs.writeFileSync(indexPath, html, 'utf8');
    onLog(`[build] index.html was missing its entry — injected <script src="/${entry}">`);
    return true;
  } catch {
    return false;
  }
}

/** Does the output dir actually contain a JS bundle? (sanity check for blanks) */
function hasJsBundle(absDir) {
  try {
    const walk = (d, depth) => {
      if (depth > 3) return false;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (walk(path.join(d, ent.name), depth + 1)) return true;
        } else if (/\.(js|mjs)$/.test(ent.name)) {
          return true;
        }
      }
      return false;
    };
    return walk(absDir, 0);
  } catch {
    return false;
  }
}

/**
 * Write a SPA-friendly `.htaccess` into the output dir so client-side routes
 * (e.g. /about) don't 404 on Hostinger's Apache/LiteSpeed — every non-file
 * request falls back to index.html. Skips if one exists or there's no index.
 */
function ensureSpaHtaccess(outputAbsDir) {
  try {
    if (!fs.existsSync(path.join(outputAbsDir, 'index.html'))) return false;
    const target = path.join(outputAbsDir, '.htaccess');
    if (fs.existsSync(target)) return false;
    const content = [
      '<IfModule mod_rewrite.c>',
      '  RewriteEngine On',
      '  RewriteBase /',
      '  RewriteRule ^index\\.html$ - [L]',
      '  RewriteCond %{REQUEST_FILENAME} !-f',
      '  RewriteCond %{REQUEST_FILENAME} !-d',
      '  RewriteRule . /index.html [L]',
      '</IfModule>',
      '',
    ].join('\n');
    fs.writeFileSync(target, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  detectBuildPlan,
  resolveOutputDir,
  runBuild,
  dirHasFiles,
  ensureViteEntry,
  hasJsBundle,
  ensureSpaHtaccess,
  OUTPUT_CANDIDATES,
};
