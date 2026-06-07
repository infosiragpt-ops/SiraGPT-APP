/**
 * Tests for the two extra key-less general-web providers added to widen the
 * aggregating search breadth: stackexchange + hackernews.
 *
 * Same hermetic pattern as web-search-scientific-providers.test.js: stub
 * node-fetch via require.cache BEFORE loading the providers.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const fetchPath = require.resolve('node-fetch');
let fetchImpl = async () => { throw new Error('fetch not mocked'); };
require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: (...args) => fetchImpl(...args),
};

const stackexchange = require('../src/services/agents/web-search/providers/stackexchange');
const hackernews = require('../src/services/agents/web-search/providers/hackernews');

function json(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

beforeEach(() => { fetchImpl = async () => { throw new Error('fetch not mocked'); }; });

// ─── stackexchange ───────────────────────────────────────────────────

test('stackexchange: normalises items, decodes entities, builds a meta snippet', async () => {
  let capturedUrl = '';
  fetchImpl = async (url) => {
    capturedUrl = String(url);
    return json({ items: [
      { title: 'How to flatten an array in JS &amp; TS?', link: 'https://stackoverflow.com/q/1', tags: ['javascript', 'arrays'], score: 42, answer_count: 5, is_answered: true },
      { title: 'No link here', score: 1 },
    ] });
  };
  const out = await stackexchange.search('flatten array', { maxResults: 5 });
  assert.match(capturedUrl, /api\.stackexchange\.com/);
  assert.match(capturedUrl, /site=stackoverflow/);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'stackexchange');
  assert.equal(out[0].url, 'https://stackoverflow.com/q/1');
  assert.equal(out[0].title, 'How to flatten an array in JS & TS?');
  assert.match(out[0].snippet, /respondida/);
  assert.match(out[0].snippet, /5 respuestas/);
  assert.match(out[0].snippet, /javascript/);
});

test('stackexchange: throws on non-2xx so the adapter classifies + falls through', async () => {
  fetchImpl = async () => json({}, { status: 502 });
  await assert.rejects(() => stackexchange.search('q'), /stackexchange http 502/);
});

test('stackexchange: empty items returns []', async () => {
  fetchImpl = async () => json({ items: [] });
  assert.deepEqual(await stackexchange.search('q'), []);
});

// ─── hackernews ──────────────────────────────────────────────────────

test('hackernews: links out for stories with a url, item page for Ask HN', async () => {
  let capturedUrl = '';
  fetchImpl = async (url) => {
    capturedUrl = String(url);
    return json({ hits: [
      { objectID: '111', title: 'Show HN: My project', url: 'https://example.com/proj', points: 120, num_comments: 30 },
      { objectID: '222', title: 'Ask HN: How do you test?', points: 40, num_comments: 12, story_text: '<p>I wonder...</p>' },
    ] });
  };
  const out = await hackernews.search('show hn', { maxResults: 5 });
  assert.match(capturedUrl, /hn\.algolia\.com/);
  assert.match(capturedUrl, /tags=story/);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'hackernews');
  assert.equal(out[0].url, 'https://example.com/proj');
  assert.match(out[0].snippet, /120 puntos/);
  // Ask HN without url → HN item page; story_text HTML stripped.
  assert.equal(out[1].url, 'https://news.ycombinator.com/item?id=222');
  assert.match(out[1].snippet, /I wonder/);
  assert.equal(/<p>/.test(out[1].snippet), false);
});

test('hackernews: throws on non-2xx', async () => {
  fetchImpl = async () => json({}, { status: 500 });
  await assert.rejects(() => hackernews.search('q'), /hackernews http 500/);
});

test('extra providers carry the expected general-web priority + enabled metadata', () => {
  assert.equal(stackexchange.priority, 12);
  assert.equal(hackernews.priority, 14);
  for (const p of [stackexchange, hackernews]) {
    assert.equal(p.enabled, true);
    assert.equal(typeof p.search, 'function');
  }
});
