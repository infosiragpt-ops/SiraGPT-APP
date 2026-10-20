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
 *   rebuild the complete installed set, then atomically exchange directories
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

/** Metadata is untrusted workspace data, never shell or Python source. */
function validateInstalled(raw) {
  if (!Array.isArray(raw) || raw.length > 512) throw new Error('sandbox-pip: invalid installed metadata');
  const seen = new Map();
  for (const item of raw) {
    const name = String(item?.name || '');
    const version = String(item?.version || '');
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)
      || !/^[A-Za-z0-9][A-Za-z0-9.!+_-]{0,99}$/.test(version)
      || !isSafeRequirement(`${name}===${version}`)) throw new Error('sandbox-pip: invalid installed metadata');
    if (seen.has(name) && seen.get(name) !== version) throw new Error('sandbox-pip: conflicting installed metadata');
    seen.set(name, version);
  }
  return [...seen].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version }));
}

function parseEnvironmentSnapshot(stdout) {
  const data = JSON.parse(String(stdout || ''));
  if (data?.code !== 'ok') throw new Error('sandbox-pip: environment inventory failed');
  const revision = data.revision;
  if (revision !== null && (!revision || !/^\d+$/.test(String(revision.dev))
    || !/^\d+$/.test(String(revision.ino)))) throw new Error('sandbox-pip: invalid revision');
  return {
    revision: revision === null ? null : { dev: String(revision.dev), ino: String(revision.ino) },
    installed: validateInstalled(data.installed),
  };
}

function pythonCommand(source, args) {
  return `python3 -I -s - ${args.map(shQuote).join(' ')} <<'SIRA_PY'\n${source}\nSIRA_PY`;
}

/** Return Python source; invoke with -I -s and target as argv[1]. */
function buildEnvironmentSnapshotScript() {
  return [
    'import importlib.metadata as metadata, json, os, re, site, stat, sys',
    'target = sys.argv[1]',
    'def revision():',
    '    try: info = os.lstat(target)',
    '    except FileNotFoundError: return None',
    '    if not stat.S_ISDIR(info.st_mode): raise ValueError("package root is not a directory")',
    '    return {"dev": str(info.st_dev), "ino": str(info.st_ino)}',
    'try:',
    '    before = revision()',
    '    packages = {}',
    '    if before is not None:',
    '        site.USER_BASE, site.USER_SITE = target, None',
    '        for dist in metadata.distributions(path=[site.getusersitepackages()]):',
    '            name, version = dist.metadata.get("Name", ""), dist.version or ""',
    '            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", name) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.!+_-]{0,99}", version):',
    '                raise ValueError("invalid installed metadata")',
    '            name = re.sub(r"[-_.]+", "-", name).lower()',
    '            if len(name + "===" + version) > 100: raise ValueError("metadata is too long")',
    '            if name in packages and packages[name] != version: raise ValueError("conflicting installed metadata")',
    '            packages[name] = version',
    '            if len(packages) > 512: raise ValueError("too many installed packages")',
    '    if revision() != before: raise ValueError("package root changed during inventory")',
    '    payload = json.dumps({"code": "ok", "revision": before, "installed": [{"name": n, "version": v} for n, v in sorted(packages.items())]})',
    '    if len(payload.encode("utf-8")) > 60000: raise ValueError("inventory is too large")',
    '    print(payload)',
    'except Exception:',
    '    print(json.dumps({"code": "environment_invalid"}))',
    '    sys.exit(2)',
  ].join('\n');
}

/**
 * The script the installer runs. pip's own output goes to stderr so stdout
 * carries nothing but the tar stream. `$SIRA_PIP_ALLOW` (JSON array of
 * PEP 503 names) is checked against pip's `--report` BEFORE anything is
 * streamed: one non-allowlisted wheel refuses the whole install (exit 3).
 */
