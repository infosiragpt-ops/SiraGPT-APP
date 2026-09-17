'use strict';

/**
 * /code (Empresas) computer guard — wires existing helpers fail-closed.
 *
 * Isolation (conversation / workspace), action map (bounds / button / abort),
 * refuse-if-flag/user/session, screenshot-only no-charge, sandbox timeout +
 * abort reap. DeepSeek Flash/Pro only. Never OpenRouter.
 *
 * Does not invent 3Hxx overlay names. Callers pass live #388 adapter
 * helpers so the hot path names them.
 */

const {
  ISOLATION_REFUSED_ES,
  publicComputerError,
  isolationError,
  requireProvenIsolation,
  attachIsolationOrRefuse,
  readIsolationKey,
} = require('./conversation-isolation');
const { resolveSessionIdentity } = require('./member-key');
const {
  agentComputerEnabled,
  resolveComputerModel,
  DEEPSEEK_FLASH,
} = require('./flags');
const {
  mapComputerActions,
  throwIfComputerActionAborted,
  normalizeComputerAction,
} = require('../computer-use-action-mapper');
const { capControlSteps } = require('./control-loop');

const OPENROUTER_DENIED_ES = 'Ese modelo no está permitido en la computadora.';
const COMPUTER_FLAG_OFF_ES = 'La computadora no está habilitada. No ejecuté la herramienta.';
const COMPUTER_NO_USER_ES = 'Falta el usuario de esta computadora. No ejecuté la herramienta.';
const COMPUTER_NO_SESSION_ES = 'No hay sesión de computadora. No ejecuté la herramienta.';
const COMPUTER_ABORTED_ES = 'La acción de computadora se canceló. No seguí.';

function refuseOpenRouterComputerModel(hint, env = process.env) {
  const raw = String(hint == null ? '' : hint).trim().toLowerCase();
  if (raw.includes('openrouter')) {
    return { ok: false, model: DEEPSEEK_FLASH, code: 'openrouter_denied', message: OPENROUTER_DENIED_ES };
  }
  return { ok: true, model: resolveComputerModel(hint, env), code: null };
}

function applyIsolationClosed({ user, conversationId, workspaceId, identity } = {}) {
  const key = String(conversationId || workspaceId || '').trim();
  const resolved = identity || resolveSessionIdentity(user, key);
  return requireProvenIsolation(resolved);
}

function applyAttachClosed({ session, user, conversationId, workspaceId, identity } = {}) {
  const proven = applyIsolationClosed({ user, conversationId, workspaceId, identity });
  attachIsolationOrRefuse(session, proven);
  return proven;
}

function applyActionMapClosed({ action, actions, signal, bounds } = {}) {
  throwIfComputerActionAborted(signal);
  const raw = actions != null ? actions : action;
  const mapped = mapComputerActions(raw, { signal, bounds });
  if (!mapped.ok) {
    const err = isolationError();
    err.status = 400;
    err.code = mapped.code || 'computer_action_invalid';
    err.publicMessage = publicComputerError({ message: mapped.code }, COMPUTER_ABORTED_ES);
    throw err;
  }
  return mapped;
}

function applyRefuseComputerToolsClosed({
  toolName,
  userId,
  sessionId,
  session,
  computerEnabled,
  computerOnly,
  refuseComputerToolsIfFlagOff,
  refuseComputerToolsIfNoUserId,
  refuseComputerToolsIfSessionMissing,
  refuseHostBashIfComputerOnlyTurn,
} = {}) {
  const name = String(toolName || '');
  if (typeof refuseComputerToolsIfFlagOff === 'function') {
    const off = refuseComputerToolsIfFlagOff(name, { computerEnabled });
    if (off && off.ok === false) {
      return { ok: false, refuse: true, code: off.code || 'computer_flag_off', message: COMPUTER_FLAG_OFF_ES };
    }
  }
  if (typeof refuseComputerToolsIfNoUserId === 'function') {
    const noUser = refuseComputerToolsIfNoUserId({ toolName: name, userId });
    if (noUser && noUser.ok === false) {
      return { ok: false, refuse: true, code: noUser.code || 'computer_no_user', message: COMPUTER_NO_USER_ES };
    }
  }
  if (typeof refuseComputerToolsIfSessionMissing === 'function') {
    const noSess = refuseComputerToolsIfSessionMissing({ toolName: name, sessionId, session });
    if (noSess && noSess.ok === false) {
      return { ok: false, refuse: true, code: noSess.code || 'computer_no_session', message: COMPUTER_NO_SESSION_ES };
    }
  }
  if (typeof refuseHostBashIfComputerOnlyTurn === 'function') {
    const host = refuseHostBashIfComputerOnlyTurn({ computerOnly, toolName: name });
    if (host && host.ok === false) {
      return { ok: false, refuse: true, code: host.code || 'host_bash_blocked', message: host.code };
    }
  }
  return { ok: true, refuse: false, code: null };
}

