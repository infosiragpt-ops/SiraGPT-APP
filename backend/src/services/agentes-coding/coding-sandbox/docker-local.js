'use strict';

/**
 * Docker-compose-friendly DEV driver.
 *
 * Reuses the Lenovo / doc-sandbox argv shape (network none, memory/cpu/pids,
 * no-new-privileges, non-root, no docker.sock) with an injectable `docker.exec`.
 * Not a Kubernetes OpenSandbox deploy. Not F7 / computer-use.
 */

const { spawn } = require('node:child_process');
const { fail, CodingSandboxError } = require('./errors');
const { dockerLimitArgs, resolveExecTimeout } = require('./limits');
const { jailRelPath, workspaceAbs } = require('./path-jail');

const DEFAULT_IMAGE = 'siragpt-coding-sandbox:dev';

function defaultDockerExec(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      const error = new CodingSandboxError('E_TIMEOUT');
      reject(error);
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code == null ? 1 : code,
      });
    });
  });
}

function sanitizeName(id) {
  return `sira-csb-${String(id).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48)}`;
}

function buildDockerRunArgs({ name, image, limits, networkArgs }) {
  return [
    'run', '-d', '--rm',
    '--name', name,
    ...networkArgs,
    ...dockerLimitArgs(limits),
    image,
    'sleep', 'infinity',
  ];
}

function assertSafeDockerArgs(args) {
  const joined = args.join(' ');
  if (/docker\.sock|DOCKER_HOST|\/var\/run\/docker/i.test(joined)) {
    fail('E_NETWORK_DENIED', 'Prohibido montar el socket de Docker.');
  }
  if (args.includes('--privileged') || args.includes('--pid=host') || args.includes('--net=host')) {
    fail('E_NETWORK_DENIED', 'Flags de Docker inseguros.');
  }
}

function mapDockerError(err) {
  if (err instanceof CodingSandboxError) throw err;
  const code = err && err.code;
  const msg = String(err && err.message || err || '');
  if (code === 'ENOENT' || /not found|cannot find|no such file/i.test(msg)) {
    fail('E_PROVIDER');
  }
  fail('E_PROVIDER', msg.slice(0, 180));
}

function createDockerLocalDriver(opts = {}) {
  const execDocker = opts.docker && typeof opts.docker.exec === 'function'
    ? opts.docker.exec.bind(opts.docker)
    : defaultDockerExec;
  const image = String(opts.image || DEFAULT_IMAGE).trim() || DEFAULT_IMAGE;

  async function callDocker(args, callOpts) {
    assertSafeDockerArgs(args);
    try {
      return await execDocker(args, callOpts);
    } catch (err) {
      mapDockerError(err);
    }
  }

  return {
    kind: 'docker',
    image,
    buildDockerRunArgs,
    assertSafeDockerArgs,

    async createSession(session) {
      const name = sanitizeName(session.id);
      const networkArgs = session.network.dockerNetworkArgs();
      const args = buildDockerRunArgs({
        name,
        image: session.image || image,
        limits: session.limits,
        networkArgs,
      });
      assertSafeDockerArgs(args);
      const run = await callDocker(args, { timeoutMs: 30_000 });
      if (run.exitCode !== 0) {
        fail('E_PROVIDER', (run.stderr || run.stdout || '').trim().slice(0, 180));
      }
      session.containerName = name;
      session.dockerRunArgs = args;
      return session;
    },

    async exec(session, command, opts = {}) {
      if (!session.containerName) fail('E_PROVIDER', 'La sesión no tiene contenedor.');
      const cmd = String(command || '').trim();
      if (!cmd) fail('E_PARAMS', 'Falta el comando.');
      const timeoutMs = resolveExecTimeout(opts.timeoutMs, session.limits);
      const cwd = opts.cwd ? jailRelPath(opts.cwd, { forList: true }) : '.';
      const workdir = cwd === '.' ? '/workspace' : workspaceAbs(cwd);
      const args = [
        'exec',
        '-w', workdir,
        '-u', '10001:10001',
        session.containerName,
        'sh', '-c',
        cmd,
      ];
      const started = Date.now();
      let run;
      try {
        run = await execDocker(args, { timeoutMs: timeoutMs + 1_000 });
      } catch (err) {
        if (err instanceof CodingSandboxError && err.code === 'E_TIMEOUT') {
          return {
            ok: false,
            exitCode: 124,
            stdout: '',
            stderr: err.message,
            timedOut: true,
            durationMs: Date.now() - started,
          };
        }
        mapDockerError(err);
      }
      return {
        ok: run.exitCode === 0,
        exitCode: run.exitCode,
        stdout: String(run.stdout || ''),
        stderr: String(run.stderr || ''),
        timedOut: false,
        durationMs: Date.now() - started,
      };
    },

    async readFile(session, relPath) {
      const abs = workspaceAbs(relPath);
      const run = await callDocker(
        ['exec', '-u', '10001:10001', session.containerName, 'sh', '-c', `cat -- ${JSON.stringify(abs)}`],
        { timeoutMs: 15_000 },
      );
      if (run.exitCode !== 0) fail('E_PARAMS', (run.stderr || 'No se pudo leer el archivo.').slice(0, 160));
      return Buffer.from(String(run.stdout || ''), 'utf8');
    },

    async writeFile(session, relPath, content) {
      const rel = jailRelPath(relPath);
      const abs = workspaceAbs(rel);
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      if (buf.length > session.limits.maxFileBytes) fail('E_QUOTA', 'El archivo supera el tope.');
      const b64 = buf.toString('base64');
      const dir = abs.includes('/') ? abs.slice(0, abs.lastIndexOf('/')) : '/workspace';
      const script = `mkdir -p ${JSON.stringify(dir)} && printf '%s' ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(abs)}`;
      const run = await callDocker(
        ['exec', '-u', '10001:10001', session.containerName, 'sh', '-c', script],
        { timeoutMs: 20_000 },
      );
      if (run.exitCode !== 0) fail('E_PROVIDER', (run.stderr || '').slice(0, 160));
      return { path: rel, bytes: buf.length };
    },

    async listFiles(session, relDir = '.') {
      const rel = jailRelPath(relDir, { forList: true });
      const abs = rel === '.' ? '/workspace' : workspaceAbs(rel);
      const run = await callDocker(
        ['exec', '-u', '10001:10001', session.containerName, 'sh', '-c',
          `find ${JSON.stringify(abs)} -type f -printf '%s %p\\n' 2>/dev/null | head -500`],
        { timeoutMs: 15_000 },
      );
      if (run.exitCode !== 0) return [];
      return String(run.stdout || '').split('\n').filter(Boolean).map((line) => {
        const i = line.indexOf(' ');
        const full = i >= 0 ? line.slice(i + 1) : line;
        const size = i >= 0 ? Number(line.slice(0, i)) || 0 : 0;
        const path = full.replace(/^\/workspace\/?/, '') || full;
        return { path, size };
      });
    },

    async destroy(session) {
      if (!session.containerName) return;
      try {
        await execDocker(['rm', '-f', session.containerName], { timeoutMs: 15_000 });
      } catch (err) {
        if (/no such container/i.test(String(err && err.message || ''))) return;
        if (err && err.code === 'ENOENT') return;
      }
    },
  };
}

module.exports = {
  DEFAULT_IMAGE,
  createDockerLocalDriver,
  buildDockerRunArgs,
  sanitizeName,
  assertSafeDockerArgs,
  defaultDockerExec,
};
