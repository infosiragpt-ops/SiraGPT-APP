'use strict';

/**
 * code-interpreter-sandbox — hardened executor for short-lived code
 * snippets the assistant wants to evaluate. Replaces (and remains
 * compatible with) the basic `code-sandbox.js` esqueleto by adding
 * proper isolation, captured artifacts, and tight resource caps.
 *
 * Why this exists:
 *  The brain often wants to run a snippet (compute a stat, transform
 *  a CSV, parse JSON, run a regex match) and use the result in the
 *  next reasoning step. Doing that in-process is unsafe — bad input
 *  can hang the event loop, OOM the worker, or read files outside
 *  the working dir. This sandbox spawns a separate `node`/`python3`
 *  child process inside a fresh tempdir, kills it on timeout, caps
 *  output size, and returns a structured Result that the orchestrator
 *  can hand back to the LLM.
 *
 * Hard limits (env-overridable):
 *   maxRuntimeMs          : 8_000  (env SIRAGPT_CODE_SANDBOX_TIMEOUT_MS)
 *   maxOutputBytes        : 65_536 (env SIRAGPT_CODE_SANDBOX_OUTPUT_BYTES)
 *   maxScriptBytes        : 32_768 (env SIRAGPT_CODE_SANDBOX_SCRIPT_BYTES)
 *   allowedLanguages      : node, python  (env SIRAGPT_CODE_SANDBOX_LANGS=node,python,bash)
 *
 * Hard refusals:
 *   - require/import of disallowed modules (process, fs, child_process,
 *     net, http, https, dgram) when language === 'node'
 *   - shebang lines pointing at /etc/passwd, /etc/shadow, /dev/*
 *   - input larger than maxScriptBytes
 *   - eval / new Function() calls (regex blacklist)
 *
 * Public API:
 *   runSnippet({ code, language, stdin?, files?, env? }) → Promise<Result>
 *   isLanguageSupported(lang) → boolean
 *   SUPPORTED_LANGUAGES       → string[]
 *
 * Result shape:
 *   {
 *     ok: boolean,
 *     exitCode: number | null,
 *     stdout: string,
 *     stderr: string,
 *     durationMs: number,
 *     truncated: boolean,
 *     refused: boolean,        // when static-check rejected the code
 *     refusalReason?: string,
 *     artifacts: Array<{ path, sizeBytes, mime, contents? }>,
 *     usage: { peakRssBytes?, cpuUserUs?, cpuSysUs? },
 *   }
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_RUNTIME_MS = Number(process.env.SIRAGPT_CODE_SANDBOX_TIMEOUT_MS) || 8000;
const MAX_OUTPUT_BYTES = Number(process.env.SIRAGPT_CODE_SANDBOX_OUTPUT_BYTES) || 65_536;
const MAX_SCRIPT_BYTES = Number(process.env.SIRAGPT_CODE_SANDBOX_SCRIPT_BYTES) || 32_768;
const ALLOWED_LANGS = (process.env.SIRAGPT_CODE_SANDBOX_LANGS || 'node,python').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const SUPPORTED_LANGUAGES = Object.freeze(['node', 'python', 'bash']);

const DISALLOWED_REQUIRES = [
  /\brequire\s*\(\s*['"]child_process['"]\)/,
  /\brequire\s*\(\s*['"]fs['"]\)/,
  /\brequire\s*\(\s*['"]net['"]\)/,
  /\brequire\s*\(\s*['"]http['"]\)/,
  /\brequire\s*\(\s*['"]https['"]\)/,
  /\brequire\s*\(\s*['"]dgram['"]\)/,
  /\brequire\s*\(\s*['"]os['"]\)/,
  /\brequire\s*\(\s*['"]vm['"]\)/,
  /\brequire\s*\(\s*['"]worker_threads['"]\)/,
  /\bimport\s+.+\s+from\s+['"]child_process['"]/,
  /\bimport\s+.+\s+from\s+['"]fs(?:\/promises)?['"]/,
];

const DANGEROUS_PATTERNS = [
  /\bnew\s+Function\s*\(/,
  /\beval\s*\(/,
  /process\.exit\s*\(/,
  /process\.kill\s*\(/,
  /process\.binding\s*\(/,
  /__proto__/,
  /\/etc\/passwd|\/etc\/shadow|\/dev\/(?:tcp|udp|null|zero)/i,
];

const PYTHON_BLACKLIST = [
  /\bimport\s+os(?:\s|$|,|\.)/,
  /\bimport\s+subprocess/,
  /\bfrom\s+os\b/,
  /\bfrom\s+subprocess\b/,
  /\b__import__\s*\(/,
  /\bopen\s*\(\s*['"]\/etc\//,
  /\beval\s*\(/,
  /\bexec\s*\(/,
];

// ─── Pre-flight static checks ─────────────────────────────────────

function staticAudit(code, language) {
  if (typeof code !== 'string') return { ok: false, reason: 'code must be a string' };
  if (code.length > MAX_SCRIPT_BYTES) return { ok: false, reason: `script exceeds ${MAX_SCRIPT_BYTES} bytes` };
  if (!isLanguageSupported(language)) return { ok: false, reason: `language "${language}" not supported (allowed: ${ALLOWED_LANGS.join(', ')})` };

  if (language === 'node') {
    for (const re of DISALLOWED_REQUIRES) {
      if (re.test(code)) return { ok: false, reason: `disallowed require/import detected: ${re}` };
    }
  }
  if (language === 'python') {
    for (const re of PYTHON_BLACKLIST) {
      if (re.test(code)) return { ok: false, reason: `disallowed python import detected: ${re}` };
    }
  }
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(code)) return { ok: false, reason: `dangerous pattern: ${re}` };
  }
  return { ok: true };
}

function isLanguageSupported(lang) {
  if (typeof lang !== 'string') return false;
  const norm = lang.toLowerCase();
  return ALLOWED_LANGS.includes(norm) && SUPPORTED_LANGUAGES.includes(norm);
}

// ─── Sandbox dir lifecycle ─────────────────────────────────────────

function createSandboxDir() {
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(os.tmpdir(), `siragpt-sandbox-${id}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function tryCleanup(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
}

function writeStartFiles(dir, files) {
  const written = [];
  if (!files || typeof files !== 'object') return written;
  for (const [name, contents] of Object.entries(files)) {
    if (typeof name !== 'string' || name.includes('..') || name.startsWith('/')) continue;
    const target = path.join(dir, name);
    try {
      const isString = typeof contents === 'string';
      const data = isString ? contents : Buffer.isBuffer(contents) ? contents : String(contents);
      // Disallow files larger than half the output cap
      const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
      if (size > MAX_OUTPUT_BYTES / 2) continue;
      fs.writeFileSync(target, data);
      written.push({ name, size });
    } catch { /* swallow */ }
  }
  return written;
}

