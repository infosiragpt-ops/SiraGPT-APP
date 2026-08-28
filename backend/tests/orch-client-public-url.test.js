'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  rewriteUrls,
  publicBase,
  orchFetch,
  ORCH_DOWN_ES,
} = require('../src/services/computer/orch-client');
const { publicComputerError } = require('../src/services/computer/conversation-isolation');

describe('agent-computer public URL rewrite', () => {
  test('default embedUrl is on https://siragpt.com, never computer.siragpt.com', () => {
    const session = rewriteUrls({ sessionId: 'ac_luis_c_chatA', userId: 'luis_c_chatA' }, {});
    assert.match(session.embedUrl, /^https:\/\/siragpt\.com\/sessions\/ac_luis_c_chatA\/novnc\/vnc\.html/);
    assert.match(session.embedUrl, /path=sessions\/ac_luis_c_chatA\/novnc\/websockify/);
    assert.doesNotMatch(session.embedUrl, /computer\.siragpt\.com/);
    assert.doesNotMatch(session.embedUrl, /computer\.chatagic\.com/);
    assert.doesNotMatch(session.novncWsUrl, /computer\.siragpt\.com/);
    assert.equal(publicBase({}), 'https://siragpt.com');
  });

  test('explicit computer.siragpt.com public base is rewritten to siragpt.com', () => {
    const session = rewriteUrls(
      { sessionId: 'sid1', userId: 'luis' },
      { AGENT_COMPUTER_PUBLIC_BASE: 'https://computer.siragpt.com' },
    );
    assert.equal(publicBase({ AGENT_COMPUTER_PUBLIC_BASE: 'https://computer.siragpt.com' }), 'https://siragpt.com');
    assert.match(session.embedUrl, /^https:\/\/siragpt\.com\/sessions\/sid1\//);
    assert.doesNotMatch(session.embedUrl, /computer\.siragpt\.com/);
  });

  test('orchFetch maps missing hostname / fetch failed to Spanish 503', async () => {
    await assert.rejects(
      () => orchFetch('/sessions', {
        method: 'POST',
        body: { userId: 'luis' },
        env: { AGENT_COMPUTER_ORCHESTRATOR_URL: 'http://siragpt-computer-orchestrator:8090' },
        fetchImpl: async () => { throw new TypeError('fetch failed'); },
      }),
      (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.code, 'ORCH_UNAVAILABLE');
        assert.equal(err.publicMessage, ORCH_DOWN_ES);
        assert.match(err.publicMessage, /escritorio no está disponible/);
        assert.doesNotMatch(err.publicMessage, /fetch failed/);
        return true;
      },
    );
  });

  test('publicComputerError never leaks fetch failed to the pane', () => {
    assert.equal(
      publicComputerError({ message: 'fetch failed' }),
      'No se pudo abrir la computadora. El escritorio no está disponible.',
    );
    assert.doesNotMatch(publicComputerError({ message: 'fetch failed' }), /fetch failed/);
  });
});
