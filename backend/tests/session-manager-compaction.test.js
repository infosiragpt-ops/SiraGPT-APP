'use strict';

// Regression: compactSession's AI-compactor path computed droppedMessages as
// `total - kept.length` BEFORE the filter that unconditionally preserves the
// first 2 + last 6 messages, so the reported drop overstated reality and
// kept + dropped != total. Now counted from the actual surviving length.
//
// A fake context-compactor (returns fewer, non-matching messages) is injected
// via require.cache so the model path runs fully offline.

const test = require('node:test');
const assert = require('node:assert/strict');

const compactorPath = require.resolve('../src/services/sira/context-compactor');
let compactorReturn = null;
require.cache[compactorPath] = {
  id: compactorPath,
  filename: compactorPath,
  loaded: true,
  exports: { compactContext: async () => compactorReturn },
};

const sm = require('../src/services/session-manager');

test('compactSession (model path) reports the ACTUAL drop: kept + dropped === total', async () => {
  const session = sm.createSession('compaction-fix-user', { label: 'fix' });
  for (let i = 0; i < 10; i++) {
    sm.addMessage(session.id, { role: 'user', content: `original-message-${i}`, tokens: 10 });
  }
  const total = session.messages.length;
  assert.equal(total, 10);

  // 3 summary messages matching none of the originals → only the unconditional
  // first-2 + last-6 survive (8 kept, 2 dropped). The buggy code reported
  // droppedMessages = total - 3 = 7.
  compactorReturn = {
    messages: [{ content: 'SUMMARY-A' }, { content: 'SUMMARY-B' }, { content: 'SUMMARY-C' }],
    stats: { total_tokens: 42 },
  };
  const res = await sm.compactSession(session.id, { model: 'fake-model' });

  assert.equal(res.compacted, true);
  assert.equal(res.pipeline, 'context-compactor');
  assert.equal(res.keptMessages, 8, 'first 2 + last 6 survive');
  assert.equal(res.droppedMessages, 2, 'only the 2 unmatched middle messages drop (not 7)');
  assert.equal(res.keptMessages + res.droppedMessages, total, 'kept + dropped must equal the original total');
});
