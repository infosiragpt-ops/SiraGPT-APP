'use strict';

/**
 * isolated-code-runner — run model-authored code inside the hardened
 * document sandbox container instead of the API process's own host.
 *
 * python_exec / bash_exec / create_document execute code an LLM wrote, and an
 * LLM can be steered by an uploaded document or a web page (prompt
 * injection). On the host (agents/code-sandbox.js) that code shares the API
 * container's network, filesystem and same-uid /proc (the parent process
 * environment holds the provider keys and the database URL) — the env
 * scrubbing there is not a boundary. The host interpreter also lacks the
 * libraries the tool descriptions promise.
 *
 * Here every run gets a fresh container from doc-agent/sandbox.js — the same
 * sandbox the document agent uses, built from services/sandbox/runner with
 * the full catalog in agent-runner/sandbox-capabilities.json — and the
 * container is destroyed when the run ends. Isolation always includes a
 * separate container with --network none, non-root, no-new-privileges and
 * cpu/memory/pids limits; the docker driver adds gVisor (runsc), a read-only
 * rootfs and cap-drop ALL. Production currently uses the remote driver (the
 * sandbox microservice, services/sandbox/lib/docker-sandbox.js), which does
 * not add those three; `isolation` reports the driver and gvisor flag.
 * With a `persistKey` (the chat id) the run mounts that
 * conversation's workspace volume — the one the document agent already uses
 * — so the font/matplotlib caches the image seeds into it stay warm and
 * files written outside the run directory survive between calls of the same
 * chat; the run directory itself is removed after every run.
 *
 * Mode (SIRAGPT_CODE_SANDBOX):
 *   auto (default) → isolated in production, host elsewhere (dev/CI keep the
 *                    zero-Docker workflow)
 *   isolated       → always the container
 *   host           → always the host runner (explicit operator opt-out)
 * In isolated mode an unavailable sandbox fails CLOSED with an honest
 * message; it never silently degrades to the host.
 *
 * Result shape matches code-sandbox.run() so callers can swap transparently,
 * plus `isolation` (driver/runtime/gvisor) and `collected` (files read back
 * from the run directory, e.g. create_document's OUT_PATH).
 *
 * A Claude-style computer for the chat (workdir: 'workspace'):
 *   - the script runs with /workspace as its working directory (persistent
 *     per chat), not inside the throw-away run directory;
 *   - `stage` places files (the user's uploads) under /workspace before the
 *     run, skipping ones already there with the same size; big files travel
 *     in chunks (the remote driver ships bytes as base64 inside a JSON body);
 *   - `outbox` collects the files the script CREATED OR CHANGED under
 *     outputs/ during this run (snapshot before, diff after, inside the same
 *     command), so earlier deliveries and the document agent's own outputs in
 *     the shared volume are never delivered twice. The change detector runs
 *     inline from this module's command, never from a file the model could
 *     rewrite, and sizes are re-measured with a trusted command before any
 *     byte is read back (every helper is resolved through the system PATH,
 *     never /workspace/.sira-packages/bin, and Python helpers run isolated);
 *     at most 10 files, 50 MB each, 100 MB per run;
 *   - OUTPUT_DIR / UPLOADS_DIR / WORKSPACE_DIR / SIRA_RUN_DIR are exported.
 * `bash` is a language too: the chat's bash_exec is a real shell.
 */

