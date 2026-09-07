'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { runWebFetch, isPrivateIp, blockedHost, MAX_BYTES } = require('../src/services/sira-code/webfetch');

const publicRecords = [{ address: '93.184.216.34', family: 4 }];
const fixtureUrl = 'https://docs.example/page';
const response = (body, status = 200, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name] || null }, body,
  arrayBuffer() { throw new Error('unbounded arrayBuffer must never be used'); },
  text() { throw new Error('unbounded text must never be used'); },
});
const connect = (options, host = 'docs.example', all = true) => new Promise((resolve, reject) => {
  assert.equal(typeof options.agent.options.lookup, 'function');
  options.agent.options.lookup(host, { all }, (err, address, family) => {
    if (err) reject(err);
    else resolve(all ? address : [{ address, family }]);
  });
});
const transport = (onConnect = () => {}) => async (href, options) => {
  const addresses = await connect(options, new URL(href).hostname);
  onConnect(addresses, options);
  return response(Readable.from(['hola']));
};

test('canonical IP policy blocks private/reserved IPv4 and IPv6 spellings', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '224.0.0.1', '::', '::1', 'fe90::1', 'febf::1', 'fd00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:c0a8:101', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  for (const host of ['[::ffff:7f00:1]', 'localhost.', 'x.internal.', 'metadata.goog']) assert.equal(blockedHost(host), true, host);
});

test('literal private URLs are rejected before any transport call', async () => {
  let calls = 0;
  for (const url of ['https://[::ffff:7f00:1]/', 'https://[fe90::1]/', 'http://127.0.0.1/']) {
    const out = await runWebFetch({ url }, { fetch: async () => { calls += 1; } });
    assert.equal(out.code, 'url_blocked');
  }
  assert.equal(calls, 0);
});

test('the actual connection lookup uses validated addresses without a second resolution', async () => {
  let lookups = 0;
  let connected;
  const out = await runWebFetch({ url: fixtureUrl }, {
    lookup: async () => (++lookups === 1 ? publicRecords : [{ address: '127.0.0.1', family: 4 }]),
    fetch: transport((addresses) => { connected = addresses; }),
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(lookups, 1);
  assert.deepEqual(connected, publicRecords);
});

test('connection lookup supports Node all=false and preserves hostname for TLS/Host', async () => {
  const out = await runWebFetch({ url: fixtureUrl }, {
    lookup: async () => publicRecords,
    fetch: async (href, options) => {
      assert.equal(href, fixtureUrl);
      assert.deepEqual(await connect(options, 'docs.example', false), publicRecords);
      assert.equal(options.agent.options.rejectUnauthorized, undefined);
      return response(Readable.from(['ok']));
    },
  });
  assert.equal(out.ok, true, out.error);
});

test('mixed, invalid and empty DNS results fail closed before connecting', async () => {
  for (const records of [[...publicRecords, { address: '::ffff:a00:1', family: 6 }], [], [{ address: 'invalid' }]]) {
    let connected = false;
    const out = await runWebFetch({ url: fixtureUrl }, {
      lookup: async () => records,
      fetch: transport(() => { connected = true; }),
    });
    assert.equal(out.ok, false);
    assert.equal(connected, false);
    assert.match(out.error, /host|resolvió/);
  }
});

test('stream cap ignores Content-Length and cancels without consuming the full response', async () => {
  for (const contentLength of [null, '1']) {
    let produced = 0;
    let closed = false;
    const body = new ReadableStream({
      pull(controller) { produced += 1; controller.enqueue(new Uint8Array(40_000).fill(97)); },
      cancel() { closed = true; },
    }, { highWaterMark: 0 });
    const out = await runWebFetch({ url: fixtureUrl }, {
      fetch: async () => response(body, 200, { 'content-length': contentLength }),
    });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.content.length, MAX_BYTES);
    assert.equal(out.truncated, true);
    assert.equal(produced, 5);
    assert.equal(closed, true);
  }
});

test('one large Node chunk is sliced, never retained as an unbounded result, and destroyed', async () => {
  const body = Readable.from([Buffer.alloc(MAX_BYTES * 5, 97)]);
  const out = await runWebFetch({ url: fixtureUrl }, { fetch: async () => response(body) });
  assert.equal(out.content.length, MAX_BYTES);
  assert.equal(out.truncated, true);
  assert.equal(body.destroyed, true);
});

test('UTF-8 split at the cap does not emit an expanded replacement character', async () => {
  const bytes = Buffer.concat([Buffer.alloc(MAX_BYTES - 1, 97), Buffer.from('€ trailing')]);
  const out = await runWebFetch({ url: fixtureUrl }, { fetch: async () => new Response(bytes) });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.content.includes('�'), false);
  assert.ok(Buffer.byteLength(out.content) <= MAX_BYTES);
  assert.equal(out.truncated, true);
});

test('small UTF-8 chunks and existing HTTP-to-HTTPS/HTML contract remain intact', async () => {
  const bytes = Buffer.from('<p>Hola €</p>');
  const out = await runWebFetch({ url: 'http://docs.example/page' }, {
    fetch: async (href) => {
      assert.equal(href, fixtureUrl);
      return response(Readable.from([...bytes].map((byte) => Buffer.from([byte]))), 200, { 'content-type': 'text/html' });
    },
  });
  assert.equal(out.content, 'Hola €');
  assert.equal(out.truncated, false);
});

