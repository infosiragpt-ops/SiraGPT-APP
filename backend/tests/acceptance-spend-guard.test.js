'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAcceptanceSpendGuard, isAcceptanceSpendError, ENDPOINT,
  MAX_TOTAL_MICROS, ONE_USD_MICROS, MAX_OUTPUT_TOKENS } = require('../src/services/ai/acceptance-spend-guard');
const { fixture, IDENTITY, NOW, request, quota } = require('./helpers/acceptance-spend-fixture');

// Unit-only coverage: SDK wire format and child-process lifecycle cases
// execute separately in acceptance-spend-integration.test.js.

test('no campaign is off and preserves original transport arguments and values', async () => {
  const guard = createAcceptanceSpendGuard();
  const input = { arbitrary: true };
  const init = { arbitrary: 'unchanged' };
  const result = {};
  const send = guard.guardedFetch((actualInput, actualInit) => {
    assert.equal(actualInput, input);
    assert.equal(actualInit, init);
    assert.equal(guard.isActive(), false);
    return result;
  });
  assert.equal(await guard.withAcceptanceScope(IDENTITY, () => send(input, init)), result);
  assert.equal(guard.denyUnbudgetedOperation(), undefined);
  assert.deepEqual(guard.status(), { configured: false, active: false });
  assert.throws(() => guard.guardedFetch(null), TypeError);
  assert.throws(() => guard.withAcceptanceScope(IDENTITY, null), TypeError);
});

test('only server user and chat binding activates scope and preserves unrelated traffic', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  const init = {};
  const send = guard.guardedFetch((input, actualInit) => {
    assert.equal(input, 'not-an-accredited-url');
    assert.equal(actualInit, init);
  });
  for (const identity of [null, {}, { ...IDENTITY, userId: 'another-user' }, { ...IDENTITY, chatId: 'another-chat' }]) {
    await guard.withAcceptanceScope(identity, () => send('not-an-accredited-url', init));
  }
  guard.middleware.bind({ user: { id: IDENTITY.userId }, body: { chatId: IDENTITY.chatId } }, {}, () => {
    assert.equal(guard.isActive(), true);
    assert.throws(() => guard.denyUnbudgetedOperation(), quota('operation_denied'));
    assert.throws(() => guard.withAcceptanceScope({}, () => {}), quota('operation_denied'));
    guard.withAcceptanceScope(IDENTITY, () => assert.equal(guard.isActive(), true));
  });
  guard.middleware.bind({ body: { chatId: IDENTITY.chatId, userId: IDENTITY.userId } }, {}, () => {
    assert.equal(guard.isActive(), false);
  });
  assert.equal(guard.isActive(), false);
  assert.equal(f.read().usedMicros, 0);
});

test('ALS stays bound in detached background work after response callback returns', async (t) => {
  const guard = fixture(t).create();
  let resolve;
  const background = new Promise((done) => { resolve = done; });
  guard.withAcceptanceScope(IDENTITY, () => {
    setImmediate(() => {
      assert.equal(guard.isActive(), true);
      assert.throws(() => guard.denyUnbudgetedOperation(), quota('operation_denied'));
      resolve();
    });
  });
  assert.equal(guard.isActive(), false);
  await background;
  assert.equal(guard.isActive(), false);
});

test('concurrent ALS scopes do not charge an unrelated request', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const bound = guard.withAcceptanceScope(IDENTITY, async () => {
    await barrier;
    assert.equal(guard.isActive(), true);
    await guard.guardedFetch(async () => 'scoped')(ENDPOINT, request());
  });
  await guard.withAcceptanceScope({ ...IDENTITY, userId: 'unrelated' }, async () => {
    assert.equal(guard.isActive(), false);
    await guard.guardedFetch(async () => 'unrelated')('unrestricted', {});
    release();
  });
  await bound;
  assert.equal(f.read().usedMicros, ONE_USD_MICROS);
});

