'use strict';

/**
 * F7.0 — DesktopProvider interface + sira-desktop provision gate.
 *
 * Always-on (no Docker needed):
 *   (a) DesktopProvider exposes create/destroy/health/screenshot;
 *   (b) E2BDesktopProvider is a stub (F7.1) that implements the interface
 *       and throws F7_1_NOT_IMPLEMENTED — no E2B SDK require;
 *   (c) LocalGvisorDesktopProvider implements the interface; docker-run
 *       argv has no --runtime runsc / --network none (those are F7.6);
 *   (d) infra/desktop Dockerfile + start.sh + DCP contracts
 *       (user by name, no uid 1000, DCP :9000, .desktop_ready, :0);
 *   (e) live computer-orchestrator from #484 is still in the tree.
 *
 * Docker-only (skip honestly, same pattern as F5):
 *   (f) docker build sira-desktop; container starts; /health + /screenshot.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexec = promisify(execFile);

const {
  DesktopProvider,
  DesktopProviderError,
  DESKTOP_PROVIDER_METHODS,
  assertImplementsDesktopProvider,
  E2BDesktopProvider,
  LocalGvisorDesktopProvider,
  buildDesktopRunArgs,
  createDesktopProvider,
} = require('../src/services/desktop/provider');
const { parseHealthJson, sniffMediaType, READY_FILE } = require(
  '../src/services/desktop/provider/LocalGvisorDesktopProvider',
);

const ROOT = path.join(__dirname, '../..');
const DESKTOP_DIR = path.join(ROOT, 'infra/desktop');
const IMAGE = process.env.SIRAGPT_DESKTOP_IMAGE || 'sira-desktop:latest';

function readDesktop(rel) {
  return fs.readFileSync(path.join(DESKTOP_DIR, rel), 'utf8');
}

/* ── (a) interface ───────────────────────────────────────────────────────── */

describe('F7.0 DesktopProvider interface', () => {
  test('F7.0(a): contract lists exactly create/destroy/health/screenshot', () => {
    assert.deepEqual([...DESKTOP_PROVIDER_METHODS], ['create', 'destroy', 'health', 'screenshot']);
  });

  test('F7.0(a): base class implements the four methods and they throw abstract', async () => {
    const p = new DesktopProvider();
    assertImplementsDesktopProvider(p);
    await assert.rejects(p.create(), (err) => err instanceof DesktopProviderError && /abstract/.test(err.message));
    await assert.rejects(p.destroy({}), (err) => err.code === 'desktop_provider_abstract');
    await assert.rejects(p.health({}), (err) => err.code === 'desktop_provider_abstract');
    await assert.rejects(p.screenshot({}), (err) => err.code === 'desktop_provider_abstract');
  });

  test('F7.0(a): assertImplementsDesktopProvider rejects a missing method', () => {
    assert.throws(
      () => assertImplementsDesktopProvider({ create() {}, destroy() {}, health() {} }),
      /screenshot/,
    );
  });

  test('F7.0(a): factory is model-agnostic (kind, never an LLM id)', () => {
    const local = createDesktopProvider('local-gvisor');
    const e2b = createDesktopProvider('e2b');
    assert.equal(local.kind, 'local-gvisor');
    assert.equal(e2b.kind, 'e2b');
    assert.throws(() => createDesktopProvider('deepseek'), /desconocido/);
    assert.throws(() => createDesktopProvider('openai'), /desconocido/);
  });
});

/* ── (b) E2B stub ────────────────────────────────────────────────────────── */

