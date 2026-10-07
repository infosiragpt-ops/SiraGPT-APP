'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { agentComputerEnabled } = require('../services/computer/flags');
const { orchFetch, rewriteUrls, resolveOrchConfig } = require('../services/computer/orch-client');
const { resolveSessionIdentity } = require('../services/computer/member-key');
const {
  ISOLATION_REFUSED_ES,
  OPEN_FAILED_ES,
  publicComputerError,
  looksLikeSecretOrStack,
  isolationError,
  sessionMatchesConversation,
  readIsolationKey,
  requireProvenIsolation,
  attachIsolationOrRefuse,
} = require('../services/computer/conversation-isolation');
const {
  applyIsolationClosed,
  applyAttachClosed,
  applyActionMapClosed,
  applyRefuseComputerToolsClosed,
  applyScreenshotNoChargeClosed,
  applySandboxAbortCleanupClosed,
  applyComputerTimeoutClosed,
  requestAbortSignal,
  refuseOpenRouterComputerModel,
} = require('../services/computer/computer-code-guard');
const loginHandoff = require('../services/computer/login-handoff');
const {
  chromeMaximizeOrLaunch,
} = require('../services/computer/chrome-desktop-flags');
const { desktopAppFocusCommand } = require('../services/computer/desktop-app-focus');
const { sanitizeNavigateUrl, classifyNavigationFailure } = require('../services/computer/navigate-url');

const pexec = promisify(execFile);
const router = express.Router();
const XD = 'xdo' + 'tool';

function requireFlag(req, res, next) {
  if (!agentComputerEnabled()) return res.status(404).json({ error: 'not_found' });
  return next();
}

function memberId(req) {
  return req.user && req.user.id ? String(req.user.id) : '';
}

function readConversationId(req) {
  return readIsolationKey({ body: req.body || {}, query: req.query || {} });
}

function identityFor(req) {
  const conversationId = readConversationId(req);
  const identity = resolveSessionIdentity({ id: memberId(req) }, conversationId);
  // /agentes home and Nuevo chat have no conversationId yet. Return a
  // member desktop instead of throwing isolation_required (409).
  if (!conversationId) return identity;
  return applyIsolationClosed({
    user: { id: memberId(req) },
    conversationId,
    identity,
  });
}

function sessionOwnedByMember(session, identity) {
  const orchUser = String((session && session.userId) || '');
  if (!orchUser || !identity) return false;
  return orchUser === String(identity.userId) || orchUser === String(identity.memberKey || '');
}

function loadAdapter() {
  try { return require('../services/agent-runner/engine-adapter'); } catch (_) { return null; }
}

function loadSandboxAbort() {
  try { return require('../services/agent-runner/engine-3h60'); } catch (_) { return null; }
}

function loadSandboxTimeout() {
  try { return require('../services/agent-runner/engine-3h59'); } catch (_) { return null; }
}

function withConversation(desktop, identity) {
  return {
    ...desktop,
    conversationId: identity.conversationId,
    conversationBound: identity.conversationBound,
    sessionKey: identity.sessionKey,
  };
}

function refuseLiveComputer(req, toolName, session) {
  const ad = loadAdapter();
  const guard = applyRefuseComputerToolsClosed({
    toolName,
    userId: memberId(req),
    sessionId: session && (session.sessionId || session.id),
    session,
    computerEnabled: agentComputerEnabled(),
    refuseComputerToolsIfFlagOff: ad && ad.refuseComputerToolsIfFlagOff,
    refuseComputerToolsIfNoUserId: ad && ad.refuseComputerToolsIfNoUserId,
    refuseComputerToolsIfSessionMissing: ad && ad.refuseComputerToolsIfSessionMissing,
    refuseHostBashIfComputerOnlyTurn: ad && ad.refuseHostBashIfComputerOnlyTurn,
  });
  if (guard && guard.ok === false) {
    const err = new Error(guard.message || ISOLATION_REFUSED_ES);
    err.status = 409;
    err.code = guard.code;
    err.publicMessage = publicComputerError(err, guard.message || ISOLATION_REFUSED_ES);
    throw err;
  }
  return guard;
}