test('reserves one durable dollar before every physical send, never more than five total', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  const second = f.create();
  let sends = 0;
  const input = request({ max_tokens: MAX_OUTPUT_TOKENS, stream: true, stream_options: { include_usage: true } });
  input.redirect = 'follow';
  input.headers = { 'Content-Type': 'application/json' };
  const transport = async (url, init) => {
    sends += 1;
    assert.equal(url, ENDPOINT);
    assert.equal(f.read().usedMicros, sends * ONE_USD_MICROS);
    assert.equal(fs.existsSync(`${f.ledgerPath}.lock`), false);
    assert.equal(fs.statSync(f.ledgerPath).mode & 0o777, 0o600);
    assert.deepEqual(init, { ...input, redirect: 'error' });
    assert.equal(init.headers, input.headers);
    return sends;
  };
  for (let count = 0; count < 5; count += 1) {
    const current = count % 2 ? second : guard;
    assert.equal(await current.withAcceptanceScope(IDENTITY, () => current.guardedFetch(transport)(ENDPOINT, input)), count + 1);
  }
  await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(transport)(ENDPOINT, input)), quota('budget_exhausted'));
  assert.equal(input.redirect, 'follow');
  assert.equal(sends, 5);
  assert.equal(fs.existsSync(`${f.ledgerPath}.lock`), false);
  assert.equal(guard.status().available, false);
  assert.deepEqual(f.read().reservations.map((item) => item.sequence), [1, 2, 3, 4, 5]);
  const publicStatus = JSON.stringify(guard.status());
  assert.doesNotMatch(publicStatus, /synthetic|campaignId|userId|chatId|ledgerPath|pricing|expiresAt/);
});

test('valid text, function tools and tool results pass unchanged, without hosted tools', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  const init = request({ n: 1, temperature: 0, top_p: 1, reasoning_effort: 'high', parallel_tool_calls: false,
    messages: [
      { role: 'system', content: 'Synthetic system.' },
      { role: 'user', name: 'user', content: [{ type: 'text', text: 'A board.' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function',
        function: { name: 'write_file', arguments: '{"name":"chess.html"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Saved.' },
    ], tools: [{ type: 'function', function: { name: 'write_file', description: 'Synthetic fixture',
      parameters: { type: 'object', properties: { name: { type: 'string' } } }, strict: false } }],
    tool_choice: { type: 'function', function: { name: 'write_file' } },
  });
  await guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(async (_input, actual) => {
    assert.equal(actual.body, init.body);
    assert.equal(actual.redirect, 'error');
  })(ENDPOINT, init));
  await guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(async () => {})(ENDPOINT, request({
    tools: [{ type: 'function', function: { name: 'noop' } }], tool_choice: 'none',
  })));
  assert.equal(f.read().reservations.length, 2);
});