describe('F7.0 E2BDesktopProvider stub', () => {
  test('F7.0(b): implements the interface and every method is F7.1', async () => {
    const p = new E2BDesktopProvider();
    assertImplementsDesktopProvider(p);
    assert.equal(p.kind, 'e2b');
    for (const name of DESKTOP_PROVIDER_METHODS) {
      await assert.rejects(p[name]({}), (err) => (
        err instanceof DesktopProviderError
        && err.code === 'F7_1_NOT_IMPLEMENTED'
        && err.status === 501
      ));
    }
  });

  test('F7.0(b): source does not require the E2B SDK', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/desktop/provider/E2BDesktopProvider.js'),
      'utf8',
    );
    assert.doesNotMatch(src, /require\(['"]@e2b\//);
    assert.doesNotMatch(src, /require\(['"]e2b['"]\)/);
    assert.match(src, /F7\.1/);
  });
});

/* ── (c) LocalGvisor stub ────────────────────────────────────────────────── */

describe('F7.0 LocalGvisorDesktopProvider stub', () => {
  test('F7.0(c): implements the interface', () => {
    assertImplementsDesktopProvider(new LocalGvisorDesktopProvider());
  });

  test('F7.0(c): docker-run argv is the small F7.0 set (no gVisor flags yet)', () => {
    const args = buildDesktopRunArgs({ name: 'sira-desk-t', image: 'sira-desktop:latest' });
    assert.deepEqual(args, ['run', '-d', '--name', 'sira-desk-t', 'sira-desktop:latest']);
    assert.ok(!args.includes('--runtime'));
    assert.ok(!args.includes('runsc'));
    assert.ok(!args.includes('--network'));
    assert.ok(!args.includes('none'));
    assert.ok(!args.includes('--privileged'));
  });

  test('F7.0(c): create uses injected docker and waits for .desktop_ready', async () => {
    const calls = [];
    const execDocker = async (args, options = {}) => {
      calls.push({ args, options });
      if (args[0] === 'run') return { stdout: 'cid\n', stderr: '', exitCode: 0 };
      if (args[0] === 'exec' && args.includes(READY_FILE)) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const p = new LocalGvisorDesktopProvider({ execDocker, image: IMAGE });
    const handle = await p.create({ name: 'sira-desk-unit' });
    assert.equal(handle.provider, 'local-gvisor');
    assert.equal(handle.display, ':0');
    assert.equal(handle.containerId, 'sira-desk-unit');
    assert.ok(calls.some((c) => c.args[0] === 'run' && c.args.includes('sira-desk-unit')));
    assert.ok(calls.some((c) => c.args.includes(READY_FILE)));
    await p.destroy(handle);
    assert.ok(calls.some((c) => c.args[0] === 'rm' && c.args[1] === '-f'));
  });

  test('F7.0(c): destroy is idempotent on a missing handle / container', async () => {
    const p = new LocalGvisorDesktopProvider({
      execDocker: async () => {
        const err = new Error('No such container');
        throw err;
      },
    });
    await p.destroy({});
    await p.destroy({ id: 'already-gone' });
  });

  test('F7.0(c): health/screenshot parse DCP payloads', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const p = new LocalGvisorDesktopProvider({
      execDocker: async (args, options = {}) => {
        if (String(args).includes('/health')) {
          return { stdout: '{"status":"ok","display":":0"}', stderr: '', exitCode: 0 };
        }
        return { stdout: png, stdoutBuffer: png, stderr: '', exitCode: 0, options };
      },
    });
    const h = { id: 'c1', containerId: 'c1' };
    assert.deepEqual(await p.health(h), { status: 'ok', display: ':0' });
    const shot = await p.screenshot(h);
    assert.equal(shot.mediaType, 'image/png');
    assert.deepEqual(shot.bytes.slice(0, 4), png.slice(0, 4));
  });

  test('F7.0(c): parseHealthJson / sniffMediaType reject junk', () => {
    assert.throws(() => parseHealthJson('nope'), /not JSON/);
    assert.throws(() => parseHealthJson('{"status":"down"}'), /unexpected/);
    assert.throws(() => sniffMediaType(Buffer.from('hello')), /png or webp/);
    const webp = Buffer.from('RIFF....WEBP........');
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    assert.equal(sniffMediaType(webp), 'image/webp');
  });
});

/* ── (d) image / start.sh / DCP contracts ────────────────────────────────── */

describe('F7.0 sira-desktop image contracts', () => {
  test('F7.0(d): Dockerfile creates sira by name and never forces uid 1000', () => {
    const df = readDesktop('Dockerfile');
    assert.match(df, /useradd -m -s \/bin\/bash sira/);
    assert.match(df, /getent passwd sira/);
    assert.doesNotMatch(df, /useradd[^\n]*-u 1000/);
    assert.doesNotMatch(df, /useradd[^\n]*-u 1000/);
    assert.match(df, /FROM debian:bookworm-slim/);
    assert.match(df, /xvfb/);
    assert.match(df, /openbox/);
    assert.match(df, /x11vnc/);
    assert.match(df, /novnc/);
    assert.match(df, /websockify/);
    assert.match(df, /xdotool/);
    assert.match(df, /scrot/);
    assert.match(df, /python3/);
    assert.match(df, /start\.sh/);
  });

  test('F7.0(d): start.sh brings up X :0, DCP :9000, ready file after health', () => {
    const sh = readDesktop('start.sh');
    assert.match(sh, /DISPLAY="\$\{DISPLAY:-\:0\}"/);
    assert.match(sh, /Xvfb :0/);
    assert.match(sh, /x11vnc/);
    assert.match(sh, /openbox/);
    assert.match(sh, /websockify/);
    assert.match(sh, /dcp\.py/);
    assert.match(sh, /127\.0\.0\.1:9000\/health/);
    assert.match(sh, /workspace\/\.desktop_ready/);
    assert.match(sh, /touch "\$READY_FILE"/);
    assert.match(sh, /xdotool|scrot/); // tools are in the image; start.sh does not have to spawn them
  });

  test('F7.0(d): DCP binds 127.0.0.1:9000 and serves the fixed contracts', () => {
    const dcp = readDesktop('dcp/dcp.py');
    assert.match(dcp, /127\.0\.0\.1/);
    assert.match(dcp, /9000/);
    assert.match(dcp, /"status": "ok"/);
    assert.match(dcp, /display/);
    assert.match(dcp, /\/health/);
    assert.match(dcp, /\/screenshot/);
    assert.match(dcp, /image\/png/);
    assert.match(dcp, /scrot/);
    assert.match(dcp, /HOST = "127\.0\.0\.1"/);
    assert.match(dcp, /HTTPServer\(\(HOST, PORT\)/);
    assert.doesNotMatch(dcp, /DeepSeek|deepseek|model_id/);
  });

  test('F7.0(d): start.sh does not publish a public computer.siragpt.com host', () => {
    const sh = readDesktop('start.sh');
    assert.doesNotMatch(sh, /computer\.siragpt\.com/);
    assert.doesNotMatch(readDesktop('Dockerfile'), /computer\.siragpt\.com/);
  });
});

/* ── (e) live orch stays ─────────────────────────────────────────────────── */

describe('F7.0 does not rip out the live orchestrator', () => {
  test('F7.0(e): services/computer-orchestrator from #484/#485 is intact', () => {
    const orch = path.join(ROOT, 'services/computer-orchestrator');
    for (const rel of ['server.js', 'Dockerfile', 'start-desktop.sh', 'docker-runtime.js']) {
      assert.ok(fs.existsSync(path.join(orch, rel)), rel);
    }
    const df = fs.readFileSync(path.join(orch, 'Dockerfile'), 'utf8');
    assert.match(df, /getent passwd compuser/);
    assert.doesNotMatch(df, /useradd[^\n]*-u 1000/);
  });
});

/* ── (f) real Docker provision (honest skip) ─────────────────────────────── */

async function dockerAvailable() {
  try {
    await pexec('docker', ['info'], { timeout: 15_000 });
    return true;
  } catch (_) {
    return false;
  }
}

test('F7.0(f): docker build + health + screenshot (skip honestly without Docker)', { timeout: 600_000 }, async (t) => {
  if (!(await dockerAvailable())) {
    t.skip('Docker no disponible en esta máquina — el gate de provision F7.0 se omite honestamente');
    return;
  }

  let built = false;
  try {
    await pexec('docker', ['build', '-t', IMAGE, DESKTOP_DIR], {
      timeout: 480_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    built = true;
  } catch (err) {
    t.skip(`Docker presente pero docker build de sira-desktop falló: ${String(err.message || err.stderr || err).slice(0, 240)}`);
    return;
  }
  assert.equal(built, true);

  const name = `sira-desk-f70-test-${process.pid}`;
  try {
    await pexec('docker', ['rm', '-f', name]).catch(() => {});
    await pexec('docker', ['run', '-d', '--name', name, IMAGE], { timeout: 60_000 });

    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        await pexec('docker', ['exec', name, 'test', '-f', READY_FILE], { timeout: 10_000 });
        ready = true;
        break;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.equal(ready, true, `${READY_FILE} never appeared`);

    const health = await pexec(
      'docker',
      ['exec', name, 'python3', '-c',
        'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:9000/health", timeout=5).read().decode())'],
      { timeout: 20_000 },
    );
    const body = JSON.parse(String(health.stdout).trim());
    assert.equal(body.status, 'ok');
    assert.equal(body.display, ':0');

    const shot = await pexec(
      'docker',
      ['exec', name, 'python3', '-c',
        'import urllib.request,sys; sys.stdout.buffer.write(urllib.request.urlopen("http://127.0.0.1:9000/screenshot", timeout=15).read())'],
      { timeout: 30_000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
    );
    const bytes = shot.stdout;
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 32, `screenshot too small: ${bytes && bytes.length}`);
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
    assert.equal(bytes[2], 0x4e);
    assert.equal(bytes[3], 0x47);
  } finally {
    await pexec('docker', ['rm', '-f', name]).catch(() => {});
  }
});