async function ensureMemberDesktop(req) {
  const identity = identityFor(req);
  // The orchestrator answers 503 for a moment while it (re)starts a desktop;
  // prod 2026-09-27 the same request succeeded 4 s later. One short retry
  // hides that blip instead of surfacing «Computadora no disponible».
  const desktop = await orchFetchWithRetry('/sessions', { method: 'POST', body: { userId: identity.userId } });
  if (identity.conversationBound) {
    requireProvenIsolation(identity);
    applyAttachClosed({ session: desktop, identity });
  }
  return rewriteUrls(withConversation({ ...desktop, userId: desktop.userId || identity.userId }, identity));
}

function ownedOrDeny(session, req, res) {
  try {
    const identity = identityFor(req);
    if (identity.conversationBound) {
      attachIsolationOrRefuse(session, identity);
      if (!sessionMatchesConversation(session, identity)) {
        res.status(403).json({ error: 'isolation_required', message: ISOLATION_REFUSED_ES });
        return false;
      }
      return true;
    }
    if (!sessionOwnedByMember(session, identity)) {
      res.status(403).json({ error: 'isolation_required', message: ISOLATION_REFUSED_ES });
      return false;
    }
    return true;
  } catch (err) {
    res.status(err.status || 409).json({
      error: err.code || 'isolation_required',
      message: publicComputerError(err, ISOLATION_REFUSED_ES),
    });
    return false;
  }
}

router.get('/health', requireFlag, (_req, res) => {
  const orch = resolveOrchConfig();
  res.json({ ok: true, enabled: true, model: 'persistent-per-conversation-or-member', orchestrator: orch.enabled, viewer: 'novnc' });
});

router.get('/embed-auth', requireFlag, authenticateToken, (req, res) => {
  if (!memberId(req)) return res.status(401).json({ error: 'unauthorized' });
  return res.status(204).end();
});

const ORCH_RETRY_DELAY_MS = Number.parseInt(process.env.AGENT_COMPUTER_ORCH_RETRY_MS || '1500', 10);
async function orchFetchWithRetry(path, init, attempts = 2) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await orchFetch(path, init);
    } catch (err) {
      lastErr = err;
      const transient = Number(err && err.status) === 503 || err?.code === 'ORCH_UNAVAILABLE';
      if (!transient || attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, ORCH_RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

router.post('/sessions', requireFlag, authenticateToken, async (req, res) => {
  try {
    const desktop = await ensureMemberDesktop(req);
    return res.status(desktop.reused ? 200 : 201).json(desktop);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.code || 'create_failed',
      message: publicComputerError(err, err.code === 'isolation_required' ? ISOLATION_REFUSED_ES : OPEN_FAILED_ES),
    });
  }
});

const DESKTOP_ACTION_TIMEOUT_MS = Number(process.env.COMPUTER_ACTION_TIMEOUT_MS) > 0
  ? Number(process.env.COMPUTER_ACTION_TIMEOUT_MS)
  : 45_000;

function actionSignal(signal, ms) {
  const timer = AbortSignal.timeout(ms);
  if (!signal || typeof AbortSignal.any !== 'function') return timer;
  try { return AbortSignal.any([signal, timer]); } catch (_) { return timer; }
}

// Forward one action to the desktop orchestrator. The call is bounded (a
// desktop that hangs must not hold the route forever) and a transport
// failure is a 502 with a Spanish message, never a raw `fetch failed`.
async function forwardDesktopAction(target, action, { signal, fetchImpl = fetch, timeoutMs = DESKTOP_ACTION_TIMEOUT_MS } = {}) {
  try {
    return await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
      signal: actionSignal(signal, timeoutMs),
    });
  } catch (cause) {
    if (signal && signal.aborted) throw cause;
    const timedOut = cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    const err = new Error(timedOut
      ? 'El escritorio no respondió a tiempo. Inténtalo de nuevo.'
      : 'No se pudo contactar el escritorio de este chat. Vuelve a abrir la computadora e inténtalo de nuevo.');
    err.code = timedOut ? 'desktop_action_timeout' : 'desktop_unreachable';
    err.status = timedOut ? 504 : 502;
    err.publicMessage = err.message;
    err.cause = cause;
    throw err;
  }
}