const invalidBodies = [
  ['other model', { model: 'unaccredited-model' }], ['missing output limit', { max_tokens: undefined }],
  ['negative output limit', { max_tokens: -1 }], ['zero output limit', { max_tokens: 0 }],
  ['fractional output limit', { max_tokens: 1.5 }], ['oversized output limit', { max_tokens: MAX_OUTPUT_TOKENS + 1 }],
  ['string output limit', { max_tokens: '1024' }], ['unknown parameter', { host_tools: [] }],
  ['multiple completions', { n: 2 }], ['wrong stream type', { stream: 'true' }],
  ['wrong parallel tools type', { parallel_tool_calls: 1 }], ['negative temperature', { temperature: -0.1 }],
  ['excessive temperature', { temperature: 2.1 }], ['wrong temperature type', { temperature: '1' }],
  ['invalid top p', { top_p: 1.1 }], ['wrong reasoning', { reasoning_effort: 'unbounded' }],
  ['unknown stream option', { stream_options: { include_usage: true, audio: true } }],
  ['wrong stream usage type', { stream_options: { include_usage: 1 } }],
  ['no messages', { messages: [] }], ['messages object', { messages: {} }],
  ['too many messages', { messages: Array(1025).fill({ role: 'user', content: '' }) }],
  ['unknown role', { messages: [{ role: 'hosted', content: '' }] }],
  ['unknown message property', { messages: [{ role: 'user', content: '', images: [] }] }],
  ['invalid message name', { messages: [{ role: 'user', name: '', content: '' }] }],
  ['invalid tool call id', { messages: [{ role: 'tool', tool_call_id: '', content: '' }] }],
  ['image input', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://invalid.local' } }] }] }],
  ['audio input', { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }],
  ['non-string text', { messages: [{ role: 'user', content: [{ type: 'text', text: 1 }] }] }],
  ['too many text parts', { messages: [{ role: 'user', content: Array(1025).fill({ type: 'text', text: '' }) }] }],
  ['null user content', { messages: [{ role: 'user', content: null }] }],
  ['null assistant without tools', { messages: [{ role: 'assistant', content: null }] }],
  ['malformed tool calls', { messages: [{ role: 'assistant', content: '', tool_calls: {} }] }],
  ['invalid function arguments', { messages: [{ role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'test', arguments: {} } },
  ] }] }],
  ['hosted tool call', { messages: [{ role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'web_search', function: { name: 'test', arguments: '{}' } },
  ] }] }],
  ['too many tool calls', { messages: [{ role: 'assistant', content: '', tool_calls: Array(129).fill({}) }] }],
  ['hosted tools', { tools: [{ type: 'web_search' }] }], ['tools object', { tools: {} }],
  ['too many tools', { tools: Array(129).fill({}) }],
  ['invalid function name', { tools: [{ type: 'function', function: { name: '' } }] }],
  ['invalid function description', { tools: [{ type: 'function', function: { name: 'test', description: 1 } }] }],
  ['invalid function schema', { tools: [{ type: 'function', function: { name: 'test', parameters: [] } }] }],
  ['invalid function strict', { tools: [{ type: 'function', function: { name: 'test', strict: 'false' } }] }],
  ['unknown function parameter', { tools: [{ type: 'function', function: { name: 'test', hosted: true } }] }],
  ['invalid tool choice string', { tool_choice: 'hosted' }],
  ['invalid tool choice type', { tool_choice: { type: 'web_search', function: { name: 'test' } } }],
  ['invalid tool choice function', { tool_choice: { type: 'function', function: { name: '' } } }],
];

test('all non-accredited body variants deny before reserving or I/O', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  let sends = 0;
  const send = guard.guardedFetch(async () => { sends += 1; });
  for (const [label, body] of invalidBodies) {
    await t.test(label, async () => {
      await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => send(ENDPOINT, request(body))), quota('operation_denied'));
    });
  }
  for (const body of ['{', 'null', '[]', '1', JSON.stringify({ content: 'x'.repeat(1_000_001) })]) {
    await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => send(ENDPOINT, { method: 'POST', body })), quota('operation_denied'));
  }
  assert.equal(sends, 0);
  assert.equal(f.read().usedMicros, 0);
});

test('exact endpoint, POST and immutable JSON string body are mandatory', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  const send = guard.guardedFetch(async () => assert.fail('unaccredited transport called'));
  for (const url of [ENDPOINT + '?x=1', ENDPOINT + '#fragment', ENDPOINT + '/', ENDPOINT.replace('https:', 'http:'),
    ENDPOINT.replace('api.meta.ai', 'api.other.invalid'), new URL(ENDPOINT), new Request(ENDPOINT), undefined]) {
    await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => send(url, request())), quota('operation_denied'));
  }
  for (const init of [undefined, null, [], { ...request(), method: 'GET' }, { ...request(), method: 'post' },
    { ...request(), body: {} }, { ...request(), body: Buffer.from('{}') }]) {
    await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => send(ENDPOINT, init)), quota('operation_denied'));
  }
  assert.equal(f.read().usedMicros, 0);
});

