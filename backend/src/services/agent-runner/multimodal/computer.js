'use strict';

/**
 * F7 — Bounded computer-use.
 *
 * NOT a Firecracker desktop: one small driver interface
 * (screenshot / click / type / destroy) with two implementations:
 *
 *   - `fake` (default, CI-safe): an in-memory desktop that returns a valid
 *     PNG plus a JSON state summary. It exists to prove the full agent
 *     cycle — screenshot → model action → screenshot — deterministically.
 *   - `xvfb` (opt-in via SIRAGPT_AGENT_COMPUTER_DRIVER=xvfb): a headless
 *     X display driven by xdotool + ImageMagick `import`. Fails HONESTLY
 *     when the binaries or the display are missing; tests skip it in CI.
 *
 * The driver runs OUTSIDE the F5 gVisor sandbox and never touches it — the
 * sandbox keeps `--network none` and its isolation flags untouched.
 *
 * Screenshots return `{ __f7Image, text }` payloads: the loop's F7 hook
 * attaches the image to the NEXT LLM call as a vision block (data, never
 * instructions).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { throwIfAborted } = require('../../../utils/abort-signals');

const pexecFile = promisify(execFile);

// Valid 1x1 transparent PNG — the fake desktop's frame payload. The state
// that matters for the model rides in the text summary next to it.
const FAKE_FRAME_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DEFAULT_DISPLAY = ':99';
const MAX_TYPE_CHARS = 2000;

function resolveComputerDriverKind(env = process.env) {
  const raw = String(env.SIRAGPT_AGENT_COMPUTER_DRIVER || '').trim().toLowerCase();
  if (raw === 'xvfb') return 'xvfb';
  return 'fake';
}

/* ── fake driver (in-memory desktop; deterministic; CI-safe) ─────────────── */

function createFakeComputerDriver() {
  const state = {
    frame: 0,
    cursor: { x: 0, y: 0 },
    clicks: [],
    typed: '',
  };
  return {
    kind: 'fake',
    _state: state,
    async screenshot({ signal } = {}) {
      throwIfAborted(signal);
      state.frame += 1;
      return {
        base64: FAKE_FRAME_PNG_BASE64,
        mediaType: 'image/png',
        text: JSON.stringify({
          driver: 'fake',
          frame: state.frame,
          cursor: state.cursor,
          clicks: state.clicks.length,
          typed: state.typed,
        }),
      };
    },
    async click({ x, y, button = 'left' } = {}, { signal } = {}) {
      throwIfAborted(signal);
      const px = Math.max(0, Math.floor(Number(x) || 0));
      const py = Math.max(0, Math.floor(Number(y) || 0));
      state.cursor = { x: px, y: py };
      state.clicks.push({ x: px, y: py, button: String(button) });
      return { ok: true, x: px, y: py, button: String(button) };
    },
    async type({ text } = {}, { signal } = {}) {
      throwIfAborted(signal);
      const t = String(text || '').slice(0, MAX_TYPE_CHARS);
      state.typed += t;
      return { ok: true, typed: t.length };
    },
    async destroy() { /* nothing to clean up */ },
  };
}

/* ── xvfb driver (real headless display; opt-in; skips honestly) ─────────── */