const crypto = require('crypto');
const path = require('path');
const { Semaphore } = require('../../utils/async-semaphore');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const MAX_INPUT_FILES = 16;
const MAX_COLLECT_FILES = 8;
// Grace for container start + teardown on top of the script's own budget.
const EXEC_GRACE_MS = 15_000;
// The remote driver ships file bytes as base64 inside a JSON body (64 MiB
// default cap on the service): anything larger goes in chunks.
const PUT_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_STAGE_FILES = 16;
const DEFAULT_MAX_STAGE_FILE_BYTES = 64 * 1024 * 1024;
const OUTBOX_MAX_FILES = 10;
const OUTBOX_MAX_FILE_BYTES = 50 * 1024 * 1024;
// Everything one run hands back is read into backend memory (the remote
// service ships file bytes as base64 JSON): bound the total, not just files.
const OUTBOX_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// The container gets one CPU and a small pids limit that also counts
// threads, while numpy/OpenBLAS, numexpr and polars size their pools to the
// HOST's cores: a heavy script could die with «can't start new thread» and
// gains nothing from extra threads anyway.
const THREAD_CAPS = Object.freeze({
  OMP_NUM_THREADS: '2',
  OPENBLAS_NUM_THREADS: '2',
  MKL_NUM_THREADS: '2',
  NUMEXPR_MAX_THREADS: '2',
  RAYON_NUM_THREADS: '2',
  POLARS_MAX_THREADS: '2',
});
// Stale run directories (an aborted run cannot clean up: its exec shares the
// aborted signal) are swept by the next run of the same chat.
const STALE_RUN_MINUTES = 30;

const LANGUAGES = Object.freeze({
  python: { interpreter: 'python3', filename: 'main.py' },
  javascript: { interpreter: 'node', filename: 'main.js' },
  node: { interpreter: 'node', filename: 'main.js' },
  bash: { interpreter: 'bash', filename: 'main.sh' },
});

// Change detector for the outbox. Runs inline (heredoc) from the command this
// module builds: `snapshot` prints {rel: [size, mtime_ns]}; `diff` prints the
// rels that are new or changed against that snapshot, and `capped` when the
// folder holds more entries than the scan covers (old files count too, so in
// a crowded outputs/ a new file can fall outside the scan: the model is told).
// Hidden files/dirs are skipped, depth and entry count are bounded.
const OUTBOX_SCAN_MAX_ENTRIES = 2000;
const OUTBOX_DETECTOR = [
  'import json, os, sys',
  'mode, base = sys.argv[1], sys.argv[2]',
  'cur, capped = {}, False',
  'if os.path.isdir(base):',
  '    for root, dirs, files in os.walk(base):',
  '        dirs[:] = [d for d in dirs if not d.startswith(".")]',
  '        if os.path.relpath(root, base).count(os.sep) >= 2: dirs[:] = []',
  '        for name in files:',
  '            if name.startswith("."): continue',
  `            if len(cur) >= ${OUTBOX_SCAN_MAX_ENTRIES}:`,
  '                capped = True',
  '                continue',
  '            p = os.path.join(root, name)',
  '            if os.path.islink(p): continue',
  '            try: st = os.stat(p)',
  '            except OSError: continue',
  '            cur[os.path.relpath(p, base)] = [st.st_size, st.st_mtime_ns]',
  'if mode == "snapshot":',
  '    json.dump(cur, sys.stdout)',
  'else:',
  '    try: pre = json.load(open(sys.argv[3]))',
  '    except Exception: pre = {}',
  '    json.dump({"changed": sorted(r for r, v in cur.items() if pre.get(r) != v), "capped": capped}, sys.stdout)',
].join('\n');

const UNAVAILABLE_MESSAGE = 'El entorno aislado de ejecución de código no está disponible en este momento. '
  + 'No se ejecutó el código fuera del aislamiento; inténtalo de nuevo en unos minutos.';
const BUSY_MESSAGE = 'El entorno aislado de ejecución de código está ocupado en este momento y el código no llegó a ejecutarse. '
  + 'Reintenta la misma llamada en un momento.';

/**
 * The sandbox service could not take the run: at capacity after its queue,
 * down, unreachable, timing out or refusing the credentials. With the remote
 * driver the session is created lazily, so these surface at the first file
 * upload, not at createSandbox().
 */
function isServiceUnavailableError(err) {
  if (!err) return false;
  if (err.code === 'sandbox_at_capacity' || err.category === 'capacity') return true;
  // Not 500: a server-side failure of one request (a full workspace disk)
  // is not "come back later" — it stays an internal error.
  if ([401, 403, 408, 429, 502, 503, 504].includes(Number(err.status))) return true;
  const cause = err.cause || {};
  const text = [err.name, err.code, err.message, cause.name, cause.code, cause.message].filter(Boolean).join(' ');
  return /remote_sandbox_timeout|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR|socket hang up|TimeoutError|docker_unavailable/i.test(text);
}