test('transport errors, SDK retries, cancellation and uncertain outcomes never refund', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  const providerError = new Error('synthetic transport error');
  let sends = 0;
  const send = guard.guardedFetch(async () => { sends += 1; throw providerError; });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => send(ENDPOINT, request())), (error) => error === providerError);
  }
  const controller = new AbortController();
  await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(async () => {
    sends += 1;
    controller.abort();
    throw new DOMException('synthetic abort', 'AbortError');
  })(ENDPOINT, { ...request(), signal: controller.signal })), { name: 'AbortError' });
  await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => send(ENDPOINT, { ...request(), signal: controller.signal })), quota('operation_cancelled'));
  guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(() => { sends += 1; return new Promise(() => {}); })(ENDPOINT, request()));
  assert.equal(sends, 4);
  assert.equal(f.read().usedMicros, 4 * ONE_USD_MICROS);
});

test('cancellation during durable reservation keeps the reserve without calling transport', async (t) => {
  const controller = new AbortController();
  let syncs = 0;
  const disk = { ...fs, fsyncSync(fd) { fs.fsyncSync(fd); if (++syncs === 4) controller.abort(); } };
  const f = fixture(t, { fsImpl: disk });
  const guard = f.create();
  await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(() => assert.fail('called after cancel'))(
    ENDPOINT, { ...request(), signal: controller.signal })), quota('operation_cancelled'));
  assert.equal(f.read().usedMicros, ONE_USD_MICROS);
});

test('campaign identity stays cached and expired or unverified pricing never becomes an off switch', async (t) => {
  const f = fixture(t);
  const guard = f.create({ clock: () => NOW + 3_600_000 });
  f.write(f.policyFile, { ...f.policy, chatId: 'changed-on-disk' });
  await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(() => assert.fail('expired called'))(ENDPOINT, request())), quota('campaign_expired'));
  assert.equal(guard.status().available, false);
  const unverified = fixture(t);
  unverified.write(unverified.policyFile, { ...unverified.policy, pricing: { ...unverified.policy.pricing, verified: false } });
  const unverifiedGuard = unverified.create();
  await assert.rejects(unverifiedGuard.withAcceptanceScope(IDENTITY, () => unverifiedGuard.guardedFetch(() => assert.fail('unverified called'))(ENDPOINT, request())), quota('pricing_unverified'));
  assert.equal(unverifiedGuard.status().available, false);
  const invalidClock = unverified.create({ clock: () => NaN });
  assert.equal(invalidClock.status().available, false);
  const badClock = f.create({ clock: () => NaN });
  await assert.rejects(badClock.withAcceptanceScope({ ...IDENTITY, chatId: 'changed-on-disk' }, () => badClock.guardedFetch(() => assert.fail('bad clock'))(ENDPOINT, request())), quota('campaign_expired'));
  assert.equal(f.read().usedMicros, 0);
});

