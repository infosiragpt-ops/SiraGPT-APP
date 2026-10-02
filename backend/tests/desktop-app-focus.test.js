'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { desktopAppFocusCommand } = require('../src/services/computer/desktop-app-focus');
const { chromeMaximizeOrLaunch } = require('../src/services/computer/chrome-desktop-flags');
const { publicComputerError, OPEN_FAILED_ES } = require('../src/services/computer/conversation-isolation');
const pexec = promisify(execFile);

function fixture(t, { visible = false, activate = true, launch = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-focus-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  const script = (name, source) => {
    fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  };
  fs.writeFileSync(path.join(dir, 'xdotool'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FOCUS_STATE/calls"
case "$1" in
  search) [ -f "$FOCUS_STATE/visible" ] || exit 1; printf '12345\\n' ;;
  windowactivate) [ "$FOCUS_ACTIVATE" != no ] || exit 1; printf 12345 > "$FOCUS_STATE/active" ;;
  getactivewindow) if [ -f "$FOCUS_STATE/active" ]; then cat "$FOCUS_STATE/active"; else printf 0; fi ;;
esac
`, { mode: 0o755 });
  const gui = `
    const fs = require('node:fs'), path = require('node:path');
    const state = process.env.FOCUS_STATE;
    fs.writeFileSync(path.join(state, 'pid'), String(process.pid));
    fs.appendFileSync(path.join(state, 'launches'), 'launch\\n');
    if (process.env.FOCUS_LAUNCH === 'no') process.exit(9);
    setTimeout(() => fs.writeFileSync(path.join(state, 'visible'), 'ready'), 80);
    setInterval(() => process.stdout.write('GUI still running\\n'), 100);
  `;
  for (const name of ['google-chrome', 'chromium', 'thunar', 'xfce4-terminal']) script(name, gui);
  if (visible) fs.writeFileSync(path.join(state, 'visible'), 'ready');
  t.after(() => {
    try { process.kill(Number(fs.readFileSync(path.join(state, 'pid')))); } catch (_) { /* exited/missing */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, state,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FOCUS_STATE: state,
      FOCUS_ACTIVATE: activate ? 'yes' : 'no', FOCUS_LAUNCH: launch ? 'yes' : 'no' },
  };
}

test('Chrome launch returns after a confirmed window while the GUI remains alive', async (t) => {
  const f = fixture(t);
  const out = await pexec('bash', ['-c', chromeMaximizeOrLaunch()], { env: f.env, timeout: 3000 });
  assert.match(out.stdout, /desktop_app_ready/);
  const pid = Number(fs.readFileSync(path.join(f.state, 'pid')));
  assert.doesNotThrow(() => process.kill(pid, 0), 'request must not wait for or kill the GUI');
  const calls = fs.readFileSync(path.join(f.state, 'calls'), 'utf8');
  assert.match(calls, /windowmove 12345 0 0/);
  assert.match(calls, /windowsize 12345 1920 1080/);
});

for (const [windowClass, launchCommand] of [
  ['Thunar', 'exec thunar /workspace'],
  ['xfce4-terminal', 'exec xfce4-terminal --working-directory=/workspace'],
]) {
  test(`${windowClass} launch confirms an active window without waiting on GUI lifetime`, async (t) => {
    const f = fixture(t);
    const out = await pexec('bash', ['-c', desktopAppFocusCommand({ windowClass, launchCommand })], { env: f.env, timeout: 3000 });
    assert.match(out.stdout, /desktop_app_ready/);
    assert.equal(fs.readFileSync(path.join(f.state, 'active'), 'utf8'), '12345');
    assert.equal(fs.readFileSync(path.join(f.state, 'launches'), 'utf8'), 'launch\n');
  });
}

test('an existing window is activated without starting a duplicate application', async (t) => {
  const f = fixture(t, { visible: true });
  const out = await pexec('bash', ['-c', chromeMaximizeOrLaunch()], { env: f.env, timeout: 3000 });
  assert.match(out.stdout, /desktop_app_ready/);
  assert.equal(fs.existsSync(path.join(f.state, 'launches')), false);
});

test('failed application startup never reports a successful focus', async (t) => {
  const f = fixture(t, { launch: false });
  await assert.rejects(pexec('bash', ['-c', chromeMaximizeOrLaunch()], { env: f.env, timeout: 10000 }), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /desktop_app_not_ready/);
    assert.doesNotMatch(err.stdout, /desktop_app_ready/);
    return true;
  });
});

test('a visible but unactivatable window fails without spawning duplicates', async (t) => {
  const f = fixture(t, { visible: true, activate: false });
  await assert.rejects(pexec('bash', ['-c', chromeMaximizeOrLaunch()], { env: f.env, timeout: 10000 }), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /desktop_app_not_ready/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(f.state, 'launches')), false);
});

test('desktop failures do not reveal internal commands, session containers or credentials', () => {
  for (const message of [
    'Command failed: docker exec -u compuser -e DISPLAY=:1 sira-ac-user-private bash -lc xdotool search',
    'docker exec sira-ac-user-private failed',
    'Authorization: Bearer private-value',
  ]) assert.equal(publicComputerError({ message }), OPEN_FAILED_ES);
  assert.equal(publicComputerError({ publicMessage: 'La aplicación no pudo abrirse.', message: 'Command failed: docker exec secret' }), 'La aplicación no pudo abrirse.');
});
