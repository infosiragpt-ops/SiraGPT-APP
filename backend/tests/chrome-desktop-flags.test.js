'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  CHROME_DOCKER_FLAGS,
  CHROME_VISIBLE_FLAGS,
  chromeOpenUrlCommand,
  chromeMaximizeOrLaunch,
} = require('../src/services/computer/chrome-desktop-flags');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('chrome desktop flags', () => {
  it('keeps no-sandbox and suppresses the unsupported-flag infobar', () => {
    assert.match(CHROME_DOCKER_FLAGS, /--no-sandbox/);
    assert.match(CHROME_DOCKER_FLAGS, /--test-type/);
    assert.match(CHROME_DOCKER_FLAGS, /--disable-infobars/);
    assert.match(CHROME_VISIBLE_FLAGS, /--start-maximized/);
    assert.match(CHROME_VISIBLE_FLAGS, /--window-size=1920,1080/);
    assert.doesNotMatch(CHROME_VISIBLE_FLAGS, /DeepSeek|OpenRouter|model_id/);
  });

  it('opens a URL maximized without about:blank', () => {
    const cmd = chromeOpenUrlCommand('https://siragpt.com');
    assert.match(cmd, /--no-sandbox/);
    assert.match(cmd, /--test-type/);
    assert.match(cmd, /--start-maximized/);
    assert.match(cmd, /https:\/\/siragpt\.com/);
    assert.doesNotMatch(cmd, /about:blank/);
  });

  it('maximizes an existing Chrome window before launching another', () => {
    const cmd = chromeMaximizeOrLaunch({ xdotool: 'xdotool' });
    assert.match(cmd, /windowsize 1920 1080/);
    assert.match(cmd, /--test-type/);
    assert.match(cmd, /--no-sandbox/);
    assert.doesNotMatch(cmd, /about:blank/);
  });

  it('wires the same flags into every visible desktop Chrome launch', () => {
    const sh = read('services/computer-orchestrator/start-desktop.sh');
    const desk = read('services/computer-orchestrator/desktop-look/applications/google-chrome.desktop');
    const orch = read('services/computer-orchestrator/server.js');
    const route = read('backend/src/routes/agent-computer.js');
    const tools = read('backend/src/services/computer/chat-computer-tools.js');
    for (const [name, src] of [
      ['start-desktop.sh', sh],
      ['google-chrome.desktop', desk],
      ['orch server.js', orch],
      ['agent-computer.js', route],
      ['chat-computer-tools.js', tools],
    ]) {
      assert.match(src, /--no-sandbox/, `${name} keeps --no-sandbox`);
      assert.match(src, /--test-type/, `${name} suppresses the infobar`);
    }
    assert.match(sh, /--no-startup-window/);
    assert.doesNotMatch(sh, /about:blank/);
    assert.match(desk, /--start-maximized/);
    assert.match(desk, /--window-size=1920,1080/);
    assert.match(orch, /--start-maximized/);
    assert.match(orch, /--window-size=1920,1080/);
    assert.match(route, /chromeOpenUrlCommand/);
    assert.match(route, /chromeMaximizeOrLaunch/);
    assert.match(tools, /chromeOpenUrlCommand/);
    assert.doesNotMatch(route, /about:blank/);
  });
});