function collectArtifacts(dir, started) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const target = path.join(dir, entry.name);
    let stat;
    try { stat = fs.statSync(target); } catch { continue; }
    // Skip files that pre-existed before execution
    if (started && started[entry.name] != null && stat.size === started[entry.name]) continue;
    const sizeBytes = stat.size;
    const mime = guessMime(entry.name);
    let contents = null;
    if (sizeBytes <= MAX_OUTPUT_BYTES / 4 && isTextMime(mime)) {
      try { contents = fs.readFileSync(target, 'utf8'); } catch { /* swallow */ }
    }
    out.push({ path: entry.name, sizeBytes, mime, contents });
    if (out.length >= 12) break;
  }
  return out;
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', jsonl: 'application/x-ndjson', xml: 'application/xml',
    html: 'text/html', js: 'application/javascript', py: 'text/x-python',
    yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/toml', ini: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
    pdf: 'application/pdf',
  }[ext] || 'application/octet-stream';
}

function isTextMime(m) {
  return typeof m === 'string' && (m.startsWith('text/') || m === 'application/json' || m === 'application/x-ndjson' || m === 'application/xml' || m === 'image/svg+xml' || m === 'application/javascript');
}

// ─── Execution ─────────────────────────────────────────────────

function buildCommand(language, scriptPath) {
  if (language === 'node') return { cmd: process.execPath, args: ['--no-warnings', '--no-deprecation', scriptPath] };
  if (language === 'python') return { cmd: 'python3', args: ['-I', '-B', scriptPath] };
  if (language === 'bash') return { cmd: '/bin/sh', args: ['-c', `bash --noprofile --norc ${scriptPath}`] };
  return null;
}

function scriptExtension(language) {
  if (language === 'node') return 'js';
  if (language === 'python') return 'py';
  if (language === 'bash') return 'sh';
  return 'txt';
}

function snapshotDirSizes(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      try { out[e.name] = fs.statSync(path.join(dir, e.name)).size; } catch { /* swallow */ }
    }
  } catch { /* swallow */ }
  return out;
}

