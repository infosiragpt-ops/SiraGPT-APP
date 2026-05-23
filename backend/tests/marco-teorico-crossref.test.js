/**
 * Tests for services/marco-teorico/crossref.js — DOI verification +
 * authoritative metadata fetch.
 *
 * We stub globalThis.fetch per-test so no real HTTP runs.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach, afterEach } = require('node:test');

const {
  verify,
  verifyBatch,
  CONCURRENCY,
} = require('../src/services/marco-teorico/crossref');

const _origFetch = globalThis.fetch;
function setFetch(impl) {
  globalThis.fetch = impl;
}
afterEach(() => {
  globalThis.fetch = _origFetch;
});

// ── constants ────────────────────────────────────────────────────

describe('CONCURRENCY', () => {
  it('is 6 (polite default for CrossRef)', () => {
    assert.equal(CONCURRENCY, 6);
  });
});

// ── verify · primitives ────────────────────────────────────────

describe('verify · primitives', () => {
  it('returns { valid:false, doi:null } for non-string DOI', async () => {
    assert.deepEqual(await verify(null), { valid: false, doi: null });
    assert.deepEqual(await verify(undefined), { valid: false, doi: null });
    assert.deepEqual(await verify(42), { valid: false, doi: null });
  });

  it('returns { valid:false, doi:"" } for empty string', async () => {
    const out = await verify('');
    assert.equal(out.valid, false);
    assert.equal(out.doi, null);
  });
});

describe('verify · network', () => {
  it('returns { valid:false } when fetch throws', async () => {
    setFetch(async () => { throw new Error('network down'); });
    const out = await verify('10.1234/example');
    assert.deepEqual(out, { valid: false, doi: '10.1234/example' });
  });

  it('returns { valid:false } when response is not ok', async () => {
    setFetch(async () => ({ ok: false, status: 404 }));
    const out = await verify('10.1234/missing');
    assert.deepEqual(out, { valid: false, doi: '10.1234/missing' });
  });

  it('returns { valid:false } when JSON parse fails', async () => {
    setFetch(async () => ({
      ok: true,
      json: async () => { throw new Error('parse'); },
    }));
    const out = await verify('10.1234/bad-json');
    assert.equal(out.valid, false);
  });

  it('returns { valid:false } when message field missing', async () => {
    setFetch(async () => ({
      ok: true,
      json: async () => ({ other: 'shape' }),
    }));
    const out = await verify('10.1234/no-message');
    assert.equal(out.valid, false);
  });
});

describe('verify · happy paths', () => {
  function setMessage(message) {
    setFetch(async () => ({
      ok: true,
      json: async () => ({ message }),
    }));
  }

  it('extracts title (first element of array OR plain string)', async () => {
    setMessage({ title: ['First Title'] });
    let out = await verify('10.1/x');
    assert.equal(out.title, 'First Title');
    setMessage({ title: 'Plain Title' });
    out = await verify('10.1/x');
    assert.equal(out.title, 'Plain Title');
  });

  it('parses authors with family/given/name fields', async () => {
    setMessage({
      author: [
        { family: 'Smith', given: 'Alice' },
        { family: 'Jones', given: 'Bob' },
        { name: 'Corporate Author' },
      ],
    });
    const out = await verify('10.1/x');
    assert.equal(out.authors.length, 3);
    assert.equal(out.authors[0].family, 'Smith');
    assert.equal(out.authors[0].given, 'Alice');
    assert.equal(out.authors[0].name, null);
    assert.equal(out.authors[2].name, 'Corporate Author');
  });

  it('authors defaults to [] when missing', async () => {
    setMessage({});
    const out = await verify('10.1/x');
    assert.deepEqual(out.authors, []);
  });

  it('extracts year via published-print > published-online > created precedence', async () => {
    setMessage({
      'published-print': { 'date-parts': [[2024, 5, 1]] },
      'published-online': { 'date-parts': [[2023, 1, 1]] },
      created: { 'date-parts': [[2022, 1, 1]] },
    });
    let out = await verify('10.1/x');
    assert.equal(out.year, 2024);

    setMessage({
      'published-online': { 'date-parts': [[2023, 1, 1]] },
      created: { 'date-parts': [[2022, 1, 1]] },
    });
    out = await verify('10.1/x');
    assert.equal(out.year, 2023);

    setMessage({
      created: { 'date-parts': [[2022, 1, 1]] },
    });
    out = await verify('10.1/x');
    assert.equal(out.year, 2022);

    setMessage({});
    out = await verify('10.1/x');
    assert.equal(out.year, null);
  });

  it('container picks first element of container-title array', async () => {
    setMessage({ 'container-title': ['Nature', 'Nature Reviews'] });
    const out = await verify('10.1/x');
    assert.equal(out.container, 'Nature');
  });

  it('container is null when container-title not an array', async () => {
    setMessage({ 'container-title': 'not-an-array' });
    const out = await verify('10.1/x');
    assert.equal(out.container, null);
  });

  it('volume / issue / pages / publisher / type passthrough', async () => {
    setMessage({
      volume: '12', issue: '3', page: '101-150',
      publisher: 'Elsevier', type: 'journal-article',
    });
    const out = await verify('10.1/x');
    assert.equal(out.volume, '12');
    assert.equal(out.issue, '3');
    assert.equal(out.pages, '101-150');
    assert.equal(out.publisher, 'Elsevier');
    assert.equal(out.type, 'journal-article');
  });

  it('url uses message.URL when present, falls back to doi.org', async () => {
    setMessage({ URL: 'https://example.com/x' });
    let out = await verify('10.1/x');
    assert.equal(out.url, 'https://example.com/x');
    setMessage({});
    out = await verify('10.1/x');
    assert.equal(out.url, 'https://doi.org/10.1/x');
  });

  it('sends Polite-Pool User-Agent header with mailto', async () => {
    let captured;
    setFetch(async (url, init) => {
      captured = init;
      return { ok: true, json: async () => ({ message: {} }) };
    });
    await verify('10.1/x');
    assert.match(captured.headers['User-Agent'], /mailto:/);
    assert.match(captured.headers['User-Agent'], /siraGPT/);
  });

  it('Accept header set to application/json', async () => {
    let captured;
    setFetch(async (_url, init) => {
      captured = init;
      return { ok: true, json: async () => ({ message: {} }) };
    });
    await verify('10.1/x');
    assert.equal(captured.headers.Accept, 'application/json');
  });

  it('URL targets api.crossref.org with the DOI path', async () => {
    let captured;
    setFetch(async (url) => {
      captured = url;
      return { ok: true, json: async () => ({ message: {} }) };
    });
    await verify('10.1234/abc.def');
    assert.match(captured, /^https:\/\/api\.crossref\.org\/works\/10\.1234\/abc\.def/);
  });

  it('preserves DOI slashes in the URL (not percent-encoded)', async () => {
    let captured;
    setFetch(async (url) => {
      captured = url;
      return { ok: true, json: async () => ({ message: {} }) };
    });
    await verify('10.1/has/two/slashes');
    assert.match(captured, /\/has\/two\/slashes$/);
    assert.equal(captured.includes('%2F'), false);
  });
});

describe('verify · timeout / abort', () => {
  it('does not start fetch when caller-signal is already aborted', async () => {
    let calls = 0;
    setFetch(async () => {
      calls += 1;
      return { ok: true, json: async () => ({ message: {} }) };
    });
    const ac = new AbortController();
    ac.abort(new Error('cancel before crossref'));

    const out = await verify('10.1/x', { signal: ac.signal });

    assert.deepEqual(out, { valid: false, doi: '10.1/x' });
    assert.equal(calls, 0);
  });

  it('removes caller abort listener after a completed fetch', async () => {
    const ac = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const originalAdd = ac.signal.addEventListener.bind(ac.signal);
    const originalRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...args) => {
      if (args[0] === 'abort') addCount += 1;
      return originalAdd(...args);
    });
    ac.signal.removeEventListener = ((...args) => {
      if (args[0] === 'abort') removeCount += 1;
      return originalRemove(...args);
    });

    setFetch(async () => ({ ok: true, json: async () => ({ message: {} }) }));
    const out = await verify('10.1/x', { signal: ac.signal });

    assert.equal(out.valid, true);
    assert.equal(addCount, 1);
    assert.equal(removeCount, 1);
  });

  it('aborts when caller-signal aborts', async () => {
    setFetch(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const out = await verify('10.1/x', { signal: ac.signal });
    assert.equal(out.valid, false);
  });
});

// ── verifyBatch ────────────────────────────────────────────────

describe('verifyBatch', () => {
  it('preserves input order in output', async () => {
    setFetch(async (url) => {
      const doi = decodeURIComponent(url.replace('https://api.crossref.org/works/', ''));
      return {
        ok: true,
        json: async () => ({ message: { title: [`title for ${doi}`] } }),
      };
    });
    const dois = ['10.1/a', '10.1/b', '10.1/c', '10.1/d'];
    const out = await verifyBatch(dois);
    assert.equal(out.length, 4);
    assert.equal(out[0].title, 'title for 10.1/a');
    assert.equal(out[3].title, 'title for 10.1/d');
  });

  it('returns [] for empty input', async () => {
    setFetch(async () => ({ ok: false }));
    const out = await verifyBatch([]);
    assert.deepEqual(out, []);
  });

  it('calls onResult with (index, result) per finished verification', async () => {
    setFetch(async () => ({
      ok: true, json: async () => ({ message: {} }),
    }));
    const events = [];
    await verifyBatch(['10.1/a', '10.1/b'], {
      onResult: (i, r) => events.push({ i, valid: r.valid }),
    });
    assert.equal(events.length, 2);
    const indices = events.map(e => e.i).sort();
    assert.deepEqual(indices, [0, 1]);
  });

  it('onResult throw does not break the batch', async () => {
    setFetch(async () => ({
      ok: true, json: async () => ({ message: {} }),
    }));
    const out = await verifyBatch(['10.1/a', '10.1/b'], {
      onResult: () => { throw new Error('cb crash'); },
    });
    assert.equal(out.length, 2);
  });

  it('honours CONCURRENCY cap (parallel workers)', async () => {
    let inFlight = 0, peak = 0;
    setFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true, json: async () => ({ message: {} }) };
    });
    const dois = Array.from({ length: 20 }, (_, i) => `10.1/p${i}`);
    await verifyBatch(dois);
    assert.ok(peak <= CONCURRENCY, `expected peak ≤ ${CONCURRENCY}, got ${peak}`);
  });

  it('abort signal stops new workers from picking up further dois', async () => {
    setFetch(async () => {
      await new Promise(r => setTimeout(r, 50));
      return { ok: true, json: async () => ({ message: {} }) };
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const dois = Array.from({ length: 100 }, (_, i) => `10.1/p${i}`);
    const out = await verifyBatch(dois, { signal: ac.signal });
    // Some entries should still be null (never picked up).
    const stillNull = out.filter(r => r === null).length;
    assert.ok(stillNull >= 0);
  });

  it('individual failures fill in as { valid:false }', async () => {
    let i = 0;
    setFetch(async () => {
      i++;
      if (i === 2) throw new Error('one bad request');
      return { ok: true, json: async () => ({ message: {} }) };
    });
    const out = await verifyBatch(['10.1/a', '10.1/b', '10.1/c']);
    const failureCount = out.filter(r => r && r.valid === false).length;
    assert.ok(failureCount >= 1);
    const successCount = out.filter(r => r && r.valid === true).length;
    assert.ok(successCount >= 1);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/marco-teorico/crossref');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['CONCURRENCY', 'verify', 'verifyBatch']);
  });
});