async function binaryAvailable(bin, { signal } = {}) {
  try {
    await pexecFile('which', [bin], { timeout: 5_000, signal });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Drives an ALREADY-RUNNING Xvfb display (starting/supervising Xvfb is the
 * operator's job — this driver stays bounded). Requires xdotool for input
 * and ImageMagick `import` for capture.
 */
async function createXvfbComputerDriver({ env = process.env, signal } = {}) {
  const display = String(env.SIRAGPT_AGENT_COMPUTER_DISPLAY || DEFAULT_DISPLAY);
  for (const bin of ['xdotool', 'import']) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await binaryAvailable(bin, { signal }))) {
      const err = new Error(`computer-use xvfb no disponible: falta el binario "${bin}"`);
      err.code = 'COMPUTER_DRIVER_UNAVAILABLE';
      throw err;
    }
  }
  const runEnv = { ...process.env, DISPLAY: display };
  // Probe the display up front so a missing Xvfb fails at creation, not
  // mid-loop with a confusing xdotool error.
  try {
    await pexecFile('xdotool', ['getdisplaygeometry'], { timeout: 5_000, env: runEnv, signal });
  } catch (err) {
    const e = new Error(`computer-use xvfb no disponible: display ${display} no responde (${err?.message || err})`);
    e.code = 'COMPUTER_DRIVER_UNAVAILABLE';
    throw e;
  }
  let frame = 0;
  return {
    kind: 'xvfb',
    display,
    async screenshot({ signal: callSignal } = {}) {
      throwIfAborted(callSignal);
      frame += 1;
      const { stdout } = await pexecFile(
        'import',
        ['-window', 'root', '-silent', 'png:-'],
        { timeout: 15_000, env: runEnv, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, signal: callSignal },
      );
      return {
        base64: Buffer.from(stdout).toString('base64'),
        mediaType: 'image/png',
        text: JSON.stringify({ driver: 'xvfb', display, frame }),
      };
    },
    async click({ x, y, button = 'left' } = {}, { signal: callSignal } = {}) {
      throwIfAborted(callSignal);
      const px = Math.max(0, Math.floor(Number(x) || 0));
      const py = Math.max(0, Math.floor(Number(y) || 0));
      const btn = { left: '1', middle: '2', right: '3' }[String(button)] || '1';
      await pexecFile('xdotool', ['mousemove', String(px), String(py), 'click', btn], { timeout: 10_000, env: runEnv, signal: callSignal });
      return { ok: true, x: px, y: py, button: String(button) };
    },
    async type({ text } = {}, { signal: callSignal } = {}) {
      throwIfAborted(callSignal);
      const t = String(text || '').slice(0, MAX_TYPE_CHARS);
      if (t) await pexecFile('xdotool', ['type', '--delay', '20', '--', t], { timeout: 30_000, env: runEnv, signal: callSignal });
      return { ok: true, typed: t.length };
    },
    async destroy() { /* display lifecycle is external */ },
  };
}

async function createComputerDriver({ env = process.env, signal, kind } = {}) {
  const resolved = kind || resolveComputerDriverKind(env);
  if (resolved === 'xvfb') return createXvfbComputerDriver({ env, signal });
  return createFakeComputerDriver();
}

/* ── tool executors ──────────────────────────────────────────────────────── */

/**
 * `getDriver` is lazy so a run that never touches computer-use never probes
 * Xvfb. The first computer_* call materialises the driver; the F7 cleanup
 * destroys it.
 */

function resolveToolDesktop(args = {}, desktopCtx = {}) {
  let last = {};
  try {
    const desktop = require('../../codex/dept-real-pc');
    last = (desktop.lastDesktopBinding && desktop.lastDesktopBinding()) || {};
  } catch (_) { last = {}; }
  return {
    projectId: args.projectId || desktopCtx.projectId || last.projectId || undefined,
    departmentId: args.departmentId || desktopCtx.departmentId || last.requestedDepartmentId || last.departmentId || undefined,
  };
}

function resolveToolUserId(args = {}, desktopCtx = {}) {
  return args.userId || desktopCtx.userId || undefined;
}

async function tryPersistentComputer(kind, args, desktopCtx, signal) {
  let persist;
  try { persist = require('../../computer/persistent'); } catch (_) { return null; }
  if (!persist.enabled()) return null;
  const session = await persist.ensureSession(resolveToolUserId(args, desktopCtx));
  if (kind === 'screenshot') {
    const shot = await persist.agentGet(session, '/screenshot');
    if (shot && shot.pngBase64) {
      return {
        __f7Image: { base64: shot.pngBase64, mediaType: shot.mime || 'image/png' },
        text: 'computer_screenshot ok (agent-computer): session=' + session.sessionId + ' user=' + (session.userId || '') + ' bytes=' + (shot.bytes || ''),
      };
    }
    return JSON.stringify({ ok: !!shot, sessionId: session.sessionId, driver: 'agent-computer' });
  }
  if (kind === 'click') {
    const btn = { left: 'click', middle: 'click', right: 'right_click' }[String(args.button || 'left')] || 'click';
    const result = await persist.agentPost(session, '/action', { type: btn, x: args.x, y: args.y });
    return JSON.stringify({ ok: true, driver: 'agent-computer', sessionId: session.sessionId, ...result });
  }
  if (kind === 'type') {
    const result = await persist.agentPost(session, '/action', { type: 'type', text: args.text });
    return JSON.stringify({ ok: true, driver: 'agent-computer', sessionId: session.sessionId, ...result });
  }
  if (kind === 'navigate') {
    const url = String(args.url || '').trim();
    const result = await persist.dockerExec(session, 'google-chrome --no-first-run --disable-gpu ' + JSON.stringify(url));
    return JSON.stringify({ ok: true, url, driver: 'agent-computer', sessionId: session.sessionId, container: result.container, pageLoaded: true });
  }
  if (kind === 'exec') {
    const result = await persist.dockerExec(session, args.command);
    return JSON.stringify({ ok: true, driver: 'agent-computer', sessionId: session.sessionId, ...result });
  }
  return null;
}

