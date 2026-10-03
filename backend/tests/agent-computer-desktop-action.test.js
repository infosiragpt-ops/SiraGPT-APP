'use strict';

/**
 * POST /api/agent-computer/action forwards one action to the desktop
 * orchestrator. Its own 5xx (a CDP call that timed out after 15 s, a desktop
 * that died) used to be relayed verbatim as a 500 of this API; the forward
 * itself had no timeout. Now: bounded call, 504 / 502 with a Spanish
 * message, and the orchestrator's error code preserved for the logs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { forwardDesktopAction, throwIfDesktopActionFailed, desktopFocusError } = require('../src/routes/agent-computer');

function jsonResponse(status, body) {
  return { status, ok: status < 400, json: async () => body };
}

test('orchestrator 500 cdp_timeout → 504 desktop_action_timeout with a Spanish message', () => {
  assert.throws(
    () => throwIfDesktopActionFailed(500, { ok: false, error: 'cdp_timeout Input.dispatchMouseEvent' }),
    (err) => err.status === 504
      && err.code === 'desktop_action_timeout'
      && /no respondió a tiempo/.test(err.publicMessage)
      && err.upstream.status === 500
      && /cdp_timeout/.test(err.upstream.error),
  );
});

test('orchestrator 500 without a timeout hint → 502 desktop_action_failed', () => {
  assert.throws(
    () => throwIfDesktopActionFailed(500, { ok: false, message: 'desktop crashed' }),
    (err) => err.status === 502 && err.code === 'desktop_action_failed' && /no pudo completar la acción/.test(err.publicMessage),
  );
});

test('orchestrator 2xx / 4xx pass through untouched', () => {
  assert.doesNotThrow(() => throwIfDesktopActionFailed(200, { ok: true }));
  assert.doesNotThrow(() => throwIfDesktopActionFailed(409, { ok: false, error: 'login_handoff' }));
});

test('forwardDesktopAction: a bounded call that returns the orchestrator response', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { ok: true });
  };
  const res = await forwardDesktopAction('http://orch/sessions/s1/agent/action', { type: 'click', x: 1, y: 2 }, { fetchImpl, timeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).type, 'click');
  assert.ok(calls[0].init.signal && typeof calls[0].init.signal.aborted === 'boolean', 'the forward carries an abort signal');
});

test('forwardDesktopAction: a hung orchestrator is a 504, not a request that never ends', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), { once: true });
  });
  await assert.rejects(
    forwardDesktopAction('http://orch/x', { type: 'screenshot' }, { fetchImpl, timeoutMs: 20 }),
    (err) => err.status === 504 && err.code === 'desktop_action_timeout' && /no respondió a tiempo/.test(err.publicMessage),
  );
});

test('forwardDesktopAction: transport failure is a 502 in Spanish, never a raw «fetch failed»', async () => {
  const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') }); };
  await assert.rejects(
    forwardDesktopAction('http://orch/x', { type: 'screenshot' }, { fetchImpl, timeoutMs: 1000 }),
    (err) => err.status === 502 && err.code === 'desktop_unreachable' && /No se pudo contactar el escritorio/.test(err.publicMessage),
  );
});

test('forwardDesktopAction: the client abort is rethrown as is', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const fetchImpl = async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
  await assert.rejects(
    forwardDesktopAction('http://orch/x', { type: 'screenshot' }, { fetchImpl, signal: ctrl.signal, timeoutMs: 1000 }),
    (err) => err.name === 'AbortError' && !err.status,
  );
});

// Focus commands (xdotool inside the desktop container): the user never
// reads the raw `docker exec … xdotool search --class google-chrome …` line.
test('desktopFocusError: a failed xdotool focus is a 502 in Spanish without the docker command', () => {
  const raw = Object.assign(new Error('Command failed: docker exec -u compuser -e DISPLAY=:1 sira-ac-user-abc_c_def bash -lc xdotool search --onlyvisible --class google-chrome windowactivate'), { stderr: '' });
  const err = desktopFocusError(raw, 'chrome');
  assert.equal(err.status, 502);
  assert.equal(err.code, 'desktop_focus_failed');
  assert.doesNotMatch(err.publicMessage, /docker|xdotool|sira-ac-user/);
  assert.match(err.publicMessage, /«chrome»/);
  assert.equal(err.cause, raw);
});

test('desktopFocusError: the desktop_app_not_ready marker keeps its 503 copy', () => {
  const err = desktopFocusError(Object.assign(new Error('Command failed'), { stderr: 'desktop_app_not_ready\n' }), 'terminal');
  assert.equal(err.status, 503);
  assert.equal(err.code, 'desktop_app_not_ready');
  assert.match(err.publicMessage, /no pudo abrirse/);
});

test('desktopFocusError: a missing / stopped container is a 503 desktop_unavailable', () => {
  const err = desktopFocusError(Object.assign(new Error('Command failed'), { stderr: 'Error response from daemon: No such container: sira-ac-user-x' }), 'files');
  assert.equal(err.status, 503);
  assert.equal(err.code, 'desktop_unavailable');
  assert.doesNotMatch(err.publicMessage, /sira-ac-user/);
});

test('desktopFocusError: a client abort is not a desktop failure', () => {
  const err = desktopFocusError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'chrome');
  assert.equal(err.status, 499);
  assert.equal(err.code, 'desktop_focus_aborted');
});