test('invalid private policies fail closed at startup, including negative or unaccredited prices', async (t) => {
  const changes = [{ version: 2 }, { campaignId: '' }, { userId: null }, { chatId: '' },
    { expiresAt: 'not-a-date' }, { ledgerPath: 'relative.json' }, { maxTotalMicros: 5_000_001 },
    { maxTotalMicros: 999_999 }, { reservationMicros: 999_999 }, { unexpected: true },
    { pricing: {} }, { pricing: { verified: true, inputMicrosPerMillion: -1, outputMicrosPerMillion: 1,
      inputTokenCeiling: 1_048_576, outputTokenCeiling: 16_384 } }];
  for (const change of changes) {
    const f = fixture(t, { policyChanges: change });
    assert.throws(() => f.create(), quota('policy_invalid'));
  }
  for (const pricing of [{ verified: 'true' }, { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
    { inputMicrosPerMillion: 1_000_000 }, { outputMicrosPerMillion: 61_035_157 },
    { inputMicrosPerMillion: 0.5 }, { inputTokenCeiling: 1_000_000 }, { outputTokenCeiling: 1_000_000 },
    { inputTokenCeiling: 1_048_575 }, { inputTokenCeiling: 1_048_577 }, { outputTokenCeiling: 16_383 },
    { outputTokenCeiling: 16_385 }, { unknown: true }]) {
    const f = fixture(t);
    f.write(f.policyFile, { ...f.policy, pricing: { ...f.policy.pricing, ...pricing } });
    assert.throws(() => f.create(), quota('policy_invalid'));
  }
  assert.throws(() => createAcceptanceSpendGuard({ policyFile: 'relative.json' }), quota('policy_invalid'));
  const missing = fixture(t);
  fs.unlinkSync(missing.policyFile);
  assert.throws(() => missing.create(), quota('policy_invalid'));
  assert.equal(fs.existsSync(missing.policyFile), false);
});

test('accredited context and output ceiling use exact separately rounded integer costs', (t) => {
  const cases = [
    [100_000, 200_000, true],
    [953_674, 0, true],
    [953_675, 0, false],
    [1, 61_035_034, true],
    [1, 61_035_035, false],
    [Number.MAX_SAFE_INTEGER, 0, false],
    [0, Number.MAX_SAFE_INTEGER, false],
    [Number.MAX_SAFE_INTEGER + 1, 0, false],
  ];
  for (const [inputMicrosPerMillion, outputMicrosPerMillion, accepted] of cases) {
    const f = fixture(t);
    f.write(f.policyFile, { ...f.policy, pricing: { ...f.policy.pricing,
      inputTokenCeiling: 1_048_576, outputTokenCeiling: 16_384,
      inputMicrosPerMillion, outputMicrosPerMillion } });
    if (accepted) assert.equal(f.create().status().available, true);
    else assert.throws(() => f.create(), quota('policy_invalid'));
  }
});

test('policy and ledger must be private regular files in a protected directory', (t) => {
  for (const target of ['policyFile', 'ledgerPath']) {
    const f = fixture(t);
    fs.chmodSync(f[target], 0o644);
    assert.throws(() => f.create(), quota(target === 'policyFile' ? 'policy_invalid' : 'ledger_unavailable'));
  }
  for (const kind of ['symlink', 'hardlink', 'oversized', 'directory']) {
    const f = fixture(t);
    const original = path.join(f.directory, 'original.json');
    fs.renameSync(f.ledgerPath, original);
    if (kind === 'symlink') fs.symlinkSync(original, f.ledgerPath);
    if (kind === 'hardlink') fs.linkSync(original, f.ledgerPath);
    if (kind === 'oversized') fs.writeFileSync(f.ledgerPath, ' '.repeat(16_385), { mode: 0o600 });
    if (kind === 'directory') fs.mkdirSync(f.ledgerPath, { mode: 0o700 });
    assert.throws(() => f.create(), quota('ledger_unavailable'));
  }
  const unsafe = fixture(t);
  fs.chmodSync(unsafe.directory, 0o777);
  assert.throws(() => unsafe.create(), quota('policy_invalid'));
  const same = fixture(t);
  same.write(same.policyFile, { ...same.policy, ledgerPath: same.policyFile });
  assert.throws(() => same.create(), quota('policy_invalid'));
});

test('missing or corrupt ledger never autocreates or resets balance, at startup or after boot', async (t) => {
  const f = fixture(t);
  const guard = f.create();
  await guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(async () => {})(ENDPOINT, request()));
  fs.unlinkSync(f.ledgerPath);
  assert.throws(() => f.create(), quota('ledger_unavailable'));
  assert.equal(fs.existsSync(f.ledgerPath), false);
  await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(() => assert.fail('missing ledger send'))(ENDPOINT, request())), quota('ledger_unavailable'));
  assert.equal(fs.existsSync(f.ledgerPath), false);
  assert.equal(fs.existsSync(`${f.ledgerPath}.lock`), true);
  assert.deepEqual(guard.status(), { configured: true, active: false, available: false });
  for (const change of [{ version: 2 }, { campaignId: 'other' }, { maxTotalMicros: 4_000_000 },
    { reservationMicros: 1 }, { usedMicros: -1 }, { usedMicros: 1_000_000 }, { reservations: {} },
    { reservations: Array(6).fill({}) }, { unexpected: true },
    { usedMicros: 1_000_000, reservations: [{ sequence: 2, reservedMicros: 1_000_000, atMs: NOW }] },
    { usedMicros: 1_000_000, reservations: [{ sequence: 1, reservedMicros: 2, atMs: NOW }] },
    { usedMicros: 1_000_000, reservations: [{ sequence: 1, reservedMicros: 1_000_000, atMs: -1 }] }]) {
    const invalid = fixture(t, { ledgerChanges: change });
    assert.throws(() => invalid.create(), quota('ledger_unavailable'));
  }
  const corrupt = fixture(t);
  fs.writeFileSync(corrupt.ledgerPath, '{');
  assert.throws(() => corrupt.create(), quota('ledger_unavailable'));
});