function buildInstallScript({ requirements, existing = [], indexUrl = null, base = INSTALLER_BASE } = {}) {
  const specs = Array.isArray(requirements) ? requirements.map(String) : [];
  if (!specs.length) throw new Error('sandbox-pip: requirements are required');
  for (const spec of specs) {
    if (!isSafeRequirement(spec)) throw new Error(`sandbox-pip: unsafe requirement ${JSON.stringify(spec)}`);
  }
  const prior = validateInstalled(existing);
  const priorPins = prior.map(({ name, version }) => `${name}===${version}`);
  for (const spec of priorPins) {
    if (!isSafeRequirement(spec)) throw new Error('sandbox-pip: invalid installed package');
  }
  if (!isSafeIndexUrl(indexUrl)) throw new Error('sandbox-pip: unsafe index url');
  if (!/^[A-Za-z0-9_./-]+$/.test(String(base))) throw new Error('sandbox-pip: unsafe base dir');
  const index = indexUrl ? `--index-url ${shQuote(indexUrl)} ` : '';
  const quoted = [...priorPins, ...specs].map(shQuote).join(' ');
  return [
    'set -u',
    `BASE=${shQuote(base)}`,
    'export HOME="$BASE/home" TMPDIR="$BASE/tmp" PYTHONUSERBASE="$BASE/site"',
    'export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 PIP_BREAK_SYSTEM_PACKAGES=1 PIP_NO_CACHE_DIR=1 PIP_PROGRESS_BAR=off',
    'rm -rf "$BASE" && mkdir -p "$BASE/home" "$BASE/tmp" "$BASE/site/.sira" || exit 70',
    // Read metadata without activating either user site. Arbitrary equality
    // preserves distro versions too (for example a Debian/Ubuntu suffix);
    // a failed inventory never silently produces an empty constraint set.
    'python3 -I -s - "$BASE/constraints.txt" <<\'PY\'',
    'import importlib.metadata as metadata, re, sys',
    'pins = {}',
    'for dist in metadata.distributions():',
    '    name, version = dist.metadata.get("Name", ""), dist.version or ""',
    '    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", name) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.!+_-]{0,99}", version):',
    '        raise ValueError("invalid base distribution metadata")',
    '    name = re.sub(r"[-_.]+", "-", name).lower()',
    // System and pip packages can coexist in different sys.path entries.
    // Keep the first distribution, matching Python/pip lookup precedence;
    // shadowed OS metadata must not override or invalidate the active one.
    '    pins.setdefault(name, version)',
    'with open(sys.argv[1], "w", encoding="utf-8") as handle:',
    '    handle.write("".join(name + "===" + version + "\\n" for name, version in sorted(pins.items())))',
    'PY',
    'status=$?',
    `if [ "$status" -ne 0 ]; then echo "${MARK.failed} $status" 1>&2; exit "$status"; fi`,
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

function commitScript(staging, target, expectedRevision = null, transactionId = randomSuffix()) {
  // Ubuntu's renameat2 exchanges even nonempty directories atomically. macOS
  // renamex_np provides the same contract for local development. Unsupported
  // filesystems/platforms fail closed: never fall back to a partial cp/mv.
  const source = [
    'import ctypes, errno, fcntl, json, os, shutil, stat, sys',
    'staging, target, expected_raw, transaction = sys.argv[1:]',
    'expected = json.loads(expected_raw)',
    'committed = False',
    'def revision():',
    '    try: info = os.lstat(target)',
    '    except FileNotFoundError: return None',
    '    if not stat.S_ISDIR(info.st_mode): raise ValueError("invalid package root")',
    '    return {"dev": str(info.st_dev), "ino": str(info.st_ino)}',
    'try:',
    '    if os.path.dirname(staging) != os.path.dirname(target) or staging == target: raise ValueError("invalid staging path")',
    '    if not stat.S_ISDIR(os.lstat(staging).st_mode): raise ValueError("invalid staging root")',
    '    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)',
    '    with os.fdopen(os.open(target + ".lock", flags, 0o600), "a+") as lock:',
    '        try: fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)',
    '        except BlockingIOError:',
    '            print(json.dumps({"code": "environment_changed", "committed": False})); sys.exit(3)',
    '        if revision() != expected:',
    '            print(json.dumps({"code": "environment_changed", "committed": False})); sys.exit(3)',
    '        info_dir = os.path.join(staging, ".sira")',
    '        os.makedirs(info_dir, exist_ok=True)',
    '        if not stat.S_ISDIR(os.lstat(info_dir).st_mode): raise ValueError("invalid staging metadata")',
    '        if expected is not None:',
    '            old_manifest = os.path.join(target, ".sira", "manifest.json")',
    '            try:',
    '                info = os.lstat(old_manifest)',
    '                if stat.S_ISREG(info.st_mode) and info.st_size <= 1048576:',
    '                    shutil.copyfile(old_manifest, os.path.join(info_dir, "manifest.json"))',
    '            except FileNotFoundError: pass',
    '        with open(os.path.join(info_dir, "transaction.json"), "w", encoding="utf-8") as handle:',
    '            json.dump({"id": transaction}, handle); handle.flush(); os.fsync(handle.fileno())',
    '        if expected is None:',
    '            os.rename(staging, target)',
    '        else:',
    '            libc = ctypes.CDLL(None, use_errno=True)',
    '            if sys.platform.startswith("linux"):',
    '                exchange = libc.renameat2',
    '                exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
    '                exchange.restype = ctypes.c_int',
    '                result = exchange(-100, os.fsencode(staging), -100, os.fsencode(target), 2)',
    '            elif sys.platform == "darwin":',
    '                exchange = libc.renamex_np',
    '                exchange.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]',
    '                exchange.restype = ctypes.c_int',
    '                result = exchange(os.fsencode(staging), os.fsencode(target), 2)',
    '            else: raise OSError(errno.ENOTSUP, "atomic directory exchange unavailable")',
    '            if result != 0: raise OSError(ctypes.get_errno(), "atomic directory exchange failed")',
    '        committed = True',
    '    print(json.dumps({"code": "ok", "committed": True}))',
    'except Exception:',
    '    print(json.dumps({"code": "ok" if committed else "commit_failed", "committed": committed}))',
    '    sys.exit(0 if committed else 4)',
  ].join('\n');
  return pythonCommand(source, [staging, target, JSON.stringify(expectedRevision), transactionId]);
}

function commitStatusScript(target, transactionId) {
  return pythonCommand([
    'import json, os, sys',
    'try:',
    '    with open(os.path.join(sys.argv[1], ".sira", "transaction.json"), encoding="utf-8") as handle: data = json.load(handle)',
    '    print(json.dumps({"committed": data.get("id") == sys.argv[2]}))',
    'except Exception: print(json.dumps({"committed": None}))',
  ].join('\n'), [target, transactionId]);
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
    let c;
    try {
      c = spawnImpl(consumer.cmd, consumer.args, {
        cwd: consumer.cwd, env: consumer.env, stdio: ['pipe', 'pipe', 'pipe'], detached,
      });
    } catch (err) {
      killTree(p);
      throw err;
    }
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
function runCommandOnce(cmd, args, { timeoutMs = 60_000, env, cwd, signal, spawnImpl = spawn } = {}) {
  if (signal?.aborted) return Promise.resolve({ exitCode: 137, stdout: '', stderr: '', timedOut: false, aborted: true });
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const child = spawnImpl(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, aborted });
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

  let runInWorkspace;
  let producer;
  let consumer;
  let target;
  let staging;
  let installerName;
  let localBase;
  let localEnv;
  let transfer = null;
  let commitAttempted = false;
  let keepCandidate = false;
  const cleanups = [];
  try {
    if (signal?.aborted) return result({ code: 'aborted' });
    if (kind === 'docker') {
      if (!containerName || !image) return result({ code: 'invalid_request', detail: 'container' });
      target = PACKAGES_DIR;
      installerName = `sira-pip-${suffix}`;
      runInWorkspace = (script, opts) => exec('docker', ['exec', containerName, 'sh', '-c', script], opts);
    } else if (kind === 'local') {
      if (!root) return result({ code: 'invalid_request', detail: 'root' });
      target = path.join(root, '.sira-packages');
      localBase = path.join(os.tmpdir(), `sira-pip-${suffix}`);
      localEnv = {
        PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8', HOME: localBase, SIRA_PIP_ALLOW: allowJson,
      };
      runInWorkspace = (script, opts) => exec('bash', ['-c', script], { ...opts, env: localEnv, cwd: root });
    } else {
      return result({ code: 'invalid_request', detail: 'driver' });
    }
    const probe = await runInWorkspace(pythonCommand(buildEnvironmentSnapshotScript(), [target]), { timeoutMs: 30_000, signal });
    if (signal?.aborted || probe.aborted) return result({ code: 'aborted' });
    if (probe.exitCode !== 0) return result({ code: 'environment_invalid' });
    let environment;
    try { environment = parseEnvironmentSnapshot(probe.stdout); }
    catch (_) { return result({ code: 'environment_invalid' }); }

    const script = buildInstallScript({ requirements: specs, existing: environment.installed, indexUrl, ...(localBase ? { base: localBase } : {}) });
    staging = `${target}.staging-${suffix}`;
    // Only ever remove the candidate path. After an atomic exchange it holds
    // the old tree; before the exchange it holds the uncommitted new tree.
    cleanups.push(() => keepCandidate ? undefined : runInWorkspace(rollbackScript(staging), { timeoutMs: 30_000 }));
    if (kind === 'docker') {
      cleanups.push(() => exec('docker', ['rm', '-f', installerName], { timeoutMs: 15_000 }));
      producer = {
        cmd: 'docker',
        args: installerRunArgs({ name: installerName, image, runtime, network, limits, tmpSize, allowJson, script }),
        env: process.env,
      };
      consumer = { cmd: 'docker', args: ['exec', '-i', containerName, 'sh', '-c', extractScript(staging)], env: process.env };
    } else {
      cleanups.push(() => exec('bash', ['-c', rollbackScript(localBase)], { timeoutMs: 30_000, env: localEnv }));
      producer = { cmd: 'bash', args: ['-c', script], env: localEnv, cwd: root };
      consumer = { cmd: 'bash', args: ['-c', extractScript(staging)], env: localEnv, cwd: root };
    }

    const piped = await pipeProcesses({ producer, consumer, maxBytes, timeoutMs, signal, spawnImpl });
    const parsed = parseInstallerStderr(piped.stderr);
    transfer = {
      installed: parsed.installed, notAllowed: parsed.notAllowed, notFound: parsed.notFound,
      bytes: piped.bytes, detail: parsed.detail,
    };
    if (piped.aborted || signal?.aborted) return result({ ...transfer, code: 'aborted' });
    if (piped.consumerFailedFirst) return result({ ...transfer, code: 'extract_failed', detail: piped.consumerStderr.slice(-600) });
    if (piped.timedOut) return result({ ...transfer, code: 'timeout' });
    if (piped.tooLarge) return result({ ...transfer, code: 'too_large' });
    if (parsed.code !== 'ok' || piped.exitCode !== 0) return result({ ...transfer, code: parsed.code === 'ok' ? 'install_failed' : parsed.code });
    if (piped.consumerExitCode !== 0) return result({ ...transfer, code: 'extract_failed', detail: piped.consumerStderr.slice(-600) });

    // Cancellation is honored until this short atomic commit starts. Do not
    // interrupt the exchange itself: its actual outcome must be reported.
    if (signal?.aborted) return result({ ...transfer, code: 'aborted' });
    let committed;
    commitAttempted = true;
    try {
      committed = await runInWorkspace(commitScript(staging, target, environment.revision, suffix), { timeoutMs: 30_000 });
    } catch (_) { committed = { exitCode: 1, stdout: '' }; }
    let status;
    try { status = JSON.parse(committed.stdout); } catch (_) { status = null; }
    if (committed.exitCode === 0 && status?.committed === true) return result({ ...transfer, ok: true, code: 'ok' });
    if (status?.code === 'environment_changed') return result({ ...transfer, code: 'environment_changed', detail: '' });
    if (status?.code === 'commit_failed' && status.committed === false) return result({ ...transfer, code: 'commit_failed', detail: '' });

    // A lost docker-exec response or timeout can happen just after rename.
    // The token lives inside the exchanged directory, so it identifies the
    // real outcome without running packages from that directory.
    const check = await runInWorkspace(commitStatusScript(target, suffix), { timeoutMs: 15_000 });
    let outcome;
    try { outcome = JSON.parse(check.stdout); } catch (_) { outcome = null; }
    if (check.exitCode === 0 && outcome?.committed === true) return result({ ...transfer, ok: true, code: 'ok' });
    // A transport failure proves neither success nor failure. Preserve the
    // candidate for diagnosis; an unobserved remote commit may still finish.
    keepCandidate = true;
    return result({ ...transfer, code: 'commit_unknown', detail: '' });
  } catch (_) {
    if (commitAttempted) {
      keepCandidate = true;
      return result({ ...(transfer || {}), code: 'commit_unknown', detail: '' });
    }
    return result({ ...(transfer || {}), code: signal?.aborted ? 'aborted' : 'install_failed', detail: '' });
  } finally {
    for (const cleanup of cleanups) {
      try { await cleanup(); } catch (_) { /* never remove or overwrite the active target */ }
    }
  }
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
  validateInstalled,
  parseEnvironmentSnapshot,
  buildEnvironmentSnapshotScript,
  buildInstallScript,
  installerRunArgs,
  extractScript,
  commitScript,
  commitStatusScript,
  rollbackScript,
  pipeProcesses,
  runCommandOnce,
  parseInstallerStderr,
  runSandboxInstall,
};