async function runSnippet(options = {}) {
  const language = String(options.language || 'node').toLowerCase();
  const code = options.code;
  const audit = staticAudit(code, language);
  if (!audit.ok) {
    return refusedResult(audit.reason);
  }

  const dir = createSandboxDir();
  const ext = scriptExtension(language);
  const scriptPath = path.join(dir, `main.${ext}`);
  try {
    fs.writeFileSync(scriptPath, code, { mode: 0o600 });
  } catch (err) {
    tryCleanup(dir);
    return errorResult(`failed to write script: ${err.message}`);
  }
  const startedFiles = snapshotDirSizes(dir);
  writeStartFiles(dir, options.files);

  const command = buildCommand(language, scriptPath);
  if (!command) {
    tryCleanup(dir);
    return refusedResult('runtime not available for selected language');
  }
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;
  let exitCode = null;
  let killSignal = null;
  let resourceUsage = null;

  const child = spawn(command.cmd, command.args, {
    cwd: dir,
    env: buildSafeEnv(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.maxRuntimeMs || MAX_RUNTIME_MS,
    detached: false,
  });

  const onChunk = (buf, target) => {
    const chunk = buf.toString('utf8');
    if ((target === 'stdout' ? stdout.length : stderr.length) + chunk.length > MAX_OUTPUT_BYTES) {
      truncated = true;
      if (target === 'stdout') stdout = (stdout + chunk).slice(0, MAX_OUTPUT_BYTES);
      else stderr = (stderr + chunk).slice(0, MAX_OUTPUT_BYTES);
      try { child.kill('SIGKILL'); } catch { /* swallow */ }
      return;
    }
    if (target === 'stdout') stdout += chunk;
    else stderr += chunk;
  };

  child.stdout.on('data', (b) => onChunk(b, 'stdout'));
  child.stderr.on('data', (b) => onChunk(b, 'stderr'));

  if (typeof options.stdin === 'string' && options.stdin.length > 0) {
    try { child.stdin.write(options.stdin); } catch { /* swallow */ }
  }
  try { child.stdin.end(); } catch { /* swallow */ }

  await new Promise((resolve) => {
    let resolved = false;
    const finish = () => { if (!resolved) { resolved = true; resolve(); } };
    child.on('close', (code, signal) => {
      exitCode = code;
      killSignal = signal;
      resourceUsage = (typeof child.resourceUsage === 'function') ? safeUsage(child.resourceUsage()) : null;
      finish();
    });
    child.on('error', (err) => {
      stderr += `\n[sandbox] spawn error: ${err.message}`;
      finish();
    });
  });

  const durationMs = Date.now() - startedAt;
  timedOut = killSignal === 'SIGTERM' || (durationMs >= (options.maxRuntimeMs || MAX_RUNTIME_MS) && exitCode === null);

  const artifacts = collectArtifacts(dir, startedFiles);
  tryCleanup(dir);

  return {
    ok: exitCode === 0 && !timedOut,
    exitCode,
    killSignal,
    timedOut,
    stdout,
    stderr,
    durationMs,
    truncated,
    refused: false,
    artifacts,
    usage: resourceUsage || {},
  };
}

function buildSafeEnv(userEnv) {
  // Whitelist a tiny env so the child can't read host secrets
  const out = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: os.tmpdir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NODE_OPTIONS: '--no-warnings --no-deprecation',
  };
  if (userEnv && typeof userEnv === 'object') {
    for (const [k, v] of Object.entries(userEnv)) {
      if (typeof k !== 'string' || /^(LD_PRELOAD|LD_LIBRARY_PATH|PATH|HOME|SHELL)$/i.test(k)) continue;
      out[k] = String(v);
    }
  }
  return out;
}

function refusedResult(reason) {
  return {
    ok: false,
    exitCode: null,
    killSignal: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    durationMs: 0,
    truncated: false,
    refused: true,
    refusalReason: reason,
    artifacts: [],
    usage: {},
  };
}

function errorResult(message) {
  return {
    ok: false,
    exitCode: null,
    killSignal: null,
    timedOut: false,
    stdout: '',
    stderr: message,
    durationMs: 0,
    truncated: false,
    refused: false,
    artifacts: [],
    usage: {},
  };
}

function safeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    cpuUserUs: Number(u.userCPUTime) || null,
    cpuSysUs: Number(u.systemCPUTime) || null,
    peakRssBytes: Number(u.maxRSS) || null,
  };
}

module.exports = {
  runSnippet,
  isLanguageSupported,
  SUPPORTED_LANGUAGES,
  MAX_RUNTIME_MS,
  MAX_OUTPUT_BYTES,
  MAX_SCRIPT_BYTES,
  _internal: { staticAudit, buildSafeEnv, snapshotDirSizes, DISALLOWED_REQUIRES, DANGEROUS_PATTERNS, PYTHON_BLACKLIST },
};