// The orchestrator's own 5xx (its CDP call timed out, the desktop died) is
// an upstream failure: report it as such (504 / 502) with a message the
// panel can show, instead of relaying it as a 500 of this API.
function throwIfDesktopActionFailed(status, data) {
  if (Number(status) < 500) return;
  const detail = String((data && (data.error || data.message)) || '');
  const timedOut = /timeout|timed?\s*out/i.test(detail);
  const err = new Error(timedOut
    ? 'El escritorio no respondió a tiempo. Inténtalo de nuevo.'
    : 'El escritorio no pudo completar la acción. Vuelve a abrir la computadora e inténtalo de nuevo.');
  err.code = timedOut ? 'desktop_action_timeout' : 'desktop_action_failed';
  err.status = timedOut ? 504 : 502;
  err.publicMessage = err.message;
  err.upstream = { status: Number(status), error: detail.slice(0, 200) };
  throw err;
}

// A focus command (xdotool / app launcher inside the desktop container) that
// fails used to surface as a 500 whose message was the raw `docker exec …`
// command line (container name included). The user reads what happened to
// the app, never the command; the detail stays in the server log.
function desktopFocusError(err, focus) {
  const stderr = String((err && err.stderr) || '');
  const mapped = new Error('');
  mapped.cause = err;
  mapped.focus = focus;
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    mapped.code = 'desktop_focus_aborted';
    mapped.status = 499;
    mapped.message = 'La acción se canceló antes de completarse.';
  } else if (stderr.includes('desktop_app_not_ready')) {
    mapped.code = 'desktop_app_not_ready';
    mapped.status = 503;
    mapped.message = 'La aplicación no pudo abrirse en el escritorio. Vuelve a abrir la computadora e inténtalo de nuevo.';
  } else if (/No such container|is not running|Cannot connect to the Docker daemon|not found/i.test(stderr + ' ' + String((err && err.message) || ''))) {
    mapped.code = 'desktop_unavailable';
    mapped.status = 503;
    mapped.message = 'El escritorio de esta conversación no está disponible. Vuelve a abrir la computadora e inténtalo de nuevo.';
  } else {
    mapped.code = 'desktop_focus_failed';
    mapped.status = 502;
    mapped.message = `No pude traer ${focus ? `la aplicación «${focus}»` : 'la aplicación'} al frente en el escritorio. Inténtalo de nuevo o vuelve a abrir la computadora.`;
  }
  mapped.publicMessage = mapped.message;
  console.warn('[agent-computer] focus failed', { focus, code: mapped.code, detail: String((err && err.message) || '').slice(0, 200) });
  return mapped;
}

// Admin → Logs only showed «request errored — failed with status code 502»
// for the computer routes (prod 2026-10-03): the cause never reached the
// log. One WARN line per failure code every 30 s names the route, the code
// and the sanitised cause; repeats in the window are counted, not printed.
const COMPUTER_WARN_WINDOW_MS = 30_000;
const computerWarnBuckets = new Map();
const UNAVAILABLE_CODES = new Set(['browser_observation_unavailable', 'desktop_unavailable']);

function causeSummary(err) {
  const cause = err && err.cause;
  const upstream = err && err.upstream && err.upstream.error;
  const raw = String((cause && (cause.code || cause.message)) || upstream || '').replace(/\s+/g, ' ').trim();
  if (!raw || looksLikeSecretOrStack(raw)) return cause && cause.code ? String(cause.code) : (raw ? 'redacted' : '');
  return raw.slice(0, 160);
}