test('redirect to a private literal is blocked before a second request and first body is cancelled', async () => {
  let requests = 0;
  let cancelled = false;
  const out = await runWebFetch({ url: fixtureUrl }, {
    fetch: async () => {
      requests += 1;
      return response(new ReadableStream({ cancel() { cancelled = true; } }), 302, { location: 'https://[::ffff:7f00:1]/' });
    },
  });
  assert.equal(out.code, 'url_blocked');
  assert.equal(requests, 1);
  assert.equal(cancelled, true);
});

test('redirect DNS is checked at each connection and shares one AbortSignal', async () => {
  const signals = [];
  let connected = 0;
  const out = await runWebFetch({ url: fixtureUrl }, {
    lookup: async (host) => host === 'docs.example' ? publicRecords : [{ address: '169.254.169.254', family: 4 }],
    fetch: async (href, options) => {
      signals.push(options.signal);
      await connect(options, new URL(href).hostname);
      connected += 1;
      return response(Readable.from([]), 302, { location: 'https://other.example/' });
    },
  });
  assert.equal(out.code, 'url_blocked');
  assert.equal(connected, 1);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test('concurrent calls keep their injected transports isolated', async () => {
  const [a, b] = await Promise.all(['A', 'B'].map((name) => runWebFetch({ url: fixtureUrl }, {
    fetch: async () => new Response(name),
  })));
  assert.equal(a.content, 'A');
  assert.equal(b.content, 'B');
});

test('Stop cancels a stalled Web body and gives a Spanish cancellation result', async () => {
  const controller = new AbortController();
  let cancelCalled = false;
  const body = new ReadableStream({
    pull() { controller.abort(); },
    cancel() { cancelCalled = true; },
  }, { highWaterMark: 0 });
  const out = await runWebFetch({ url: fixtureUrl }, { signal: controller.signal, fetch: async () => response(body) });
  assert.equal(out.code, 'E_CANCELLED');
  assert.match(out.error, /cancelada/);
  assert.equal(cancelCalled, true);
});

test('already-cancelled request never starts transport', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const out = await runWebFetch({ url: fixtureUrl }, { signal: controller.signal, fetch: async () => { calls += 1; } });
  assert.equal(out.code, 'E_CANCELLED');
  assert.equal(calls, 0);
});

test('one deadline covers stalled DNS and late DNS completion cannot connect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completeDns;
  let startedDns;
  const dnsStarted = new Promise((resolve) => { startedDns = resolve; });
  let connected = false;
  const pending = runWebFetch({ url: fixtureUrl }, {
    lookup: () => { startedDns(); return new Promise((resolve) => { completeDns = resolve; }); },
    fetch: transport(() => { connected = true; }),
  });
  await dnsStarted;
  t.mock.timers.tick(8_000);
  const out = await pending;
  assert.equal(out.code, 'timeout');
  assert.match(out.error, /tiempo/);
  completeDns(publicRecords);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(connected, false);
});

test('deadline covers stalled body and destroys Node stream', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const body = new Readable({ read() { began(); } });
  const pending = runWebFetch({ url: fixtureUrl }, { fetch: async () => response(body) });
  await started;
  t.mock.timers.tick(8_000);
  const out = await pending;
  assert.equal(out.code, 'timeout');
  assert.equal(body.destroyed, true);
});

test('unknown network diagnostics stay private and failures remain Spanish', async () => {
  const out = await runWebFetch({ url: fixtureUrl }, { fetch: async () => { throw new Error('private transport diagnostics'); } });
  assert.equal(out.code, 'fetch_failed');
  assert.match(out.error, /no se pudo completar/);
  assert.equal(JSON.stringify(out).includes('private transport diagnostics'), false);
});

test('missing body fails closed except for an explicitly empty response', async () => {
  const missing = await runWebFetch({ url: fixtureUrl }, { fetch: async () => response(null) });
  assert.equal(missing.ok, false);
  const empty = await runWebFetch({ url: fixtureUrl }, { fetch: async () => response(null, 204) });
  assert.equal(empty.ok, true);
  assert.equal(empty.content, '');
});

test('real node-fetch decompresses gzip under the stream cap with a simulated HTTPS request', async (t) => {
  const https = require('node:https');
  const { Writable } = require('node:stream');
  const { gzipSync } = require('node:zlib');
  const fetch = require('node-fetch');
  const compressed = gzipSync(Buffer.alloc(MAX_BYTES * 5, 97));
  let decodedBody;
  let connected;
  t.mock.method(https, 'request', (options) => {
    const req = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    req.abort = () => req.destroy();
    req.once('finish', () => {
      options.agent.options.lookup(options.hostname, { all: true }, (err, addresses) => {
        if (err) { req.emit('error', err); return; }
        connected = addresses;
        const incoming = Readable.from([compressed]);
        incoming.statusCode = 200;
        incoming.statusMessage = 'OK';
        incoming.headers = { 'content-encoding': 'gzip', 'content-type': 'text/plain', 'content-length': String(compressed.length) };
        req.emit('response', incoming);
      });
    });
    return req;
  });
  const out = await runWebFetch({ url: fixtureUrl }, {
    lookup: async () => publicRecords,
    fetch: async (...args) => {
      const result = await fetch(...args);
      decodedBody = result.body;
      return result;
    },
  });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(connected, publicRecords);
  assert.ok(compressed.length < MAX_BYTES);
  assert.equal(out.content.length, MAX_BYTES);
  assert.equal(out.truncated, true);
  assert.equal(decodedBody.destroyed, true);
});
