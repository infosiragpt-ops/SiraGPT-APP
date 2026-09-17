'use strict';

/**
 * LocalGvisorDesktopProvider — F7.0 STUB that can docker-run `sira-desktop`.
 *
 * Full gVisor (`--runtime runsc`) + `--network none` wait for F7.6 so
 * this phase stays small. F7.0 only needs: build the image, start a
 * container, hit DCP :9000 /health and /screenshot.
 *
 * `create()` talks to a real Docker daemon when one is present. Tests
 * inject `execDocker` to assert argv without a daemon. Missing Docker
 * fails HONESTLY (never a silent fake desktop).
 */

const { spawn } = require('child_process');
const {
  DesktopProvider,
  DesktopProviderError,
  assertImplementsDesktopProvider,
} = require('./DesktopProvider');

const DEFAULT_IMAGE = process.env.SIRAGPT_DESKTOP_IMAGE || 'sira-desktop:latest';
const DEFAULT_DISPLAY = ':0';
const READY_FILE = '/workspace/.desktop_ready';
const DCP_HEALTH = 'http://127.0.0.1:9000/health';
const DCP_SHOT = 'http://127.0.0.1:9000/screenshot';

const HEALTH_PY = [
  'import json,urllib.request',
  `print(urllib.request.urlopen(${JSON.stringify(DCP_HEALTH)}, timeout=5).read().decode())`,
].join(';');

const SHOT_PY = [
  'import urllib.request,sys',
  `sys.stdout.buffer.write(urllib.request.urlopen(${JSON.stringify(DCP_SHOT)}, timeout=15).read())`,
].join(';');

function defaultExecDocker(args, { timeoutMs = 60_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errChunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const err = new DesktopProviderError(`docker ${args[0]} timed out`, {
        code: 'desktop_docker_timeout',
      });
      reject(err);
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(chunks);
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code !== 0) {
        const err = new DesktopProviderError(
          stderr.trim() || `docker ${args[0]} exited ${code}`,
          { code: 'desktop_docker_failed' },
        );
        err.exitCode = code;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({
        stdout: binary ? stdoutBuf : stdoutBuf.toString('utf8'),
        stdoutBuffer: stdoutBuf,
        stderr,
        exitCode: code,
      });
    });
  });
}

function randomName() {
  return `sira-desk-f70-${process.pid}-${Date.now().toString(36)}`;
}

function buildDesktopRunArgs({
  name,
  image = DEFAULT_IMAGE,
} = {}) {
  if (!name) throw new DesktopProviderError('desktop container name is required', {
    code: 'desktop_name_required',
    status: 400,
  });
  // F7.0: no --runtime runsc, no --network none (those are F7.6).
  return ['run', '-d', '--name', name, image];
}

function parseHealthJson(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || '').trim());
  } catch (err) {
    throw new DesktopProviderError(`DCP /health is not JSON: ${String(raw).slice(0, 120)}`, {
      code: 'desktop_health_invalid',
    });
  }
  if (!data || data.status !== 'ok' || !data.display) {
    throw new DesktopProviderError(`DCP /health unexpected: ${JSON.stringify(data)}`, {
      code: 'desktop_health_invalid',
    });
  }
  return { status: 'ok', display: String(data.display) };
}

function sniffMediaType(buf) {
  if (buf && buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf && buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  throw new DesktopProviderError('DCP /screenshot did not return png or webp', {
    code: 'desktop_screenshot_invalid',
  });
}

class LocalGvisorDesktopProvider extends DesktopProvider {
  constructor(opts = {}) {
    super();
    this.kind = 'local-gvisor';
    this.image = opts.image || DEFAULT_IMAGE;
    this.execDocker = opts.execDocker || defaultExecDocker;
    this.readyTimeoutMs = Number(opts.readyTimeoutMs) > 0 ? Number(opts.readyTimeoutMs) : 60_000;
  }

  async create(opts = {}) {
    const name = String(opts.name || randomName()).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
    if (!name) {
      throw new DesktopProviderError('desktop container name is empty after sanitise', {
        code: 'desktop_name_required',
        status: 400,
      });
    }
    const args = buildDesktopRunArgs({ name, image: opts.image || this.image });
    try {
      await this.execDocker(args, { timeoutMs: 120_000 });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || /not found|cannot find/i.test(String(err.message)))) {
        throw new DesktopProviderError(
          'Docker no disponible — LocalGvisorDesktopProvider no finge un escritorio. '
          + 'Instala Docker o espera a F7.1 (E2B).',
          { code: 'desktop_docker_unavailable', status: 503 },
        );
      }
      throw err;
    }
    await this._waitReady(name);
    return {
      id: name,
      containerId: name,
      display: DEFAULT_DISPLAY,
      provider: 'local-gvisor',
    };
  }

  async destroy(handle) {
    const name = handle && (handle.containerId || handle.id);
    if (!name) return;
    try {
      await this.execDocker(['rm', '-f', String(name)], { timeoutMs: 30_000 });
    } catch (err) {
      if (/no such container/i.test(String(err.message || ''))) return;
      throw err;
    }
  }

  async health(handle) {
    const name = handle && (handle.containerId || handle.id);
    if (!name) {
      throw new DesktopProviderError('health() needs a desktop handle', {
        code: 'desktop_handle_required',
        status: 400,
      });
    }
    const out = await this.execDocker(
      ['exec', String(name), 'python3', '-c', HEALTH_PY],
      { timeoutMs: 20_000 },
    );
    return parseHealthJson(out.stdout);
  }

  async screenshot(handle) {
    const name = handle && (handle.containerId || handle.id);
    if (!name) {
      throw new DesktopProviderError('screenshot() needs a desktop handle', {
        code: 'desktop_handle_required',
        status: 400,
      });
    }
    const out = await this.execDocker(
      ['exec', String(name), 'python3', '-c', SHOT_PY],
      { timeoutMs: 30_000, binary: true },
    );
    const bytes = out.stdoutBuffer || Buffer.from(out.stdout || '');
    const mediaType = sniffMediaType(bytes);
    return { bytes, mediaType };
  }

  async _waitReady(name) {
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const probe = await this.execDocker(
          ['exec', name, 'test', '-f', READY_FILE],
          { timeoutMs: 10_000 },
        );
        if (probe.exitCode === 0 || probe.stdout != null) {
          return;
        }
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new DesktopProviderError(
      `sira-desktop never wrote ${READY_FILE}`
      + (lastErr ? ` (${lastErr.message})` : ''),
      { code: 'desktop_not_ready' },
    );
  }
}

assertImplementsDesktopProvider(LocalGvisorDesktopProvider.prototype);

module.exports = {
  LocalGvisorDesktopProvider,
  buildDesktopRunArgs,
  parseHealthJson,
  sniffMediaType,
  DEFAULT_IMAGE,
  READY_FILE,
};