function warnComputerFailure(res, err, code) {
  const status = Number(err && err.status) || 500;
  if (status < 500) return;
  const now = Date.now();
  const bucket = computerWarnBuckets.get(code);
  if (bucket && now - bucket.at < COMPUTER_WARN_WINDOW_MS) { bucket.suppressed += 1; return; }
  const suppressed = bucket ? bucket.suppressed : 0;
  computerWarnBuckets.set(code, { at: now, suppressed: 0 });
  const req = res && res.req;
  const route = req ? `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}` : 'computer';
  const sessionId = String((req && ((req.body && req.body.sessionId) || (req.query && req.query.sessionId))) || '').slice(0, 64);
  try {
    console.warn(`[agent-computer] ${code} status=${status} route=${route}${sessionId ? ` session=${sessionId}` : ''} cause=${causeSummary(err) || 'n/a'}${suppressed ? ` suppressed=${suppressed}` : ''}`);
  } catch (_) { /* logging must never break a response */ }
}

function failComputer(res, err, fallbackCode) {
  const code = err.code || fallbackCode;
  warnComputerFailure(res, err, code);
  return res.status(err.status || 500).json({
    error: code,
    message: publicComputerError(err, err.code === 'isolation_required' ? ISOLATION_REFUSED_ES : OPEN_FAILED_ES),
  });
}

async function existingMemberDesktop(req, res) {
  const id = req.body?.sessionId || req.query?.sessionId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    res.status(400).json({ error: 'browser_session_required', message: 'Abre el navegador antes de continuar.' });
    return null;
  }
  const session = rewriteUrls(await orchFetch('/sessions/' + encodeURIComponent(id)));
  if (!ownedOrDeny(session, req, res)) return null;
  return session;
}

function browserFailure(error, code) {
  if (['browser_action_invalid', 'browser_tab_missing', 'browser_presentation_capacity', 'browser_viewport_failed', ...UNAVAILABLE_CODES].includes(error?.code)) return error;
  const safe = new Error('No se pudo completar la acción del navegador. Vuelve a intentarlo.', { cause: error });
  safe.code = code;
  safe.status = 502;
  safe.publicMessage = safe.message;
  return safe;
}

async function navigateMemberDesktop(session, url, signal, tabId) {
  try {
    // Navigate the attached browser itself. A background process launch is not
    // evidence that this desktop loaded the page (or even opened a browser).
    const { navigatePage } = require('../services/computer/live-page');
    const result = await navigatePage(session, url, process.env, signal, { tabId });
    return { ok: true, url: result.url, sessionId: session.sessionId };
  } catch (cause) {
    if (['browser_tab_missing', 'browser_action_invalid', 'browser_viewport_failed', ...UNAVAILABLE_CODES].includes(cause?.code)) throw cause;
    // The destination, not the computer, failed: an address nobody can
    // resolve is the caller's 4xx (no ERROR line for a typo), a site that is
    // down or slow stays 5xx with a message that names the site.
    const classified = classifyNavigationFailure(cause, url);
    const err = new Error(classified ? classified.message : 'No se pudo abrir la página. Revisa la dirección e inténtalo de nuevo.', { cause });
    err.code = classified ? classified.code : 'navigate_failed';
    err.status = classified ? classified.status : 502;
    err.publicMessage = err.message;
    throw err;
  }
}

router.post('/navigate', requireFlag, authenticateToken, async (req, res) => {
  const signal = requestAbortSignal(req);
  try {
    const url = sanitizeNavigateUrl(req.body && (req.body.url || req.body.href));
    const desktop = req.body?.sessionId ? await existingMemberDesktop(req, res) : await ensureMemberDesktop(req);
    if (!desktop) return;
    const out = await navigateMemberDesktop(desktop, url, signal, req.body?.tabId);
    return res.json(withConversation(out, identityFor(req)));
  } catch (err) {
    return failComputer(res, err, 'navigate_failed');
  }
});

router.get('/desktop', requireFlag, authenticateToken, async (req, res) => {
  try { return res.json(await ensureMemberDesktop(req)); }
  catch (err) { return failComputer(res, err, 'get_failed'); }
});

router.get('/sessions/me', requireFlag, authenticateToken, async (req, res) => {
  try { return res.json(await ensureMemberDesktop(req)); }
  catch (err) { return failComputer(res, err, 'get_failed'); }
});

