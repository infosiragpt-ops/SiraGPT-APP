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
const { clampComputerPoint, normalizeComputerButton, throwIfComputerActionAborted } = require('../../computer-use-action-mapper');
const {
  applyRefuseComputerToolsClosed,
  applyScreenshotNoChargeClosed,
  applySandboxAbortCleanupClosed,
} = require('../../computer/computer-code-guard');
const loginHandoff = require('../../computer/login-handoff');

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
function loadAdapter() {
  try { return require('../engine-adapter'); } catch (_) { return null; }
}

function makeComputerExecutors({ env = process.env, driver = null, userId, sessionId, session, computerEnabled } = {}) {
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

  function refuseOrThrow(toolName, extra = {}) {
    const ad = loadAdapter();
    const uid = extra.userId != null ? extra.userId : userId;
    const sid = extra.sessionId != null ? extra.sessionId : sessionId;
    const sess = extra.session || session;
    if (ad && typeof ad.refuseComputerToolsIfNoUserId === 'function') {
      ad.refuseComputerToolsIfNoUserId({ toolName, userId: uid });
    }
    if (ad && typeof ad.refuseComputerToolsIfSessionMissing === 'function') {
      ad.refuseComputerToolsIfSessionMissing({ toolName, sessionId: sid, session: sess });
    }
    const guard = applyRefuseComputerToolsClosed({
      toolName,
      userId: uid,
      sessionId: sid,
      session: sess,
      computerEnabled: computerEnabled !== false,
      refuseComputerToolsIfFlagOff: ad && ad.refuseComputerToolsIfFlagOff,
      refuseComputerToolsIfNoUserId: uid ? ad && ad.refuseComputerToolsIfNoUserId : undefined,
      refuseComputerToolsIfSessionMissing: (sid || sess)
        ? ad && ad.refuseComputerToolsIfSessionMissing
        : undefined,
    });
    if (guard && guard.ok === false) {
      const err = new Error(guard.message || guard.code);
      err.code = guard.code;
      throw err;
    }
    return guard;
  }

  function cleanupOnAbort(signal, started, timeoutMs) {
    const ad = loadAdapter();
    applySandboxAbortCleanupClosed({
      aborted: !!(signal && signal.aborted),
      elapsedMs: Date.now() - started,
      timeoutMs,
      sandboxTimeoutThenCleanup: ad && ad.sandboxTimeoutThenCleanup,
      sandboxFinallyCleanupOnAbort: ad && ad.sandboxFinallyCleanupOnAbort,
      sandboxTmpCleanupOnTimeout: ad && ad.sandboxTmpCleanupOnTimeout,
    });
  }

  const executors = {
    async computer_screenshot(args = {}, { signal } = {}) {
      throwIfAborted(signal);
      throwIfComputerActionAborted(signal);
      refuseOrThrow('computer_screenshot', args);
      const paused = loginHandoff.refuseAgentType({
        toolName: 'computer_screenshot',
        conversationId: args.conversationId || (session && session.conversationId),
        user: { id: userId },
        identity: session,
      });
      if (paused.refuse) {
        return loginHandoff.loginHandoffToolResult(
          { kind: (paused.kind || 'password'), reason: paused.reason },
          loginHandoff.getTakeover({ identity: session, conversationId: args.conversationId, user: { id: userId } }),
        );
      }
      const ad = loadAdapter();
      applyScreenshotNoChargeClosed({
        tools: [{ name: 'computer_screenshot' }],
        screenshotOnly: true,
        screenshotOnlyNoCharge: ad && ad.screenshotOnlyNoCharge,
      });
      const started = Date.now();
      let drv;
      try {
        drv = await getDriver(signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: ${err?.message || err}`;
      }
      try {
        const shot = await drv.screenshot({ signal });
        let url = args.url || (session && session.url) || '';
        let title = args.title || '';
        let pageText = String(shot.text || '');
        try {
          const persistent = require('../../computer/persistent');
          if (session && typeof persistent.peekPage === 'function') {
            const peek = await persistent.peekPage(session);
            url = url || (peek && peek.url) || '';
            title = title || (peek && peek.title) || '';
            if (peek && peek.text) pageText = `${pageText}\n${peek.text}`;
          }
        } catch (_) { /* peek is best-effort */ }
        const observeText = `computer_screenshot ok (${drv.kind}): ${pageText}`;
        const handed = loginHandoff.applyObserveHandoff(session, {
          text: observeText,
          url,
          title,
          focused: args.focused || args.focusedField || null,
        }, {
          user: { id: userId },
          conversationId: args.conversationId || (session && session.conversationId),
          identity: session,
        });
        if (handed.loginHandoff) {
          return {
            __f7Image: handed.screenshotBlocked ? undefined : { base64: shot.base64, mediaType: shot.mediaType },
            text: loginHandoff.loginHandoffToolResult(handed.loginGate, handed.takeover),
          };
        }
        return {
          __f7Image: { base64: shot.base64, mediaType: shot.mediaType },
          text: observeText,
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: captura de pantalla falló: ${err?.message || err}`;
      } finally {
        cleanupOnAbort(signal, started, 15_000);
      }
    },
    async computer_click(args = {}, { signal } = {}) {
      throwIfAborted(signal);
      throwIfComputerActionAborted(signal);
      refuseOrThrow('computer_click', args);
      const paused = loginHandoff.refuseAgentType({
        toolName: 'computer_click',
        conversationId: args.conversationId || (session && session.conversationId),
        user: { id: userId },
        identity: session,
        url: args.url,
        title: args.title,
        dom: args.dom || args.pageText || args.a11y,
      });
      if (paused.refuse) {
        const gate = loginHandoff.detectLoginGate({
          url: args.url,
          title: args.title,
          text: args.dom || args.pageText || args.a11y || '',
        });
        loginHandoff.beginTakeover({
          conversationId: args.conversationId || (session && session.conversationId),
          user: { id: userId },
          identity: session,
          site: gate.site,
          kind: gate.kind || 'password',
          reason: paused.reason,
        });
        return loginHandoff.loginHandoffToolResult(gate, loginHandoff.getTakeover({
          identity: session,
          conversationId: args.conversationId,
          user: { id: userId },
        }));
      }
      const btn = normalizeComputerButton(args.button);
      if (!btn.ok && args.button != null && String(args.button).trim()) {
        return `ERROR: computer_button_invalid`;
      }
      const pt = clampComputerPoint(args.x, args.y);
      const started = Date.now();
      let drv;
      try {
        drv = await getDriver(signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: ${err?.message || err}`;
      }
      try {
        const res = await drv.click({ ...args, x: pt.x, y: pt.y, button: btn.button }, { signal });
        return JSON.stringify(res);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: click falló: ${err?.message || err}`;
      } finally {
        cleanupOnAbort(signal, started, 10_000);
      }
    },
    async computer_type(args = {}, { signal } = {}) {
      throwIfAborted(signal);
      throwIfComputerActionAborted(signal);
      refuseOrThrow('computer_type', args);
      if (!String(args.text || '').length) return 'ERROR: computer_type requiere `text`.';
      const blocked = loginHandoff.refuseAgentType({
        toolName: 'computer_type',
        args,
        text: args.text,
        focused: args.focused || args.focusedField,
        conversationId: args.conversationId || userId,
        user: { id: userId },
        identity: session,
      });
      if (blocked.refuse) {
        const gate = loginHandoff.detectLoginGate({
          url: args.url,
          title: args.title,
          text: args.dom || args.pageText || args.a11y || '',
          focused: args.focused || args.focusedField,
        });
        loginHandoff.beginTakeover({
          conversationId: args.conversationId || (session && session.conversationId),
          user: { id: userId },
          identity: session,
          site: gate.site,
          kind: gate.kind || 'password',
          reason: blocked.reason,
        });
        const waited = await loginHandoff.waitUntilReleased({
          conversationId: args.conversationId || (session && session.conversationId),
          user: { id: userId },
          identity: session,
          signal,
        });
        return loginHandoff.loginHandoffResumeResult(gate, Boolean(waited && waited.released));
      }
      const started = Date.now();
      let drv;
      try {
        drv = await getDriver(signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: ${err?.message || err}`;
      }
      try {
        const res = await drv.type({ ...args, text: String(args.text || '').slice(0, MAX_TYPE_CHARS) }, { signal });
        return JSON.stringify(res);
      } catch (err) {
        if (signal?.aborted) throw err;
        return `ERROR: escritura falló: ${err?.message || err}`;
      } finally {
        cleanupOnAbort(signal, started, 30_000);
      }
    },
  };

  return {
    executors,
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
      description: 'Escribe texto en el elemento enfocado del escritorio controlado. NUNCA escribas contraseñas, OTP, 2FA, CVV ni usuario de un formulario de login: si aparece un muro de login, PAUSA y pide toma de control. El usuario inicia sesión en la computadora; SiraGPT no ve la contraseña.',
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