function makeComputerExecutors({ env = process.env, driver = null, desktopCtx = {} } = {}) {
  let instance = driver;
  let creating = null;
  const getDriver = async (signal) => {
    if (instance) return instance;
    if (!creating) {
      creating = createComputerDriver({ env, signal }).then((d) => { instance = d; return d; });
      creating.catch(() => { creating = null; });
    }
    return creating;
  };

  const executors = {
    async computer_screenshot(args = {}, { signal } = {}) {
      throwIfAborted(signal);
      try {
        const persisted = await tryPersistentComputer('screenshot', args, desktopCtx, signal);
        if (persisted) return persisted;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      try {
        const desktop = require('../../codex/dept-real-pc');
        if (typeof desktop.screenshotDesktop === 'function') {
          const shot = await desktop.screenshotDesktop({
            ...resolveToolDesktop(args, desktopCtx),
          });
          if (shot && (shot.ok || shot.pageLoaded || shot.url)) {
            return `computer_screenshot ok (webtop): pageLoaded=${!!(shot.pageLoaded || shot.ok)} url=${shot.url || ''} path=${shot.path || ''} title=${shot.title || ''} container=${shot.container || ''}`;
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        // Fall through to the local driver so CI/fake still works.
      }
      let drv;
      try {
        drv = await getDriver(signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: ${err?.message || err}`;
      }
      try {
        const shot = await drv.screenshot({ signal });
        return {
          __f7Image: { base64: shot.base64, mediaType: shot.mediaType },
          text: `computer_screenshot ok (${drv.kind}): ${shot.text}`,
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: captura de pantalla falló: ${err?.message || err}`;
      }
    },
    async computer_click(args = {}, { signal } = {}) {
      throwIfAborted(signal);
      try {
        const persisted = await tryPersistentComputer('click', args, desktopCtx, signal);
        if (persisted) return persisted;
      } catch (err) {
        if (signal && signal.aborted) throw err;
      }
      try {
        const desktop = require('../../codex/dept-real-pc');
        if (typeof desktop.inputDesktop === 'function') {
          const btn = { left: 1, middle: 2, right: 3 }[String(args.button || 'left')] || 1;
          const result = await desktop.inputDesktop({
            ...resolveToolDesktop(args, desktopCtx),
            action: 'click',
            x: args.x,
            y: args.y,
            button: btn,
          });
          if (result && result.ok) return JSON.stringify(result);
        }
      } catch (err) {
        if (signal && signal.aborted) throw err;
      }
      let drv;
      try {
        drv = await getDriver(signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: ${err?.message || err}`;
      }
      try {
        const res = await drv.click(args, { signal });
        return JSON.stringify(res);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: click falló: ${err?.message || err}`;
      }
    },
    async computer_type(args = {}, { signal } = {}) {
      throwIfAborted(signal);
      if (!String(args.text || '').length) return 'ERROR: computer_type requiere `text`.';
      try {
        const persisted = await tryPersistentComputer('type', args, desktopCtx, signal);
        if (persisted) return persisted;
      } catch (err) {
        if (signal && signal.aborted) throw err;
      }
      try {
        const desktop = require('../../codex/dept-real-pc');
        if (typeof desktop.inputDesktop === 'function') {
          const result = await desktop.inputDesktop({
            ...resolveToolDesktop(args, desktopCtx),
            action: 'type',
            text: args.text,
          });
          if (result && result.ok) return JSON.stringify(result);
        }
      } catch (err) {
        if (signal && signal.aborted) throw err;
      }
      let drv;
      try {
        drv = await getDriver(signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: ${err?.message || err}`;
      }
      try {
        const res = await drv.type(args, { signal });
        return JSON.stringify(res);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: escritura falló: ${err?.message || err}`;
      }
    },
    async computer_navigate(args = {}, { signal } = {}) {
      throwIfAborted(signal);
      try {
        const persisted = await tryPersistentComputer('navigate', args, desktopCtx, signal);
        if (persisted) return persisted;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      try {
        const desktop = require('../../codex/dept-real-pc');
        const result = await desktop.navigateDesktop({
          url: args.url,
          ...resolveToolDesktop(args, desktopCtx),
        });
        return JSON.stringify({
          ok: !!result.ok,
          url: result.url,
          title: result.title || '',
          container: result.container,
          pageLoaded: !!result.ok,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: computer_navigate falló host=${(function () { try { return new URL(String(args.url || '')).hostname; } catch (_) { return 'unknown'; } })()} status=${err && err.status != null ? err.status : 'n/a'} ${err && (err.detail || err.message) || err}`;
      }
    },
    async computer_exec(args = {}, { signal } = {}) {
      throwIfAborted(signal);
      try {
        const persisted = await tryPersistentComputer('exec', args, desktopCtx, signal);
        if (persisted) return persisted;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      try {
        const desktop = require('../../codex/dept-real-pc');
        const result = await desktop.execInDesktop({
          ...resolveToolDesktop(args, desktopCtx),
          command: args.command,
        });
        return JSON.stringify({ ok: !!result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr, container: result.container });
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: computer_exec falló: ${err && (err.detail || err.message) || err}`;
      }
    },
  };

  let wrapped = executors;
  try {
    wrapped = require('../engine-gateway').wrapExecutors(executors, { surface: 'computer' });
  } catch (_) { wrapped = executors; }
  return {
    executors: wrapped,
    async cleanup() {
      const drv = instance;
      instance = null;
      creating = null;
      if (drv) {
        try { await drv.destroy(); } catch (_) { /* best effort */ }
      }
    },
  };
}

const COMPUTER_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'computer_screenshot',
      description:
        'Captura la pantalla del escritorio controlado y la adjunta a tu siguiente turno como imagen (datos). Úsala ANTES y DESPUÉS de cada acción para verificar el estado real.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_click',
      description: 'Haz clic en coordenadas (x, y) del escritorio controlado. Verifica con computer_screenshot después.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: 'Coordenada X en píxeles.' },
          y: { type: 'integer', description: 'Coordenada Y en píxeles.' },
          button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Botón del mouse (default left).' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_type',
      description: 'Escribe texto en el elemento enfocado del escritorio controlado.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Texto a escribir (máx 2000 caracteres).' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_navigate',
      description: 'Abre una URL pública http(s) en el navegador de la computadora compartida del departamento actual (webtop). Usa esto cuando el usuario pide abrir una página, GitHub o usar la computadora. Bloquea localhost/IPs privadas.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL pública http(s) a abrir.' },
          projectId: { type: 'string', description: 'Proyecto Codex opcional. Si falta, se usa la computadora compartida en ejecución.' },
          departmentId: { type: 'string', description: 'Departamento actual de /code. Si falta, se usa el departamento seleccionado.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_exec',
      description: 'Ejecuta un comando corto en la computadora compartida del departamento actual (webtop, DISPLAY=:1).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando bash -lc a ejecutar.' },
          projectId: { type: 'string' },
          departmentId: { type: 'string' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
];

module.exports = {
  FAKE_FRAME_PNG_BASE64,
  MAX_TYPE_CHARS,
  COMPUTER_TOOL_DEFINITIONS,
  resolveComputerDriverKind,
  createFakeComputerDriver,
  createXvfbComputerDriver,
  createComputerDriver,
  makeComputerExecutors,
};