router.get('/sessions/:id', requireFlag, authenticateToken, async (req, res) => {
  try {
    const session = rewriteUrls(await orchFetch('/sessions/' + req.params.id));
    if (!ownedOrDeny(session, req, res)) return;
    return res.json(withConversation(session, identityFor(req)));
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.code || 'get_failed',
      message: publicComputerError(err, err.code === 'isolation_required' ? ISOLATION_REFUSED_ES : OPEN_FAILED_ES),
    });
  }
});

const FOCUS_CMDS = {
  chrome: chromeMaximizeOrLaunch({ xdotool: XD }),
  browser: chromeMaximizeOrLaunch({ xdotool: XD }),
  thunar: desktopAppFocusCommand({ xdotool: XD, windowClass: 'Thunar', launchCommand: 'exec thunar /workspace' }),
  files: desktopAppFocusCommand({ xdotool: XD, windowClass: 'Thunar', launchCommand: 'exec thunar /workspace' }),
  terminal: desktopAppFocusCommand({ xdotool: XD, windowClass: 'xfce4-terminal', launchCommand: 'exec xfce4-terminal --working-directory=/workspace' }),
  desktop: XD + ' search --onlyvisible --class xfdesktop windowactivate || true',
};

async function dockerExec(container, command, { signal, timeoutMs } = {}) {
  const ad = loadAdapter();
  const w59 = loadSandboxTimeout();
  const w60 = loadSandboxAbort();
  const timed = applyComputerTimeoutClosed({
    timeoutMs: timeoutMs || 20_000,
    defaultToolTimeout30sIfMissing: ad && ad.defaultToolTimeout30sIfMissing,
    hardCapToolTimeout120s: ad && ad.hardCapToolTimeout120s,
    perToolRemainingWallClock: ad && ad.perToolRemainingWallClock,
  });
  const started = Date.now();
  try {
    const { stdout, stderr } = await pexec(
      'docker',
      ['exec', '-u', 'compuser', '-e', 'DISPLAY=:1', container, 'bash', '-lc', command],
      { timeout: timed.timeoutMs, signal },
    );
    return { stdout: String(stdout || ''), stderr: String(stderr || '') };
  } finally {
    applySandboxAbortCleanupClosed({
      aborted: !!(signal && signal.aborted),
      timedOut: (Date.now() - started) >= timed.timeoutMs,
      elapsedMs: Date.now() - started,
      timeoutMs: timed.timeoutMs,
      workdir: container,
      sandboxTimeoutThenCleanup: (ad && ad.sandboxTimeoutThenCleanup) || (w59 && w59.sandboxTimeoutThenCleanup),
      sandboxFinallyCleanupOnAbort: (ad && ad.sandboxFinallyCleanupOnAbort) || (w60 && w60.sandboxFinallyCleanupOnAbort),
      sandboxTmpCleanupOnTimeout: ad && ad.sandboxTmpCleanupOnTimeout,
    });
  }
}

function sessionContainer(session) {
  return require('../services/computer/persistent').containerName(session);
}

