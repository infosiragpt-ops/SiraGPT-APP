'use strict';

/**
 * sandbox-pip — install allowlisted Python packages INTO a document sandbox
 * without ever giving that sandbox a network.
 *
 * Shape of one install:
 *
 *   installer container (same image, `--network <policy>`, same limits,
 *   read-only rootfs, tmpfs /tmp, NO workspace mount, NO secrets)
 *     └─ pip install --user --only-binary=:all: … --report
 *     └─ validate EVERY resolved wheel against SIRA_PIP_ALLOW (JSON env)
 *     └─ tar -cf - $PYTHONUSERBASE          → stdout
 *   docker exec -i <sandbox> tar -xf - -C /workspace/.sira-packages.staging-*
 *   docker exec    <sandbox> cp -a staging/. /workspace/.sira-packages/
 *
 * The execution sandbox keeps `--network none`; wheels are only ever
 * unpacked (`--only-binary=:all:` → no setup.py runs anywhere); the payload
 * crosses as a byte-capped stream, so a hostile index can neither reach the
 * sandbox's network nor fill its volume. `PYTHONUSERBASE=/workspace/
 * .sira-packages` at execution time makes the tree importable.
 *
 * SELF-CONTAINED ON PURPOSE (node builtins only): the sandbox microservice
 * (services/sandbox/lib/sandbox-pip.js) ships a byte-identical copy and a
 * test keeps both in sync.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const PACKAGES_DIR = '/workspace/.sira-packages';
const INSTALLER_BASE = '/tmp/sira-pkgs';
const MARK = Object.freeze({
  ok: 'SIRA_PIP_OK',
  notAllowed: 'SIRA_PIP_NOT_ALLOWED',
  failed: 'SIRA_PIP_INSTALL_FAILED',
  report: 'SIRA_PIP_REPORT_UNREADABLE',
});
const STDERR_CAP = 64 * 1024;

const REQUIREMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9_.,-]+\])?(?:(?:===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9.*+!_-]+(?:,(?:===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9.*+!_-]+)*)?$/;
const INDEX_URL_RE = /^https?:\/\/[^\s'"`$;|&<>]+$/i;
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// A spec ending like an archive is a LOCAL file to pip (sdist → setup.py
// runs), never a registry name: «numpy==1.0.tar.gz», «evil-1.0-py3-none-any.whl».
const ARCHIVE_SUFFIX_RE = /\.(?:whl|zip|tar|tgz|tbz2?|txz|gz|bz2|xz)$/i;
const SIZE_RE = /^\d+(\.\d+)?[bkmg]?$/;

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isSafeRequirement(spec) {
  const s = String(spec == null ? '' : spec);
  return s.length > 0 && s.length <= 100 && REQUIREMENT_RE.test(s) && !ARCHIVE_SUFFIX_RE.test(s);
}

/** The host namespace would put the egress-enabled installer on the host network. */
function isSafeNetwork(network) {
  const n = String(network == null ? '' : network);
  return NETWORK_RE.test(n) && n !== 'host';
}

function isSafeIndexUrl(url) {
  return url == null || url === '' || INDEX_URL_RE.test(String(url));
}

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * The script the installer runs. pip's own output goes to stderr so stdout
 * carries nothing but the tar stream. `$SIRA_PIP_ALLOW` (JSON array of
 * PEP 503 names) is checked against pip's `--report` BEFORE anything is
 * streamed: one non-allowlisted wheel refuses the whole install (exit 3).
 */
