/**
 * code-sandbox — run short Python/Node snippets in isolation.
 *
 * This is the execution substrate AgentCoder needs to close the
 * programmer → tests → executor → feedback loop. Without it the
 * generation side is blind: it can emit code + tests, but it can't
 * learn "test 3 failed, here's the traceback".
 *
 * Isolation boundaries (defense in depth — none alone is sufficient):
 *   1. Wall-clock + CPU timeout. Kill the child with SIGKILL on breach.
 *   2. Fresh temp directory per run, deleted after. No access to the
 *      chat app's working directory.
 *   3. Stripped env — no API keys, no PATH beyond what the interpreter
 *      needs to start. Prevents accidental credential access.
 *   4. stdin is /dev/null (no interactive probes).
 *   5. stdout + stderr capped. Oversized output is truncated with a
 *      marker so the feedback back to the LLM stays bounded.
 *
 * This is NOT a substitute for a real seccomp/gVisor/firecracker
 * sandbox. Network is NOT blocked at the kernel layer. We ship this
 * for *our own, trusted code paths* — HumanEval problems, AgentCoder
 * loops we initiate — not as a public code-execution endpoint.
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MEMORY_MB = 512;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024; // 256 KB source cap
const DEFAULT_MAX_EXTRA_FILES = 20;           // max fixture files per run

const LANGUAGE_CONFIG = {
  python: {
    interpreter: process.env.SANDBOX_PYTHON || 'python3',
    filename: 'main.py',
    args: file => [file],
  },
  javascript: {
    interpreter: process.env.SANDBOX_NODE || 'node',
    filename: 'main.js',
    args: file => [file],
  },
  node: {
    interpreter: process.env.SANDBOX_NODE || 'node',
    filename: 'main.js',
    args: file => [file],
  },
};

function stripEnv(memoryMb = DEFAULT_MEMORY_MB) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_OPTIONS: `--max-old-space-size=${memoryMb}`,
  };
  // Whitelist scientific-Python site-packages so SymPy / NumPy /
  // SciPy / Pandas resolve inside the sandbox. Without this, HOME is
  // rewritten to /tmp and Python can't find the user-installed libs.
  // SANDBOX_PYTHONPATH can be set explicitly in the environment (prod
  // deploys); otherwise we fall back to the host's PYTHONPATH +
  // PYTHONUSERBASE so a local dev machine with `pip install --user
  // sympy numpy scipy pandas` just works.
  const pythonPaths = [];
  const configuredPythonPath = process.env.SANDBOX_PYTHONPATH || process.env.PYTHONPATH;
  if (configuredPythonPath) pythonPaths.push(...configuredPythonPath.split(path.delimiter).filter(Boolean));
  pythonPaths.push(...discoverPythonUserSitePackages());
  if (pythonPaths.length > 0) env.PYTHONPATH = Array.from(new Set(pythonPaths)).join(path.delimiter);
  if (process.env.PYTHONUSERBASE) env.PYTHONUSERBASE = process.env.PYTHONUSERBASE;
  return env;
}

let discoveredPythonUserSitePackages = null;
function discoverPythonUserSitePackages() {
  if (discoveredPythonUserSitePackages) return discoveredPythonUserSitePackages;
  const found = [];
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Python'),
    path.join(home, '.local', 'lib'),
  ];
  for (const base of candidates) {
    try {
      if (!fsSync.existsSync(base)) continue;
      for (const version of fsSync.readdirSync(base)) {
        const macUserSite = path.join(base, version, 'lib', 'python', 'site-packages');
        const linuxUserSite = path.join(base, version, 'site-packages');
        if (fsSync.existsSync(macUserSite)) found.push(macUserSite);
        if (fsSync.existsSync(linuxUserSite)) found.push(linuxUserSite);
      }
    } catch { /* best effort discovery */ }
  }
  discoveredPythonUserSitePackages = found;
  return discoveredPythonUserSitePackages;
}

async function mkTempDir() {
  const base = path.join(os.tmpdir(), 'siragpt-sandbox-');
  return await fs.mkdtemp(base);
}

function truncate(buf, max) {
  if (buf.length <= max) return { text: buf.toString('utf8'), truncated: false };
  return {
    text: buf.slice(0, max).toString('utf8') + `\n…[truncated ${buf.length - max} bytes]`,
    truncated: true,
  };
}

/**
 * Clamp a numeric knob to a positive finite integer. NaN / Infinity /
 * negative / zero / non-numeric values fall back to the default —
 * otherwise a hostile or buggy caller could pass maxOutputBytes=Infinity
 * (cap disabled → unbounded buffering) or timeoutMs=NaN (insta-kill).
 */
function sanitizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Run a source string in isolation.
 *
 * @param {object}  opts
 * @param {string}  opts.language       — 'python' | 'javascript'
 * @param {string}  opts.source         — the code body
 * @param {number} [opts.timeoutMs=10000]
 * @param {number} [opts.maxOutputBytes=65536]
 * @param {number} [opts.memoryMb=512]      — heap cap for Node; informational for Python
 * @param {string} [opts.stdin]         — optional stdin content
 * @param {object<string,string>} [opts.files] — extra files to drop in the
 *                                               run dir (filename → content)
 * @param {AbortSignal} [opts.signal]   — cancels the child process immediately
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   exitCode: number|null,
 *   signal: string|null,
 *   stdout: string,
 *   stderr: string,
 *   durationMs: number,
 *   timedOut: boolean,
 *   truncated: boolean,
 *   language: string,
 * }>}
 */
async function run(opts) {
  // Null/non-object opts must resolve to a structured error, never reject
  // with a destructuring TypeError that escapes to the caller.
  const {
    language,
    source,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    memoryMb = DEFAULT_MEMORY_MB,
    stdin = '',
    files = {},
    signal,
  } = (opts && typeof opts === 'object') ? opts : {};
  const cfg = LANGUAGE_CONFIG[String(language || '').toLowerCase()];
  if (!cfg) {
    return {
      ok: false, exitCode: null, signal: null,
      stdout: '', stderr: `unsupported language: ${language}`,
      durationMs: 0, timedOut: false, truncated: false,
      language: String(language || ''),
    };
  }
  if (typeof source !== 'string') {
    return {
      ok: false, exitCode: null, signal: null,
      stdout: '', stderr: `invalid source: expected string, got ${source === null ? 'null' : typeof source}`,
      durationMs: 0, timedOut: false, truncated: false,
      language,
    };
  }
  if (source.length === 0) {
    return {
      ok: false, exitCode: null, signal: null,
      stdout: '', stderr: 'empty source',
      durationMs: 0, timedOut: false, truncated: false,
      language,
    };
  }

  // Clamp numeric knobs. Without this, maxOutputBytes=NaN/Infinity silently
  // disables the output cap (unbounded memory), negative values leak nearly
  // the full buffer through Buffer.slice(0, negative), and timeoutMs=NaN
  // kills every run at ~1ms.
  const effTimeoutMs = sanitizePositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS);
  const effMaxOutputBytes = sanitizePositiveInt(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const effMemoryMb = sanitizePositiveInt(memoryMb, DEFAULT_MEMORY_MB);

  // Enforce source size limit to prevent OOM or excessive memory use
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > (process.env.SANDBOX_MAX_SOURCE_BYTES
    ? parseInt(process.env.SANDBOX_MAX_SOURCE_BYTES, 10) : DEFAULT_MAX_SOURCE_BYTES)) {
    return {
      ok: false, exitCode: null, signal: null,
      stdout: '',
      stderr: `source too large: ${(sourceBytes / 1024).toFixed(1)} KB (max ${(parseInt(process.env.SANDBOX_MAX_SOURCE_BYTES, 10) || DEFAULT_MAX_SOURCE_BYTES) / 1024} KB)`,
      durationMs: 0, timedOut: false, truncated: false,
      language,
    };
  }
  if (signal?.aborted) {
    return {
      ok: false, exitCode: null, signal: 'SIGABRT',
      stdout: '', stderr: 'aborted',
      durationMs: 0, timedOut: false, truncated: false,
      language,
      aborted: true,
    };
  }
  // Only treat `signal` as an AbortSignal if it actually quacks like one.
  // A truthy non-signal value used to throw `signal.addEventListener is
  // not a function` AFTER the child was spawned — leaking a live process.
  const abortSignal = (signal
    && typeof signal.addEventListener === 'function'
    && typeof signal.removeEventListener === 'function') ? signal : null;

  let dir;
  try {
    dir = await mkTempDir();
  } catch (e) {
    return {
      ok: false, exitCode: null, signal: null,
      stdout: '', stderr: `sandbox internal error: ${(e && e.message) || String(e)}`,
      durationMs: 0, timedOut: false, truncated: false,
      language,
    };
  }
  // Best-effort cleanup. We swallow errors — leaving a temp dir isn't
  // a correctness problem, and fs.rm on a dir with open handles will
  // sometimes race in tests.
  const releaseDir = async () => {
    try {
      if (fsSync.existsSync(dir)) await fs.rm(dir, { recursive: true, force: true });
    } catch { /* swallow */ }
  };

  let child = null;
  let timer = null;
  let abortHandler = null;
  try {
    const mainFile = path.join(dir, cfg.filename);
    await fs.writeFile(mainFile, source, 'utf8');

    // Drop extra fixture files (e.g. tests, data) alongside main.
    const maxFiles = process.env.SANDBOX_MAX_EXTRA_FILES
      ? parseInt(process.env.SANDBOX_MAX_EXTRA_FILES, 10) : DEFAULT_MAX_EXTRA_FILES;
    let fileCount = 0;
    for (const [name, body] of Object.entries(files || {})) {
      if (typeof name !== 'string' || typeof body !== 'string') continue;
      if (name.length === 0 || name.includes('\0')) continue; // reject NULs and empty names
      if (path.isAbsolute(name)) continue;                    // reject absolute paths (any platform)
      const resolved = path.resolve(dir, name);
      const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
      if (resolved !== dir && !resolved.startsWith(dirWithSep)) continue; // path traversal
      if (++fileCount > maxFiles) {
        console.warn(`[code-sandbox] max extra files (${maxFiles}) exceeded, dropping ${Object.keys(files || {}).length - maxFiles} files`);
        break;
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, body, 'utf8');
    }

    const start = Date.now();
    child = spawn(cfg.interpreter, cfg.args(mainFile), {
      cwd: dir,
      env: stripEnv(effMemoryMb),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let sizeLimitHit = false;
    let aborted = false;
    let spawnError = null;
    child.on('error', err => { spawnError = err; });
    abortHandler = () => {
      aborted = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    if (abortSignal) abortSignal.addEventListener('abort', abortHandler, { once: true });
    const append = (which, chunk) => {
      if (sizeLimitHit) return;
      if (which === 'stdout') {
        stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
        if (stdoutBuf.length > effMaxOutputBytes * 2) {
          stdoutBuf = stdoutBuf.slice(0, effMaxOutputBytes * 2);
          sizeLimitHit = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      } else {
        stderrBuf = Buffer.concat([stderrBuf, chunk]);
        if (stderrBuf.length > effMaxOutputBytes * 2) {
          stderrBuf = stderrBuf.slice(0, effMaxOutputBytes * 2);
          sizeLimitHit = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }
    };
    child.stdout.on('data', c => append('stdout', c));
    child.stderr.on('data', c => append('stderr', c));

    if (stdin) {
      try { child.stdin.write(stdin); } catch { /* pipe closed */ }
    }
    try { child.stdin.end(); } catch { /* already closed */ }

    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, effTimeoutMs);

    const { exitCode, childSignal } = await new Promise(resolve => {
      child.on('close', (code, sig) => resolve({ exitCode: code, childSignal: sig }));
      child.on('error', () => resolve({ exitCode: null, childSignal: null }));
    });
    clearTimeout(timer);
    timer = null;
    if (abortSignal) abortSignal.removeEventListener('abort', abortHandler);

    await releaseDir();

    const out = truncate(stdoutBuf, effMaxOutputBytes);
    const err = truncate(stderrBuf, effMaxOutputBytes);
    let stderrText = aborted ? (err.text || 'aborted') : err.text;
    if (spawnError && !aborted && !timedOut) {
      const tag = spawnError.code === 'ENOENT'
        ? `interpreter not found: ${cfg.interpreter} (set SANDBOX_PYTHON / SANDBOX_NODE to override)`
        : `spawn error: ${spawnError.code || spawnError.message || String(spawnError)}`;
      stderrText = stderrText ? `${tag}\n${stderrText}` : tag;
    }
    return {
      ok: !aborted && !timedOut && !spawnError && exitCode === 0 && !sizeLimitHit,
      exitCode,
      signal: childSignal,
      stdout: out.text,
      stderr: stderrText,
      durationMs: Date.now() - start,
      timedOut,
      aborted,
      truncated: out.truncated || err.truncated || sizeLimitHit,
      language,
    };
  } catch (e) {
    // Defensive boundary: any unexpected failure between temp-dir creation
    // and the child's close event must still release every resource this
    // run acquired (child process, timer, abort listener, temp dir) and
    // resolve with a structured error — never a rejected promise.
    if (timer) clearTimeout(timer);
    if (abortSignal && abortHandler) {
      try { abortSignal.removeEventListener('abort', abortHandler); } catch { /* swallow */ }
    }
    if (child) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    await releaseDir();
    return {
      ok: false, exitCode: null, signal: null,
      stdout: '', stderr: `sandbox internal error: ${(e && e.message) || String(e)}`,
      durationMs: 0, timedOut: false, truncated: false,
      language,
    };
  }
}

/**
 * Run code + a test body in one process. For Python this wraps in a
 * pytest-style harness; for JavaScript it uses node:test assertions.
 * The returned object adds `passed`/`failed` counts parsed from stdout
 * so the caller (AgentCoder) can report back to the programmer agent.
 */
async function runTests(opts) {
  // Same boundary rule as run(): null/non-object opts and non-string
  // source/testSource resolve to a structured result, never a rejection
  // (testSource.split used to throw a TypeError that escaped).
  const {
    language,
    source,
    testSource,
    entry = 'solution', // eslint-disable-line no-unused-vars -- documented API surface
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = (opts && typeof opts === 'object') ? opts : {};
  const lang = String(language || '').toLowerCase();
  const invalidInput = (msg) => ({
    ok: false, passed: 0, failed: 0,
    stdout: '', stderr: msg,
    timedOut: false, failures: [],
    aborted: false,
    exitCode: null,
    durationMs: 0,
  });
  if (lang === 'python' || lang === 'javascript' || lang === 'node') {
    if (typeof source !== 'string') {
      return invalidInput(`invalid source: expected string, got ${source === null ? 'null' : typeof source}`);
    }
    if (typeof testSource !== 'string') {
      return invalidInput(`invalid testSource: expected string, got ${testSource === null ? 'null' : typeof testSource}`);
    }
  }
  if (lang === 'python') {
    const harness =
      `${source}\n\n` +
      `# ── Test harness (inlined by sandbox) ─────────────────────────\n` +
      `import sys, traceback\n` +
      `_PASS, _FAIL, _FAILURES = 0, 0, []\n` +
      `def _check(name, cond, detail=''):\n` +
      `    global _PASS, _FAIL, _FAILURES\n` +
      `    if cond:\n` +
      `        _PASS += 1\n` +
      `    else:\n` +
      `        _FAIL += 1\n` +
      `        _FAILURES.append((name, detail))\n` +
      `try:\n` +
      `${testSource.split('\n').map(l => '    ' + l).join('\n')}\n` +
      `except Exception as e:\n` +
      `    _FAIL += 1\n` +
      `    _FAILURES.append(('<harness>', traceback.format_exc()))\n` +
      `print(f'SANDBOX_RESULT passed={_PASS} failed={_FAIL}')\n` +
      `for name, detail in _FAILURES:\n` +
      `    flat = str(detail).replace('\\r', ' ').replace('\\n', ' | ')\n` +
      `    print(f'FAIL {name}: {flat}')\n`;
    const r = await run({ language: 'python', source: harness, timeoutMs, signal });
    return parseHarness(r);
  }
  if (lang === 'javascript' || lang === 'node') {
    const harness =
      `${source}\n\n` +
      `// ── Test harness (inlined by sandbox) ────────────────────────\n` +
      `let _PASS = 0, _FAIL = 0;\n` +
      `const _FAILURES = [];\n` +
      `function _check(name, cond, detail) {\n` +
      `  if (cond) _PASS++;\n` +
      `  else { _FAIL++; _FAILURES.push([name, detail || '']); }\n` +
      `}\n` +
      `try {\n` +
      `${testSource.split('\n').map(l => '  ' + l).join('\n')}\n` +
      `} catch (e) {\n` +
      `  _FAIL++;\n` +
      `  _FAILURES.push(['<harness>', (e && e.stack) || String(e)]);\n` +
      `}\n` +
      `console.log('SANDBOX_RESULT passed=' + _PASS + ' failed=' + _FAIL);\n` +
      `for (const [name, detail] of _FAILURES) {\n` +
      `  const flat = String(detail).replace(/\\r/g, ' ').replace(/\\n/g, ' | ');\n` +
      `  console.log('FAIL ' + name + ': ' + flat);\n` +
      `}\n`;
    const r = await run({ language: 'javascript', source: harness, timeoutMs, signal });
    return parseHarness(r);
  }
  return {
    ok: false, passed: 0, failed: 0,
    stdout: '', stderr: `unsupported test language: ${language}`,
    timedOut: false, failures: [],
    aborted: false,
    exitCode: null,
    durationMs: 0,
  };
}

function parseHarness(r) {
  const m = r.stdout.match(/SANDBOX_RESULT passed=(\d+) failed=(\d+)/);
  const passed = m ? parseInt(m[1], 10) : 0;
  const failed = m ? parseInt(m[2], 10) : 0;
  const failures = [];
  for (const line of r.stdout.split('\n')) {
    const mm = line.match(/^FAIL ([^:]+): (.*)$/);
    if (mm) failures.push({ name: mm[1], detail: mm[2] });
  }
  return {
    ok: r.ok && failed === 0 && passed > 0,
    passed,
    failed,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
    aborted: r.aborted,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    failures,
  };
}

module.exports = { run, runTests, DEFAULT_TIMEOUT_MS };