test('durability failures prevent I/O and keep uncertain reservations or crash locks', async (t) => {
  for (const fault of ['lock-sync', 'temp-write', 'temp-sync', 'rename', 'ledger-directory-sync', 'unlock', 'unlock-directory-sync', 'lock-close']) {
    await t.test(fault, async (st) => {
      let syncs = 0;
      let lockFd;
      const disk = { ...fs,
        openSync(filename, ...args) {
          const fd = fs.openSync(filename, ...args);
          if (String(filename).endsWith('.lock')) lockFd = fd;
          return fd;
        },
        fsyncSync(fd) {
          syncs += 1;
          if ((fault === 'lock-sync' && syncs === 1) || (fault === 'temp-sync' && syncs === 2)
            || (fault === 'ledger-directory-sync' && syncs === 3) || (fault === 'unlock-directory-sync' && syncs === 4)) throw new Error('synthetic fsync failure');
          return fs.fsyncSync(fd);
        },
        writeFileSync(...args) { if (fault === 'temp-write') throw new Error('synthetic write failure'); return fs.writeFileSync(...args); },
        renameSync(...args) { if (fault === 'rename') throw new Error('synthetic rename failure'); return fs.renameSync(...args); },
        unlinkSync(...args) { if (fault === 'unlock') throw new Error('synthetic unlink failure'); return fs.unlinkSync(...args); },
        closeSync(fd) {
          fs.closeSync(fd);
          if (fault === 'lock-close' && fd === lockFd) throw new Error('synthetic close failure');
        },
      };
      const f = fixture(st, { fsImpl: disk });
      const guard = f.create();
      await assert.rejects(guard.withAcceptanceScope(IDENTITY, () => guard.guardedFetch(() => assert.fail('uncertain durability send'))(ENDPOINT, request())), quota('ledger_unavailable'));
      assert.equal(fs.existsSync(`${f.ledgerPath}.lock`), fault !== 'unlock-directory-sync');
      assert.equal(f.read().usedMicros, ['lock-sync', 'temp-write', 'temp-sync', 'rename'].includes(fault) ? 0 : ONE_USD_MICROS);
    });
  }
});

test('SDK wrapped terminal quota is recognized without parsing messages or looping on causes', () => {
  assert.equal(isAcceptanceSpendError(undefined), false);
  assert.equal(isAcceptanceSpendError(new Error('E_QUOTA')), false);
  const cyclic = new Error('cycle');
  cyclic.cause = cyclic;
  assert.equal(isAcceptanceSpendError(cyclic), false);
  const quotaError = Object.assign(new Error('safe'), { acceptanceSpendGuard: true, code: 'E_QUOTA' });
  assert.equal(isAcceptanceSpendError(new Error('SDK wrapper', { cause: quotaError })), true);
  let tooDeep = quotaError;
  for (let index = 0; index < 9; index += 1) tooDeep = new Error('SDK wrapper', { cause: tooDeep });
  assert.equal(isAcceptanceSpendError(tooDeep), false);
});