function buildInstallScript({ requirements, indexUrl = null, base = INSTALLER_BASE } = {}) {
  const specs = Array.isArray(requirements) ? requirements.map(String) : [];
  if (!specs.length) throw new Error('sandbox-pip: requirements are required');
  for (const spec of specs) {
    if (!isSafeRequirement(spec)) throw new Error(`sandbox-pip: unsafe requirement ${JSON.stringify(spec)}`);
  }
  if (!isSafeIndexUrl(indexUrl)) throw new Error('sandbox-pip: unsafe index url');
  if (!/^[A-Za-z0-9_./-]+$/.test(String(base))) throw new Error('sandbox-pip: unsafe base dir');
  const index = indexUrl ? `--index-url ${shQuote(indexUrl)} ` : '';
  const quoted = specs.map(shQuote).join(' ');
  return [
    'set -u',
    `BASE=${shQuote(base)}`,
    'export HOME="$BASE/home" TMPDIR="$BASE/tmp" PYTHONUSERBASE="$BASE/site"',
    'export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 PIP_BREAK_SYSTEM_PACKAGES=1 PIP_NO_CACHE_DIR=1 PIP_PROGRESS_BAR=off',
    'rm -rf "$BASE" && mkdir -p "$BASE/home" "$BASE/tmp" "$BASE/site/.sira" || exit 70',
    // The image's own distributions are pinned as constraints: an install can
    // add packages but never swap the numpy/lxml/python-pptx the image was
    // built and tested with (a conflicting pin fails honestly instead of
    // shadowing it through the user site). Only plain name==version lines
    // survive, so an odd distro version can never break the constraints file.
    'PYTHONNOUSERSITE=1 python3 -m pip list --format=freeze 2>/dev/null | grep -E \'^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9]+([.][0-9]+)*((a|b|rc)[0-9]+)?([.]post[0-9]+)?([.]dev[0-9]+)?([+][A-Za-z0-9.]+)?$\' > "$BASE/constraints.txt" || : > "$BASE/constraints.txt"',
    `python3 -m pip install --user --only-binary=:all: --no-cache-dir --no-warn-script-location --timeout 60 --retries 2 ${index}-c "$BASE/constraints.txt" --report "$BASE/report.json" -- ${quoted} 1>&2`,
    'status=$?',
    `if [ "$status" -ne 0 ]; then echo "${MARK.failed} $status" 1>&2; exit "$status"; fi`,
    // Isolated (-I -s, no user site): a .pth or usercustomize.py inside a
    // freshly installed wheel must not run before — and forge — this check.
    'PYTHONNOUSERSITE=1 python3 -I -s - "$BASE" 1>&2 <<\'PY\'',
    'import json, os, re, sys',
    'base = sys.argv[1]',
    "allow = set(json.loads(os.environ.get('SIRA_PIP_ALLOW') or '[]'))",
    "def norm(n): return re.sub(r'[-_.]+', '-', str(n)).lower()",
    'try:',
    "    report = json.load(open(os.path.join(base, 'report.json')))",
    'except Exception as exc:',
    `    print('${MARK.report} ' + str(exc)[:200]); sys.exit(4)`,
    'installed, bad = [], []',
    "for item in report.get('install', []):",
    "    meta = item.get('metadata') or {}",
    "    name, version = str(meta.get('name') or ''), str(meta.get('version') or '')",
    '    if norm(name) not in allow: bad.append(norm(name))',
    "    installed.append({'name': norm(name), 'version': version})",
    'if bad:',
    `    print('${MARK.notAllowed} ' + ','.join(sorted(set(bad)))); sys.exit(3)`,
    "json.dump({'installed': installed}, open(os.path.join(base, 'site', '.sira', 'installed.json'), 'w'))",
    `print('${MARK.ok} ' + json.dumps(installed))`,
    'PY',
    'status=$?',
    'if [ "$status" -ne 0 ]; then exit "$status"; fi',
    'cd "$BASE/site" && tar -cf - .',
  ].join('\n');
}

/**
 * `docker run` arguments for the installer container. Mirrors the sandbox's
 * own hardening (doc-agent/sandbox.js buildDockerRunArgs) with two deliberate
 * differences: a network (the policy's, default bridge) and NO workspace
 * mount — the only thing that leaves this container is the tar on stdout.
 */
function installerRunArgs({
  name, image, runtime = null, network = 'bridge', limits = {}, tmpSize = '1g', allowJson = '[]', script,
} = {}) {
  if (!name || !image || !script) throw new Error('sandbox-pip: name, image and script are required');
  if (!isSafeNetwork(network)) throw new Error('sandbox-pip: unsafe docker network');
  if (!SIZE_RE.test(String(tmpSize))) throw new Error('sandbox-pip: unsafe tmpfs size');
  const args = ['run', '--rm', '--name', String(name)];
  if (runtime) args.push('--runtime', String(runtime));
  args.push('--network', String(network));
  if (limits.memory) args.push('--memory', String(limits.memory), '--memory-swap', String(limits.memory));
  if (limits.cpus) args.push('--cpus', String(limits.cpus));
  if (limits.pidsLimit) args.push('--pids-limit', String(limits.pidsLimit));
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only');
  // Same pinned syscall filter as the execution sandbox (never "unconfined").
  if (limits.seccompProfile && String(limits.seccompProfile).toLowerCase() !== 'unconfined') {
    args.push('--security-opt', `seccomp=${limits.seccompProfile}`);
  }
  if (limits.ulimitNofile) args.push('--ulimit', `nofile=${limits.ulimitNofile}:${limits.ulimitNofile}`);
  if (limits.maxFileBytes) args.push('--ulimit', `fsize=${limits.maxFileBytes}:${limits.maxFileBytes}`);
  args.push(
    '--tmpfs', `/tmp:rw,exec,size=${tmpSize}`,
    '-e', 'HOME=/tmp',
    '-e', 'TMPDIR=/tmp',
    '-e', `SIRA_PIP_ALLOW=${allowJson}`,
    String(image), 'bash', '-c', String(script),
  );
  return args;
}