function applyScreenshotNoChargeClosed({
  tools,
  names,
  screenshotOnly,
  observeOnly,
  screenshotOnlyNoCharge,
  observeOnlyNoCharge,
} = {}) {
  let charge = true;
  let code = null;
  if (typeof screenshotOnlyNoCharge === 'function') {
    const shot = screenshotOnlyNoCharge({ tools, names, screenshotOnly });
    if (shot && shot.charge === false) {
      charge = false;
      code = shot.code || 'credit_screenshot';
    }
  }
  if (charge && typeof observeOnlyNoCharge === 'function') {
    const obs = observeOnlyNoCharge({ tools, names, observeOnly });
    if (obs && obs.charge === false) {
      charge = false;
      code = obs.code || 'credit_observe';
    }
  }
  return { charge, screenshotOnly: charge === false && code === 'credit_screenshot', code };
}

function applySandboxAbortCleanupClosed({
  aborted,
  timedOut,
  elapsedMs,
  timeoutMs,
  workdir,
  tmpDir,
  pid,
  kill,
  rmFn,
  sandboxTimeoutThenCleanup,
  sandboxFinallyCleanupOnAbort,
  sandboxTmpCleanupOnTimeout,
} = {}) {
  const out = { cleaned: false, timeout: false, aborted: aborted === true, code: null };
  if (typeof sandboxTimeoutThenCleanup === 'function') {
    const to = sandboxTimeoutThenCleanup({ elapsedMs, timeoutMs, workdir });
    if (to && to.cleanup) {
      out.cleaned = true;
      out.timeout = true;
      out.code = to.code || 'sandbox_timeout_cleanup';
    }
  }
  if (typeof sandboxTmpCleanupOnTimeout === 'function') {
    const tmp = sandboxTmpCleanupOnTimeout({ timedOut: timedOut === true || out.timeout, tmpDir: tmpDir || workdir, rmFn });
    if (tmp && tmp.cleaned) {
      out.cleaned = true;
      out.code = tmp.code || out.code || 'sandbox_tmp_cleanup';
    }
  }
  if (typeof sandboxFinallyCleanupOnAbort === 'function') {
    const fin = sandboxFinallyCleanupOnAbort({ aborted, workdir, pid, kill });
    if (fin && fin.cleanup) {
      out.cleaned = true;
      out.aborted = true;
      out.code = fin.code || 'sandbox_abort_cleanup';
    }
  }
  return out;
}

function applyComputerTimeoutClosed({
  timeoutMs,
  remainingMs,
  defaultToolTimeout30sIfMissing,
  hardCapToolTimeout120s,
  perToolRemainingWallClock,
} = {}) {
  let ms = timeoutMs;
  if (typeof defaultToolTimeout30sIfMissing === 'function') {
    const def = defaultToolTimeout30sIfMissing(ms);
    if (def && def.timeoutMs != null) ms = def.timeoutMs;
  }
  if (typeof hardCapToolTimeout120s === 'function') {
    const cap = hardCapToolTimeout120s(ms);
    if (cap && cap.timeoutMs != null) ms = cap.timeoutMs;
  }
  if (typeof perToolRemainingWallClock === 'function' && remainingMs != null) {
    const wall = perToolRemainingWallClock({ timeoutMs: ms, remainingMs });
    if (wall && wall.timeoutMs != null) ms = wall.timeoutMs;
  }
  capControlSteps(25);
  return { timeoutMs: Math.max(1, Number(ms) || 30_000), code: null };
}

function requestAbortSignal(req) {
  const ac = new AbortController();
  const abort = () => {
    try { ac.abort(); } catch (_) { /* already aborted */ }
  };
  if (req && typeof req.on === 'function') {
    req.on('aborted', abort);
    req.on('close', () => {
      if (req.aborted === true) abort();
    });
  }
  if (req && req.signal && typeof req.signal.addEventListener === 'function') {
    if (req.signal.aborted) abort();
    else req.signal.addEventListener('abort', abort, { once: true });
  }
  return ac.signal;
}

function computerFlagEnabled(env = process.env) {
  return agentComputerEnabled(env) === true;
}

module.exports = {
  ISOLATION_REFUSED_ES,
  OPENROUTER_DENIED_ES,
  COMPUTER_FLAG_OFF_ES,
  COMPUTER_NO_USER_ES,
  COMPUTER_NO_SESSION_ES,
  COMPUTER_ABORTED_ES,
  refuseOpenRouterComputerModel,
  applyIsolationClosed,
  applyAttachClosed,
  applyActionMapClosed,
  applyRefuseComputerToolsClosed,
  applyScreenshotNoChargeClosed,
  applySandboxAbortCleanupClosed,
  applyComputerTimeoutClosed,
  requestAbortSignal,
  computerFlagEnabled,
  readIsolationKey,
  normalizeComputerAction,
};