async function handleAction(req, res, session) {
  const identity = identityFor(req);
  if (identity.conversationBound) {
    attachIsolationOrRefuse(session, identity);
  } else if (!sessionOwnedByMember(session, identity)) {
    throw isolationError();
  }
  refuseLiveComputer(req, (req.body && (req.body.tool || req.body.toolName)) || 'computer_action', session);
  refuseOpenRouterComputerModel(req.body && req.body.model);
  const signal = requestAbortSignal(req);
  const ad = loadAdapter();
  const charge = applyScreenshotNoChargeClosed({
    tools: (req.body && req.body.tools) || [{ name: (req.body && req.body.action && req.body.action.type) || (req.body && req.body.type) || '' }],
    screenshotOnly: req.body && req.body.screenshotOnly,
    observeOnly: req.body && req.body.observeOnly,
    screenshotOnlyNoCharge: ad && ad.screenshotOnlyNoCharge,
    observeOnlyNoCharge: ad && ad.observeOnlyNoCharge,
  });
  const focus = String((req.body && (req.body.focus || req.body.app)) || '').trim().toLowerCase();
  if (focus && FOCUS_CMDS[focus]) {
    if (focus !== 'chrome' && focus !== 'browser') {
      try {
        await require('../services/computer/live-page').restoreBrowserPresentation(session, process.env, signal);
      } catch (err) { throw browserFailure(err, 'browser_restore_failed'); }
    }
    let out;
    try {
      out = await dockerExec(sessionContainer(session), FOCUS_CMDS[focus], { signal });
    } catch (err) {
      throw desktopFocusError(err, focus);
    }
    return res.json({
      ok: true,
      focus,
      sessionId: session.sessionId,
      conversationId: identity.conversationId,
      conversationBound: identity.conversationBound,
      sessionKey: identity.sessionKey,
      charge: charge.charge,
      ...out,
    });
  }
  const rawAction = (req.body && req.body.action) || req.body || {};
  const typeName = String(rawAction.type || rawAction.action || rawAction.tool || '').toLowerCase();
  const blocked = loginHandoff.refuseAgentType({
    toolName: typeName || 'computer_action',
    text: rawAction.text,
    focused: rawAction.focused || rawAction.focusedField,
    url: rawAction.url,
    title: rawAction.title,
    dom: rawAction.dom || rawAction.pageText || rawAction.a11y,
    conversationId: identity.conversationId,
    identity,
    user: { id: memberId(req) },
  });
  if (blocked.refuse) {
    const gate = loginHandoff.detectLoginGate({
      url: rawAction.url,
      title: rawAction.title,
      text: rawAction.dom || rawAction.pageText || rawAction.a11y || '',
      focused: rawAction.focused || rawAction.focusedField,
    });
    const takeover = loginHandoff.beginTakeover({
      identity,
      conversationId: identity.conversationId,
      site: gate.site,
      kind: gate.kind || 'password',
      reason: blocked.reason,
    });
    return res.status(409).json({
      ok: false,
      error: blocked.code,
      loginHandoff: true,
      message: blocked.message,
      takeover,
      event: takeover.event,
      conversationId: identity.conversationId,
      conversationBound: identity.conversationBound,
    });
  }
  if (typeName.startsWith('browser_')) {
    const { browserAction } = require('../services/computer/live-page');
    try {
      const browser = await browserAction(session, rawAction, process.env, signal);
      return res.json(withConversation({ ok: true, sessionId: session.sessionId, browser }, identity));
    } catch (err) { throw browserFailure(err, 'browser_action_failed'); }
  }
  const mapped = applyActionMapClosed({
    action: rawAction.type || rawAction.action ? rawAction : null,
    actions: Array.isArray(rawAction.actions) ? rawAction.actions : (rawAction.type || rawAction.action ? [rawAction] : []),
    signal,
  });
  const action = (mapped.actions && mapped.actions[0]) || rawAction;
  const orch = resolveOrchConfig();
  const target = orch.url + '/sessions/' + session.sessionId + '/agent/action';
  const forwarded = await forwardDesktopAction(target, action, { signal });
  const data = await forwarded.json().catch(() => ({}));
  throwIfDesktopActionFailed(forwarded.status, data);
  return res.status(forwarded.status).json(withConversation({
    ...data,
    charge: charge.charge,
    screenshotOnly: charge.screenshotOnly,
  }, identityFor(req)));
}

router.post('/action', requireFlag, authenticateToken, async (req, res) => {
  try {
    const action = req.body?.action || req.body || {};
    const type = String(action.type || action.action || action.tool || '').toLowerCase();
    // Browser controls only operate the desktop already opened by this member.
    // In particular polling/actions cannot implicitly create another session.
    const session = type.startsWith('browser_') ? await existingMemberDesktop(req, res) : await ensureMemberDesktop(req);
    if (!session) return;
    return await handleAction(req, res, session);
  }
  catch (err) { return failComputer(res, err, 'action_failed'); }
});

router.post('/sessions/:id/action', requireFlag, authenticateToken, async (req, res) => {
  try {
    const session = rewriteUrls(await orchFetch('/sessions/' + req.params.id));
    if (!ownedOrDeny(session, req, res)) return;
    return await handleAction(req, res, session);
  } catch (err) {
    return failComputer(res, err, 'action_failed');
  }
});


