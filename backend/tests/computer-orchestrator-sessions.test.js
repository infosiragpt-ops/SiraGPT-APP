'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createOrchestrator } = require('../../services/computer-orchestrator/server');
const { slugUserId, sessionIdFor, containerNameFor } = require('../../services/computer-orchestrator/session-store');
const { buildActionCommand } = require('../../services/computer-orchestrator/agent-actions');

function listen(orch) {
  return new Promise((resolve) => {
    orch.server.listen(0, '127.0.0.1', () => {
      const { port } = orch.server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => orch.server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

async function postSession(base, userId) {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const body = await res.json();
  return { res, body };
}

describe('siragpt-computer-orchestrator session contract', () => {
  test('POST /sessions reuses the same desktop for the same userId', async () => {
    const orch = createOrchestrator({ driver: 'fake', env: { PORT: '0' } });
    const srv = await listen(orch);
    try {
      const first = await postSession(srv.url, 'luis_c_chatA');
      assert.ok(first.res.status === 201 || first.res.status === 200);
      assert.equal(first.body.reused, false);
      assert.equal(first.body.userId, 'luis_c_chatA');
      assert.equal(first.body.sessionId, sessionIdFor('luis_c_chatA'));
      assert.equal(first.body.container, containerNameFor('luis_c_chatA'));

      const second = await postSession(srv.url, 'luis_c_chatA');
      assert.equal(second.res.status, 200);
      assert.equal(second.body.reused, true);
      assert.equal(second.body.sessionId, first.body.sessionId);
      assert.equal(orch.store.size(), 1);
    } finally {
      await srv.close();
    }
  });

  test('isolation: chat A and chat B get different session ids and containers', async () => {
    const orch = createOrchestrator({ driver: 'fake' });
    const srv = await listen(orch);
    try {
      const a = await postSession(srv.url, 'luis_c_chatA');
      const b = await postSession(srv.url, 'luis_c_chatB');
      assert.notEqual(a.body.sessionId, b.body.sessionId);
      assert.notEqual(a.body.container, b.body.container);
      assert.match(a.body.container, /^sira-ac-user-/);
      assert.equal(orch.store.size(), 2);
      const got = await fetch(`${srv.url}/sessions/${a.body.sessionId}`);
      const row = await got.json();
      assert.equal(row.userId, 'luis_c_chatA');
      assert.notEqual(row.userId, b.body.userId);
    } finally {
      await srv.close();
    }
  });

  test('GET /sessions/:id 404s unknown ids; agent/action works after create', async () => {
    const orch = createOrchestrator({ driver: 'fake' });
    const srv = await listen(orch);
    try {
      const missing = await fetch(`${srv.url}/sessions/no-such`);
      assert.equal(missing.status, 404);
      const created = await postSession(srv.url, 'memberX');
      const action = await fetch(`${srv.url}/sessions/${created.body.sessionId}/agent/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'click', x: 10, y: 20 }),
      });
      const body = await action.json();
      assert.equal(action.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.type, 'click');
    } finally {
      await srv.close();
    }
  });

  test('container slug and action commands stay within the live contract', () => {
    assert.equal(slugUserId('luis_c_chatA'), 'luis_c_chatA');
    assert.equal(containerNameFor('luis_c_chatA'), 'sira-ac-user-luis_c_chatA');
    assert.equal(buildActionCommand({ type: 'click', x: 4, y: 8 }), 'xdotool mousemove 4 8 click 1');
    assert.match(buildActionCommand({ type: 'type', text: "hi" }), /xdotool type/);
    assert.equal(buildActionCommand({ type: 'unknown' }), null);
  });

  test('Dockerfile creates compuser by name without forcing UID 1000', () => {
    const dockerfile = fs.readFileSync(
      path.join(__dirname, '../../services/computer-orchestrator/Dockerfile'),
      'utf8',
    );
    assert.match(dockerfile, /useradd -m -s \/bin\/bash compuser/);
    assert.doesNotMatch(dockerfile, /useradd[^\n]*-u 1000/);
    assert.match(dockerfile, /getent passwd compuser/);
  });
});

describe('orchestrator http server health', () => {
  test('GET /health reports fake driver', async () => {
    const orch = createOrchestrator({ driver: 'fake' });
    const srv = await listen(orch);
    try {
      const res = await fetch(`${srv.url}/health`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.driver, 'fake');
    } finally {
      await srv.close();
    }
  });
});