function extractScript(staging) {
  const s = shQuote(staging);
  return `rm -rf ${s} && mkdir -p ${s} && tar -xf - -C ${s}`;
}

function commitScript(staging, target) {
  const s = shQuote(staging);
  const t = shQuote(target);
  // Hard links: staging lives on the same filesystem, so the merge needs no
  // second copy of the payload (no ENOSPC half-way on a tmpfs workspace) and
  // is near-instant; a plain copy is the fallback when links are refused.
  return `mkdir -p ${t} && { cp -alf ${s}/. ${t}/ 2>/dev/null || cp -af ${s}/. ${t}/; } && rm -rf ${s}`;
}

function rollbackScript(staging) {
  return `rm -rf ${shQuote(staging)}`;
}

function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (_) { /* already gone */ }
}

/**
 * producer.stdout → consumer.stdin with a byte cap, one timeout for both,
 * and the caller's AbortSignal. Resolves (never rejects) once BOTH processes
 * closed.
 */
function pipeProcesses({ producer, consumer, maxBytes, timeoutMs, signal, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const detached = process.platform !== 'win32';
    let bytes = 0;
    let tooLarge = false;
    let timedOut = false;
    let aborted = false;
    let producerStderr = Buffer.alloc(0);
    let consumerStderr = Buffer.alloc(0);
    let producerCode = null;
    let consumerCode = null;
    let producerDone = false;
    let producerStdoutEnded = false;
    let consumerDone = false;
    let consumerFailedFirst = false;
    let settled = false;
    const p = spawnImpl(producer.cmd, producer.args, {
      cwd: producer.cwd, env: producer.env, stdio: ['ignore', 'pipe', 'pipe'], detached,
    });
    const c = spawnImpl(consumer.cmd, consumer.args, {
      cwd: consumer.cwd, env: consumer.env, stdio: ['pipe', 'pipe', 'pipe'], detached,
    });
    const killAll = () => { killTree(p); killTree(c); };
    const timer = setTimeout(() => { timedOut = true; killAll(); }, timeoutMs);
    const onAbort = () => { aborted = true; killAll(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = () => {
      if (settled || !(producerDone && consumerDone)) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: producerCode,
        consumerExitCode: consumerCode,
        stderr: producerStderr.toString('utf8'),
        consumerStderr: consumerStderr.toString('utf8'),
        bytes,
        timedOut,
        aborted,
        tooLarge,
        consumerFailedFirst,
      });
    };
    const appendErr = (buf, d) => (buf.length < STDERR_CAP ? Buffer.concat([buf, Buffer.from(d)]) : buf);
    p.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > maxBytes && !tooLarge) { tooLarge = true; killAll(); }
    });
    // Registered before pipe(): set before the consumer can see the EOF.
    p.stdout.on('end', () => { producerStdoutEnded = true; });
    p.stdout.pipe(c.stdin);
    c.stdin.on('error', () => { /* EPIPE when the consumer died first */ });
    p.stdout.on('error', () => { /* producer killed mid-stream */ });
    p.stderr.on('data', (d) => { producerStderr = appendErr(producerStderr, d); });
    c.stderr.on('data', (d) => { consumerStderr = appendErr(consumerStderr, d); });
    c.stdout.on('data', () => { /* ignored */ });
    const closeCode = (code, sig) => (code == null && sig ? 137 : (code == null ? 0 : code));
    p.on('error', (err) => {
      producerStderr = appendErr(producerStderr, String(err && err.message || err));
      if (producerCode == null) producerCode = 127;
      producerDone = true;
      killTree(c);
      finish();
    });
    p.on('close', (code, sig) => {
      if (producerCode == null) producerCode = closeCode(code, sig);
      producerDone = true;
      finish();
    });
    c.on('error', (err) => {
      consumerStderr = appendErr(consumerStderr, String(err && err.message || err));
      if (consumerCode == null) consumerCode = 127;
      consumerDone = true;
      killTree(p);
      finish();
    });
    c.on('close', (code, sig) => {
      if (consumerCode == null) consumerCode = closeCode(code, sig);
      consumerDone = true;
      // The extractor died while the installer still streams: stop it now
      // (its container has a network) instead of waiting for the timeout.
      // Once the installer's output has ended it streams nothing more: a
      // failed install writes no archive, tar fails on the empty input, and
      // the installer's own exit (not_allowed, not_found…) must still be read
      // even when tar's close arrives before the installer's.
      if (consumerCode !== 0 && !producerDone && !producerStdoutEnded && !tooLarge && !timedOut && !aborted) {
        consumerFailedFirst = true;
        killTree(p);
      }
      finish();
    });
  });
}