// Live browser progress for the side-panel chip ("Viendo google.com - clic -
// paso 3"). Read-only and side-effect free: never creates a session, only
// reports the last recorded agent action plus a best-effort page peek.
router.get('/activity', requireFlag, authenticateToken, async (req, res) => {
  try {
    if (req.query.browser === '1') {
      const session = await existingMemberDesktop(req, res);
      if (!session) return;
      try {
        const { browserState } = require('../services/computer/live-page');
        const browser = await browserState(session, process.env, requestAbortSignal(req));
        return res.json(withConversation({ ok: true, sessionId: session.sessionId, browser }, identityFor(req)));
      } catch (err) {
        // The panel polls this every 4 s. A desktop whose Chrome or container
        // is gone is reported as a plain «not available» probe result (never
        // ok:true), not as a 5xx of this API on every tick; the cause goes to
        // the rate-limited WARN above. Viewport/tab failures keep their status.
        if (UNAVAILABLE_CODES.has(err?.code)) {
          warnComputerFailure(res, err, err.code);
          return res.json(withConversation({
            ok: false, sessionId: session.sessionId, browser: null, error: err.code,
            message: publicComputerError(err, OPEN_FAILED_ES),
          }, identityFor(req)));
        }
        throw browserFailure(err, 'browser_state_failed');
      }
    }
    const identity = identityFor(req);
    requireProvenIsolation(identity);
    const { getActivity } = require('../services/computer/live-actions');
    const persistent = require('../services/computer/persistent');
    const activity = getActivity(identity.sessionKey);
    let peek = null;
    try {
      peek = await persistent.peekExisting(identity);
    } catch (_) { /* container may not be running */ }
    return res.json({
      activity: activity || null,
      url: (peek && peek.url) || (activity && activity.lastUrl) || null,
      title: (peek && peek.title) || '',
    });
  } catch (err) {
    return failComputer(res, err, 'activity_failed');
  }
});

router.get('/login-handoff', requireFlag, authenticateToken, async (req, res) => {
  try {
    const identity = identityFor(req);
    requireProvenIsolation(identity);
    const persistent = require('../services/computer/persistent');
    const state = await loginHandoff.ensureTakeoverFromLivePage({
      identity,
      conversationId: identity.conversationId,
      user: { id: memberId(req) },
      forceProbe: String((req.query && req.query.probe) || '') === '1',
      observe: async () => {
        try {
          const peek = await persistent.peekExisting(identity);
          if (peek && (peek.url || peek.text || peek.title)) return peek;
        } catch (_) { /* container may not be running */ }
        return loginHandoff.getLastObserve(identity, { id: memberId(req) }) || {};
      },
    });
    return res.json({
      ...state,
      ...loginHandoff.overlayOpenFromTakeover(state),
      chatMessage: loginHandoff.chatMessageForTakeover(state),
    });
  } catch (err) {
    return failComputer(res, err, 'handoff_failed');
  }
});

router.post('/login-handoff', requireFlag, authenticateToken, (req, res) => {
  try {
    const identity = identityFor(req);
    requireProvenIsolation(identity);
    const action = String((req.body && req.body.action) || '').trim().toLowerCase();
    if (action === 'ready' || action === 'release' || action === 'listo') {
      return res.json(loginHandoff.endTakeover({ identity, conversationId: identity.conversationId }));
    }
    const gate = loginHandoff.detectLoginGate(req.body || {});
    const state = loginHandoff.beginTakeover({
      identity,
      conversationId: identity.conversationId,
      site: (req.body && req.body.site) || gate.site,
      kind: (req.body && req.body.kind) || gate.kind || 'password',
      reason: (req.body && req.body.reason) || gate.reason || 'login_form',
    });
    return res.status(201).json(state);
  } catch (err) {
    return failComputer(res, err, 'handoff_failed');
  }
});

module.exports = router;
module.exports.identityFor = identityFor;
module.exports.ensureMemberDesktop = ensureMemberDesktop;
module.exports.forwardDesktopAction = forwardDesktopAction;
module.exports.throwIfDesktopActionFailed = throwIfDesktopActionFailed;
module.exports.desktopFocusError = desktopFocusError;