function isAtCapacityError(err) {
  return Boolean(err) && (err.code === 'sandbox_at_capacity' || err.category === 'capacity' || Number(err.status) === 429);
}

function resolveCodeExecutionMode(env = process.env) {
  const raw = String(env.SIRAGPT_CODE_SANDBOX || 'auto').trim().toLowerCase();
  if (raw === 'isolated' || raw === 'container') return 'isolated';
  if (raw === 'host') return 'host';
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production' ? 'isolated' : 'host';
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

let sharedSemaphore = null;
let sharedSemaphoreSize = 0;
function semaphoreFor(env) {
  const max = Math.min(32, positiveInt(env.SIRAGPT_CODE_SANDBOX_MAX_CONCURRENT, 4));
  if (!sharedSemaphore || sharedSemaphoreSize !== max) {
    sharedSemaphore = new Semaphore(max);
    sharedSemaphoreSize = max;
  }
  return sharedSemaphore;
}

/** POSIX single-quote so a crafted path can never break out of `bash -c`. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Relative path inside the run directory: no absolute paths, no traversal,
 * no NULs. Returns null when the name cannot be made safe.
 */
function safeRunRel(name) {
  const raw = String(name == null ? '' : name);
  if (!raw || raw.includes('\0') || path.posix.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return null;
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

/**
 * Cap an output at `maxBytes` keeping its HEAD and its TAIL: a traceback, a
 * final result or a summary line is printed last, after pages of warnings or
 * progress. Cuts land on UTF-8 character boundaries (never a U+FFFD).
 */
function truncateText(value, maxBytes) {
  const text = String(value || '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const isContinuation = (i) => i > 0 && i < buffer.length && (buffer[i] & 0xc0) === 0x80;
  let headEnd = Math.floor(maxBytes * 0.6);
  while (isContinuation(headEnd)) headEnd -= 1;
  let tailStart = buffer.length - (maxBytes - Math.floor(maxBytes * 0.6));
  while (isContinuation(tailStart)) tailStart += 1;
  return {
    text: `${buffer.subarray(0, headEnd).toString('utf8')}\n…[salida recortada: ${tailStart - headEnd} bytes omitidos del medio]…\n${buffer.subarray(tailStart).toString('utf8')}`,
    truncated: true,
  };
}

// The commands the RUNNER executes after (or around) the user's script must
// not be resolvable through /workspace/.sira-packages/bin, which is first in
// PATH and writable by that script. `command -p` looks a utility up in the
// system's default PATH; `python3 -I -s` ignores PYTHON* variables and the
// user site-packages (no .pth file can run in a helper).
const SYS_PYTHON = 'command -p python3 -I -s';
const SYS_PATH_PREFIX = 'PATH="$(command -p getconf PATH 2>/dev/null || printf %s /usr/bin:/bin)"';

// Sizes (and optionally sha256) of regular, non-symlink files under
// /workspace: {rel: [size, sha256|null]}. Paths travel as JSON, so names with
// quotes, accents or newlines are safe.
const FILE_INFO_PROGRAM = [
  'import hashlib, json, os, sys',
  'rels, want_hash = json.loads(sys.argv[1]), sys.argv[2] == "1"',
  'out = {}',
  'for rel in rels:',
  '    try:',
  '        if os.path.islink(rel) or not os.path.isfile(rel): continue',
  '        size, digest = os.path.getsize(rel), None',
  '        if want_hash:',
  '            h = hashlib.sha256()',
  '            with open(rel, "rb") as handle:',
  '                for block in iter(lambda: handle.read(1 << 20), b""): h.update(block)',
  '            digest = h.hexdigest()',
  '        out[rel] = [size, digest]',
  '    except OSError: pass',
  'json.dump(out, sys.stdout)',
].join('\n');

/**
 * putFile, in chunks when the file is large: parts are written next to the
 * target and concatenated inside the sandbox.
 */
async function putFileChunked(sandbox, rel, buffer, { chunkBytes = PUT_CHUNK_BYTES } = {}) {
  if (buffer.length <= chunkBytes) {
    await sandbox.putFile(rel, buffer);
    return;
  }
  const parts = [];
  for (let offset = 0, index = 0; offset < buffer.length; offset += chunkBytes, index += 1) {
    const partRel = `${rel}.sira-part-${String(index).padStart(4, '0')}`;
    await sandbox.putFile(partRel, buffer.subarray(offset, offset + chunkBytes));
    parts.push(partRel);
  }
  const quoted = parts.map(shQuote).join(' ');
  const r = await sandbox.exec(`cd /workspace && command -p cat ${quoted} > ${shQuote(rel)} && command -p rm -f -- ${quoted}`, { timeoutMs: 120_000 });
  if (!r || r.exitCode !== 0) throw new Error(`could not assemble ${rel} inside the sandbox`);
}

/**
 * Sizes (and sha256 when `hash`) of regular, non-symlink files under
 * /workspace, measured by a trusted helper. Missing files are absent.
 * With `strict`, a probe that did not answer (non-zero exit, no JSON) throws
 * instead of reading as "no such files".
 * @returns {Promise<Map<string, { size: number, sha256: string|null }>>}
 */
async function workspaceFileInfo(sandbox, rels, { hash = false, strict = false } = {}) {
  const info = new Map();
  if (!rels.length) return info;
  const command = `cd /workspace && ${SYS_PYTHON} - ${shQuote(JSON.stringify(rels))} ${hash ? '1' : '0'} 2>/dev/null <<'SIRA_FILEINFO_EOF'\n${FILE_INFO_PROGRAM}\nSIRA_FILEINFO_EOF`;
  const r = await sandbox.exec(command, { timeoutMs: hash ? 120_000 : 20_000 });
  let parsed = null;
  try { parsed = JSON.parse(String(r?.stdout || '').trim() || 'null'); } catch { parsed = null; }
  const answered = Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  if (strict && (!answered || (Number.isInteger(r?.exitCode) && r.exitCode !== 0))) {
    throw new Error('the file probe did not answer');
  }
  for (const [rel, value] of Object.entries(answered ? parsed : {})) {
    const size = Number(Array.isArray(value) ? value[0] : NaN);
    if (!Number.isFinite(size) || size < 0) continue;
    const digest = Array.isArray(value) && typeof value[1] === 'string' && /^[a-f0-9]{64}$/.test(value[1]) ? value[1] : null;
    info.set(rel, { size, sha256: digest });
  }
  return info;
}

/** Sizes only (see workspaceFileInfo). */
async function workspaceFileSizes(sandbox, rels, { strict = false } = {}) {
  const info = await workspaceFileInfo(sandbox, rels, { strict });
  return new Map([...info].map(([rel, value]) => [rel, value.size]));
}

function exportLine(vars) {
  const pairs = Object.entries(vars || {})
    .filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && value != null)
    .map(([key, value]) => `${key}=${shQuote(value)}`);
  return pairs.length ? `export ${pairs.join(' ')}` : '';
}

function failure(language, stderr, extra = {}) {
  return {
    ok: false,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr,
    durationMs: 0,
    timedOut: false,
    aborted: false,
    truncated: false,
    language,
    isolation: null,
    collected: {},
    ...extra,
  };
}

/**
 * Run one script in a fresh sandbox container.
 *
 * @param {object} opts
 * @param {'python'|'javascript'|'node'|'bash'} opts.language
 * @param {string} opts.source
 * @param {string} [opts.stdin]
 * @param {number} [opts.timeoutMs]          script budget (default 10 s, max 120 s)
 * @param {AbortSignal} [opts.signal]
 * @param {Array<{ rel: string, buffer: Buffer }>} [opts.inputs]  files placed in the run dir
 * @param {string[]} [opts.collect]          run-dir relative files read back after the run
 * @param {string|null} [opts.persistKey]   conversation workspace volume (chat id); null = ephemeral
 * @param {'run'|'workspace'} [opts.workdir] working directory of the script (default: the run dir)
 * @param {Array<{ rel: string, buffer: Buffer }>} [opts.stage]  files placed under /workspace (e.g. uploads/x.csv)
 * @param {{ dir?: string, maxFiles?: number, maxFileBytes?: number }|null} [opts.outbox]
 *        collect files created/changed under this /workspace directory during the run
 * @param {object} [opts.exportEnv]          extra environment variables for the script
 * @param {object} [opts.env]
 * @param {object} [opts.deps]               { createSandbox } for tests
 * @returns {Promise<object>} code-sandbox.run() shape + isolation + collected + runDir
 *          (+ staged, stageSkipped, outbox: { files, skipped } when requested)
 */
async function runIsolated(opts = {}) {
  const {
    language,
    source,
    stdin = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    inputs = [],
    collect = [],
    persistKey = null,
    workdir = 'run',
    stage = [],
    outbox = null,
    exportEnv = {},
    env = process.env,
    deps = {},
  } = (opts && typeof opts === 'object') ? opts : {};
  const lang = String(language || '').toLowerCase();
  const cfg = LANGUAGES[lang];
  if (!cfg) return failure(String(language || ''), `unsupported language: ${language}`);
  if (typeof source !== 'string' || !source.trim()) return failure(lang, 'empty source');
  const maxSource = positiveInt(env.SANDBOX_MAX_SOURCE_BYTES, DEFAULT_MAX_SOURCE_BYTES);
  if (Buffer.byteLength(source, 'utf8') > maxSource) {
    return failure(lang, `source too large (max ${Math.round(maxSource / 1024)} KB)`);
  }
  if (signal?.aborted) return failure(lang, 'aborted', { aborted: true, signal: 'SIGABRT' });

  const budgetMs = Math.min(MAX_TIMEOUT_MS, positiveInt(timeoutMs, DEFAULT_TIMEOUT_MS));
  const maxOutputBytes = positiveInt(env.SIRAGPT_CODE_SANDBOX_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
  const inWorkspace = workdir === 'workspace';

  const placedInputs = [];
  for (const item of (Array.isArray(inputs) ? inputs : []).slice(0, MAX_INPUT_FILES)) {
    const rel = safeRunRel(item?.rel);
    if (!rel || !Buffer.isBuffer(item?.buffer)) continue;
    placedInputs.push({ rel, buffer: item.buffer });
  }
  const collectRels = [];
  for (const name of (Array.isArray(collect) ? collect : []).slice(0, MAX_COLLECT_FILES)) {
    const rel = safeRunRel(name);
    if (rel) collectRels.push(rel);
  }
  // Files for /workspace itself (never inside tmp/, where run dirs live).
  const stageItems = [];
  const stageSkipped = [];
  for (const item of (Array.isArray(stage) ? stage : [])) {
    const rel = safeRunRel(item?.rel);
    if (!rel || rel.startsWith('tmp/') || !Buffer.isBuffer(item?.buffer)) continue;
    if (stageItems.length >= MAX_STAGE_FILES) { stageSkipped.push({ rel, reason: 'too_many' }); continue; }
    if (item.buffer.length > DEFAULT_MAX_STAGE_FILE_BYTES) { stageSkipped.push({ rel, reason: 'too_large', size: item.buffer.length }); continue; }
    stageItems.push({ rel, buffer: item.buffer });
  }
  const outboxDir = outbox ? safeRunRel(outbox.dir || 'outputs') : null;
  const outboxMaxFiles = outbox ? Math.min(OUTBOX_MAX_FILES, positiveInt(outbox.maxFiles, OUTBOX_MAX_FILES)) : 0;
  const outboxMaxBytes = outbox ? Math.min(OUTBOX_MAX_FILE_BYTES, positiveInt(outbox.maxFileBytes, OUTBOX_MAX_FILE_BYTES)) : 0;

  const createSandbox = deps.createSandbox || require('../doc-agent/sandbox').createSandbox;
  const semaphore = deps.semaphore || semaphoreFor(env);
  const abortSignal = signal && typeof signal.addEventListener === 'function' ? signal : undefined;

  let release = null;
  try {
    release = await semaphore.acquire(abortSignal ? { signal: abortSignal } : undefined);
  } catch {
    return failure(lang, 'aborted', { aborted: true, signal: 'SIGABRT' });
  }

  let sandbox = null;
  let runDirToRemove = null;
  // 'setup' until the user's script starts: a failure before that point ran
  // nothing, so a busy or unreachable service is reported as unavailable
  // (retry later), never as a crash of the user's code.
  let phase = 'setup';
  // The uploads that are in /workspace once staging finished (null until
  // then): callers mark the turn as staged only on this proof.
  let stagedRels = null;
  const started = Date.now();
  try {
    try {
      sandbox = await createSandbox({
        driver: env.SIRAGPT_CODE_SANDBOX_DRIVER || undefined,
        signal,
        env,
        persistKey: persistKey ? String(persistKey) : null,
      });
    } catch (err) {
      if (signal?.aborted) return failure(lang, 'aborted', { aborted: true, signal: 'SIGABRT' });
      const reason = String(err?.message || err || '').slice(0, 300);
      return failure(lang, UNAVAILABLE_MESSAGE, { unavailable: true, unavailableReason: reason });
    }
    const isolation = {
      driver: sandbox.driver || null,
      runtime: sandbox.runtime || null,
      gvisor: Boolean(sandbox.gvisor),
      persistent: Boolean(sandbox.persistent),
    };
    // The local driver runs on the API host itself. In production that is
    // never "isolated": an operator who wants host execution says so with
    // SIRAGPT_CODE_SANDBOX=host. Fail closed instead of claiming isolation.
    if (isolation.driver === 'local' && String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
      return failure(lang, UNAVAILABLE_MESSAGE, { unavailable: true, unavailableReason: 'local_driver_in_production' });
    }

    const runRel = `tmp/run-${crypto.randomBytes(6).toString('hex')}`;
    const runDir = `/workspace/${runRel}`;
    if (isolation.persistent) runDirToRemove = runDir;
    await sandbox.putFile(`${runRel}/${cfg.filename}`, Buffer.from(source, 'utf8'));
    await sandbox.putFile(`${runRel}/.stdin`, Buffer.from(String(stdin || ''), 'utf8'));
    for (const input of placedInputs) {
      await putFileChunked(sandbox, `${runRel}/${input.rel}`, input.buffer);
    }

    // The user's uploads: a persistent chat volume usually has them from an
    // earlier call already; only missing or different-size files travel.
    // Same name AND same content: skip. A corrected re-upload of the same
    // size must replace the old file, so content is compared, not size.
    const staged = [];
    if (stageItems.length) {
      const present = isolation.persistent
        ? await workspaceFileInfo(sandbox, stageItems.map((i) => i.rel), { hash: true })
        : new Map();
      for (const item of stageItems) {
        const have = present.get(item.rel);
        const same = have && have.size === item.buffer.length
          && have.sha256 === crypto.createHash('sha256').update(item.buffer).digest('hex');
        if (!same) await putFileChunked(sandbox, item.rel, item.buffer);
        staged.push(item.rel);
      }
    }
    stagedRels = staged;

    // `timeout` (coreutils, always in the sandbox image) enforces the script
    // budget INSIDE the container (exit 124 on expiry, KILL 2 s later if TERM
    // is ignored); the exec timeout is only the outer guard and destroy()
    // reaps anything left. The `command -v` fallback keeps the local dev
    // driver usable on hosts without coreutils `timeout` (macOS).
    const seconds = Math.max(1, Math.ceil(budgetMs / 1000));
    const legacyShape = !inWorkspace && !outboxDir && !Object.keys(exportEnv || {}).length;
    const prefix = inWorkspace ? `${runRel}/` : '';
    const invocation = `${cfg.interpreter} ${shQuote(`${prefix}${cfg.filename}`)} < ${shQuote(`${prefix}.stdin`)}`;
    // Redirections go BEFORE the heredoc: the terminator line must stand alone.
    const detector = (args, outFile) => `${SYS_PYTHON} - ${args} > ${shQuote(outFile)} 2>/dev/null <<'SIRA_OUTBOX_EOF'\n${OUTBOX_DETECTOR}\nSIRA_OUTBOX_EOF`;
    const lines = [
      `cd ${shQuote(inWorkspace ? '/workspace' : runDir)}`,
      inWorkspace ? 'mkdir -p outputs uploads' : '',
      inWorkspace && isolation.persistent
        ? `${SYS_PATH_PREFIX} find tmp -maxdepth 1 -type d -name 'run-*' -mmin +${STALE_RUN_MINUTES} -exec rm -rf {} + 2>/dev/null`
        : '',
      outboxDir ? detector(`snapshot ${shQuote(outboxDir)}`, `${prefix}.outbox-pre.json`) : '',
      exportLine({
        SIRA_RUN_DIR: runDir,
        ...(inWorkspace ? { WORKSPACE_DIR: '/workspace', OUTPUT_DIR: '/workspace/outputs', UPLOADS_DIR: '/workspace/uploads', ...THREAD_CAPS } : {}),
        ...exportEnv,
      }),
      '__sira_timeout="$(command -p -v timeout 2>/dev/null)"',
      `if [ -n "$__sira_timeout" ]; then "$__sira_timeout" -k 2 ${seconds} ${invocation}; else ${invocation}; fi`,
      '__sira_status=$?',
      outboxDir
        ? detector(`diff ${shQuote(outboxDir)} ${shQuote(`${prefix}.outbox-pre.json`)}`, `${prefix}.outbox.json`)
        : '',
      'exit $__sira_status',
    ].filter(Boolean);
    // Callers that need none of the computer features keep the exact
    // single-line command they always had.
    const legacyInvocation = `${cfg.interpreter} ${cfg.filename} < .stdin`;
    const command = legacyShape
      ? `cd ${shQuote(runDir)} && if command -v timeout >/dev/null 2>&1; then timeout -k 2 ${seconds} ${legacyInvocation}; else ${legacyInvocation}; fi`
      : lines.join('\n');
    phase = 'run';
    const execStarted = Date.now();
    const result = await sandbox.exec(command, { timeoutMs: budgetMs + EXEC_GRACE_MS, signal });
    const execMs = Date.now() - execStarted;
    const durationMs = Date.now() - started;
    const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
    const aborted = Boolean(result?.aborted || signal?.aborted);
    // A KILL (137) counts as the budget running out only when the script
    // itself ran that long (`timeout -k 2` kills after its TERM): the time
    // spent waiting for the container, the queue or the uploads is not the
    // script's. A KILL before that is the memory limit.
    const killed = exitCode === 137;
    const timedOut = !aborted && (Boolean(result?.timedOut) || exitCode === 124
      || (killed && execMs >= seconds * 1000));

    const collected = {};
    if (!aborted) {
      for (const rel of collectRels) {
        try {
          collected[rel] = await sandbox.readFile(`${runRel}/${rel}`);
        } catch {
          collected[rel] = null;
        }
      }
    }

    let outboxResult = null;
    if (outboxDir && !aborted) {
      outboxResult = { files: [], skipped: [] };
      let report = null;
      try {
        report = JSON.parse((await sandbox.readFile(`${runRel}/.outbox.json`)).toString('utf8'));
      } catch {
        report = null;
      }
      if (!report || typeof report !== 'object') {
        // No report (the script removed tmp/, or python3 is missing on a dev
        // host): nothing can be delivered, and the model must know why.
        outboxResult.skipped.push({ rel: '', reason: 'detector_failed' });
      } else {
        const changed = (Array.isArray(report.changed) ? report.changed : [])
          .map((rel) => safeRunRel(rel))
          .filter(Boolean)
          .slice(0, 200);
        if (report.capped === true) outboxResult.skipped.push({ rel: '', reason: 'scan_capped', limit: OUTBOX_SCAN_MAX_ENTRIES });
        const base = inWorkspace ? outboxDir : `${runRel}/${outboxDir}`;
        const wanted = changed.slice(0, outboxMaxFiles);
        for (const rel of changed.slice(outboxMaxFiles)) outboxResult.skipped.push({ rel, reason: 'too_many' });
        let sizes = null;
        try {
          sizes = await workspaceFileSizes(sandbox, wanted.map((rel) => `${base}/${rel}`), { strict: true });
        } catch {
          // The trusted size probe failed: nothing is read blind. The files
          // stay in outputs/; the model is told to save them again.
          for (const rel of wanted) outboxResult.skipped.push({ rel, reason: 'unmeasured' });
        }
        let totalBytes = 0;
        for (const rel of sizes ? wanted : []) {
          const size = sizes.get(`${base}/${rel}`);
          if (size == null) continue; // deleted again, or a symlink
          if (size > outboxMaxBytes) { outboxResult.skipped.push({ rel, reason: 'too_large', size }); continue; }
          if (totalBytes + size > OUTBOX_MAX_TOTAL_BYTES) { outboxResult.skipped.push({ rel, reason: 'total_too_large', size }); continue; }
          totalBytes += size;
          try {
            const buffer = await sandbox.readFile(`${base}/${rel}`);
            if (buffer.length > outboxMaxBytes) { outboxResult.skipped.push({ rel, reason: 'too_large', size: buffer.length }); continue; }
            outboxResult.files.push({ rel, size: buffer.length, buffer });
          } catch {
            outboxResult.skipped.push({ rel, reason: 'unreadable' });
          }
        }
      }
    }

    const out = truncateText(result?.stdout, maxOutputBytes);
    const err = truncateText(result?.stderr, maxOutputBytes);
    let stderr = err.text;
    if (timedOut && !stderr) stderr = `timeout after ${seconds}s`;
    if (aborted && !stderr) stderr = 'aborted';
    if (killed && !timedOut && !aborted) {
      stderr = `${stderr ? `${stderr}\n` : ''}[El proceso terminó por SIGKILL (código 137) antes de su tiempo límite: casi siempre es falta de memoria. Procesa los datos por partes, con tipos más compactos o menos columnas a la vez.]`;
    }
    return {
      ok: !aborted && !timedOut && exitCode === 0,
      exitCode,
      signal: aborted ? 'SIGABRT' : null,
      stdout: out.text,
      stderr,
      durationMs,
      timedOut,
      aborted,
      truncated: out.truncated || err.truncated,
      language: lang,
      isolation,
      collected,
      runDir,
      ...(stageItems.length || stageSkipped.length ? { staged, stageSkipped } : {}),
      ...(outboxResult ? { outbox: outboxResult } : {}),
    };
  } catch (err) {
    const stagedExtra = stagedRels ? { staged: stagedRels, stageSkipped } : {};
    if (signal?.aborted) return failure(lang, 'aborted', { aborted: true, signal: 'SIGABRT', ...stagedExtra });
    const reason = String(err?.message || err).slice(0, 300);
    if (phase === 'setup' && isServiceUnavailableError(err)) {
      return failure(lang, isAtCapacityError(err) ? BUSY_MESSAGE : UNAVAILABLE_MESSAGE, {
        unavailable: true,
        unavailableReason: reason,
        ...stagedExtra,
      });
    }
    const where = phase === 'setup' ? ' (the code did not run)' : '';
    return failure(lang, `sandbox internal error${where}: ${reason}`, stagedExtra);
  } finally {
    if (sandbox && runDirToRemove && !signal?.aborted) {
      // The conversation volume outlives this container: drop the run dir
      // (script, stdin, input copies, collected outputs) so it never piles
      // up. An aborted run cannot (its exec shares the aborted signal): the
      // next run of the chat sweeps stale run dirs.
      try {
        await sandbox.exec(`command -p rm -rf -- ${shQuote(runDirToRemove)}`, { timeoutMs: 15_000 });
      } catch { /* best effort */ }
    }
    if (sandbox && typeof sandbox.destroy === 'function') {
      try { await sandbox.destroy(); } catch { /* best effort: docker rm -f */ }
    }
    if (release) release();
  }
}

module.exports = {
  runIsolated,
  resolveCodeExecutionMode,
  safeRunRel,
  putFileChunked,
  workspaceFileSizes,
  workspaceFileInfo,
  OUTBOX_DETECTOR,
  OUTBOX_MAX_TOTAL_BYTES,
  OUTBOX_SCAN_MAX_ENTRIES,
  DEFAULT_MAX_STAGE_FILE_BYTES,
  UNAVAILABLE_MESSAGE,
  BUSY_MESSAGE,
  isServiceUnavailableError,
  truncateText,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