/** Minimal one-shot runner for the commit / rollback commands. */
function runCommandOnce(cmd, args, { timeoutMs = 60_000, env, cwd, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    const child = spawnImpl(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut });
    };
    child.stdout.on('data', (d) => { if (stdout.length < STDERR_CAP) stdout = Buffer.concat([stdout, d]); });
    child.stderr.on('data', (d) => { if (stderr.length < STDERR_CAP) stderr = Buffer.concat([stderr, d]); });
    child.on('error', (err) => { stderr = Buffer.concat([stderr, Buffer.from(String(err && err.message || err))]); finish(127); });
    child.on('close', (code, sig) => finish(timedOut ? 124 : (code == null && sig ? 137 : (code == null ? 0 : code))));
  });
}

/**
 * Read the installer's stderr: our markers first, then pip's own words for
 * the honest failure classes a model can act on.
 */
function parseInstallerStderr(stderr) {
  const text = String(stderr || '');
  const out = { code: 'install_failed', installed: [], notAllowed: [], notFound: [], detail: '' };
  const okLine = text.split('\n').find((line) => line.startsWith(`${MARK.ok} `));
  if (okLine) {
    try { out.installed = JSON.parse(okLine.slice(MARK.ok.length + 1)); } catch (_) { out.installed = []; }
    out.code = 'ok';
  }
  const badLine = text.split('\n').find((line) => line.startsWith(`${MARK.notAllowed} `));
  if (badLine) {
    out.code = 'not_allowed';
    out.notAllowed = badLine.slice(MARK.notAllowed.length + 1).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (text.includes(MARK.report)) out.code = 'report_unreadable';
  if (text.includes(`${MARK.failed} `)) {
    const notFound = [...text.matchAll(/No matching distribution found for ([^\s]+)/g)].map((m) => m[1]);
    const noVersion = [...text.matchAll(/Could not find a version that satisfies the requirement ([^\s]+)/g)].map((m) => m[1]);
    out.notFound = [...new Set([...notFound, ...noVersion])];
    if (out.notFound.length) out.code = 'not_found';
    else if (/ResolutionImpossible|conflicting dependencies|Cannot install .* because these package versions/i.test(text)) out.code = 'conflict';
    else if (/Temporary failure in name resolution|Max retries exceeded|NewConnectionError|ReadTimeoutError|ProxyError|Network is unreachable|Connection refused|timed out/i.test(text)) out.code = 'network';
    else if (/No space left on device/i.test(text)) out.code = 'disk';
    else out.code = 'install_failed';
  }
  const cleaned = text.split('\n').filter((line) => !/^SIRA_PIP_/.test(line)).join('\n').trim();
  out.detail = cleaned.slice(-600);
  return out;
}

/**
 * One install, end to end, for the docker (`containerName`) or local
 * (`root`) driver. Resolves a result object; never rejects.
 */
async function runSandboxInstall({
  kind,
  containerName = null,
  root = null,
  image = null,
  runtime = null,
  limits = {},
  requirements,
  allowJson = '[]',
  indexUrl = null,
  network = 'bridge',
  timeoutMs = 180_000,
  maxBytes = 300 * 1024 * 1024,
  tmpSize = '1g',
  signal,
  spawnImpl = spawn,
  runCommand = null,
  now = Date.now,
} = {}) {
  const startedAt = now();
  const suffix = randomSuffix();
  const result = (patch) => ({
    ok: false, code: 'install_failed', installed: [], notAllowed: [], notFound: [], bytes: 0,
    durationMs: now() - startedAt, detail: '', ...patch,
  });
  const specs = Array.isArray(requirements) ? requirements.map(String) : [];
  if (!specs.length || !specs.every(isSafeRequirement)) return result({ code: 'invalid_request' });
  if (!isSafeIndexUrl(indexUrl)) return result({ code: 'invalid_request', detail: 'index url' });
  const exec = runCommand || ((cmd, args, opts) => runCommandOnce(cmd, args, { ...opts, spawnImpl }));

  let producer;
  let consumer;
  let commit;
  let rollback;
  let cleanupLocal = null;
  if (kind === 'docker') {
    if (!containerName || !image) return result({ code: 'invalid_request', detail: 'container' });
    const script = buildInstallScript({ requirements: specs, indexUrl });
    const installerName = `sira-pip-${suffix}`;
    const staging = `${PACKAGES_DIR}.staging-${suffix}`;
    producer = {
      cmd: 'docker',
      args: installerRunArgs({ name: installerName, image, runtime, network, limits, tmpSize, allowJson, script }),
      env: process.env,
    };
    consumer = { cmd: 'docker', args: ['exec', '-i', containerName, 'sh', '-c', extractScript(staging)], env: process.env };
    commit = () => exec('docker', ['exec', containerName, 'sh', '-c', commitScript(staging, PACKAGES_DIR)], { timeoutMs: 120_000 });
    rollback = async () => {
      await exec('docker', ['exec', containerName, 'sh', '-c', rollbackScript(staging)], { timeoutMs: 30_000 }).catch(() => {});
      await exec('docker', ['rm', '-f', installerName], { timeoutMs: 15_000 }).catch(() => {});
    };
  } else if (kind === 'local') {
    if (!root) return result({ code: 'invalid_request', detail: 'root' });
    const base = path.join(os.tmpdir(), `sira-pip-${suffix}`);
    const script = buildInstallScript({ requirements: specs, indexUrl, base });
    const target = path.join(root, '.sira-packages');
    const staging = `${target}.staging-${suffix}`;
    const env = {
      PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8', HOME: base, SIRA_PIP_ALLOW: allowJson,
    };
    producer = { cmd: 'bash', args: ['-c', script], env, cwd: root };
    consumer = { cmd: 'bash', args: ['-c', extractScript(staging)], env, cwd: root };
    commit = () => exec('bash', ['-c', commitScript(staging, target)], { timeoutMs: 120_000, env, cwd: root });
    rollback = () => exec('bash', ['-c', rollbackScript(staging)], { timeoutMs: 30_000, env, cwd: root }).catch(() => {});
    cleanupLocal = () => exec('bash', ['-c', rollbackScript(base)], { timeoutMs: 30_000, env }).catch(() => {});
  } else {
    return result({ code: 'invalid_request', detail: 'driver' });
  }

  const piped = await pipeProcesses({ producer, consumer, maxBytes, timeoutMs, signal, spawnImpl });
  const parsed = parseInstallerStderr(piped.stderr);
  const base = {
    installed: parsed.installed, notAllowed: parsed.notAllowed, notFound: parsed.notFound,
    bytes: piped.bytes, detail: parsed.detail,
  };
  let final;
  if (piped.aborted) final = result({ ...base, code: 'aborted' });
  else if (piped.consumerFailedFirst) final = result({ ...base, code: 'extract_failed', detail: piped.consumerStderr.slice(-600) });
  else if (piped.timedOut) final = result({ ...base, code: 'timeout' });
  else if (piped.tooLarge) final = result({ ...base, code: 'too_large' });
  else if (parsed.code !== 'ok' || piped.exitCode !== 0) final = result({ ...base, code: parsed.code === 'ok' ? 'install_failed' : parsed.code });
  else if (piped.consumerExitCode !== 0) final = result({ ...base, code: 'extract_failed', detail: piped.consumerStderr.slice(-600) });
  else {
    const committed = await commit();
    if (committed.exitCode === 0) final = result({ ...base, ok: true, code: 'ok' });
    else final = result({ ...base, code: 'commit_failed', detail: String(committed.stderr || '').slice(-600) });
  }
  if (!final.ok) await rollback();
  if (cleanupLocal) await cleanupLocal();
  final.durationMs = now() - startedAt;
  return final;
}

module.exports = {
  PACKAGES_DIR,
  INSTALLER_BASE,
  MARK,
  REQUIREMENT_RE,
  shQuote,
  ARCHIVE_SUFFIX_RE,
  isSafeRequirement,
  isSafeNetwork,
  isSafeIndexUrl,
  buildInstallScript,
  installerRunArgs,
  extractScript,
  commitScript,
  rollbackScript,
  pipeProcesses,
  runCommandOnce,
  parseInstallerStderr,
  runSandboxInstall,
};
