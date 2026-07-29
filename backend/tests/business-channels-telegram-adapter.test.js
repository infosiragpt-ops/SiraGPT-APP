'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAdapter,
  validateInboxMessage,
} = require('../src/services/business-channels/adapter-contract');
const {
  createTelegramAdapter,
  TelegramApiError,
  MAX_TEXT_LENGTH,
} = require('../src/services/business-channels/adapters/telegram');
const {
  getAdapter,
  listAdapterKinds,
  registerAdapter,
  gateAndNormalize,
} = require('../src/services/business-channels/registry');
const { createPairingService } = require('../src/services/business-channels/pairing');

const TOKEN = '123456:TEST-secret-token';

/** Realistic Bot API webhook update (shape from api.telegram.org docs). */
function telegramUpdate(overrides = {}) {
  return {
    update_id: 726381923,
    message: {
      message_id: 42,
      from: { id: 987654321, is_bot: false, first_name: 'Ada', username: 'ada_l' },
      chat: { id: 987654321, first_name: 'Ada', username: 'ada_l', type: 'private' },
      date: 1_753_800_000,
      text: 'hola, ¿estado del pedido 118?',
      ...overrides,
    },
  };
}

function jsonResponse({ ok = true, status = 200, body = { ok: true, result: {} } } = {}) {
  return { ok, status, json: async () => body };
}

/** fetch mock that records calls and replies from a scripted queue. */
function makeFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

test('contract: telegram adapter conforms; broken objects are itemised', () => {
  const adapter = createTelegramAdapter();
  assert.deepEqual(validateAdapter(adapter), { ok: true, errors: [] });

  const broken = validateAdapter({ kind: '', receive: 1 });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((e) => e.includes('kind')));
  assert.ok(broken.errors.some((e) => e.includes('receive')));
  assert.ok(broken.errors.some((e) => e.includes('send')));
  assert.ok(broken.errors.some((e) => e.includes('verifyConfig')));
  assert.equal(validateAdapter(null).ok, false);
});

test('receive: normalises a real webhook message into the canonical InboxMessage', () => {
  const adapter = createTelegramAdapter();
  const update = telegramUpdate();
  const msg = adapter.receive(update);

  assert.deepEqual(validateInboxMessage(msg), { ok: true, errors: [] });
  assert.equal(msg.channelKind, 'telegram');
  assert.equal(msg.externalId, '42');
  assert.equal(msg.from, '987654321');
  assert.equal(msg.text, 'hola, ¿estado del pedido 118?');
  assert.equal(msg.ts, 1_753_800_000 * 1000);
  assert.equal(msg.threadId, '987654321');
  assert.equal(msg.raw, update); // original payload preserved untouched
});

test('receive: edited_message normalises; caption backfills text; other updates → null', () => {
  const adapter = createTelegramAdapter();

  const edited = adapter.receive({
    update_id: 1,
    edited_message: {
      message_id: 7,
      from: { id: 5 },
      chat: { id: -100123, type: 'group' },
      date: 1_753_800_100,
      text: 'corrección',
    },
  });
  assert.equal(edited.externalId, '7');
  assert.equal(edited.from, '5');
  assert.equal(edited.threadId, '-100123');

  const media = adapter.receive(telegramUpdate({ text: undefined, caption: 'foto del recibo' }));
  assert.equal(media.text, 'foto del recibo');

  assert.equal(adapter.receive({ update_id: 2, callback_query: { id: 'cb' } }), null);
  assert.equal(adapter.receive({ update_id: 3, channel_post: { message_id: 9, chat: { id: 1 } } }), null);
  assert.equal(adapter.receive({}), null);
  assert.equal(adapter.receive(null), null);
  assert.equal(adapter.receive('not-an-update'), null);
});

test('send: posts sendMessage with the config token, caps text, returns externalId', async () => {
  const { impl, calls } = makeFetchMock([
    jsonResponse({ body: { ok: true, result: { message_id: 314 } } }),
  ]);
  const adapter = createTelegramAdapter({ config: { botToken: TOKEN }, fetchImpl: impl });

  const res = await adapter.send({ to: 987654321, text: 'x'.repeat(MAX_TEXT_LENGTH + 50) });
  assert.deepEqual(res, { ok: true, externalId: '314' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.chat_id, 987654321);
  assert.equal(payload.text.length, MAX_TEXT_LENGTH);
});

test('send: API failure throws TelegramApiError with status + retryAfterMs, token never leaks', async () => {
  const { impl } = makeFetchMock([
    jsonResponse({
      ok: false,
      status: 429,
      body: { ok: false, description: 'Too Many Requests: retry later', parameters: { retry_after: 3 } },
    }),
  ]);
  const adapter = createTelegramAdapter({ config: { botToken: TOKEN }, fetchImpl: impl });

  const err = await adapter.send({ to: 1, text: 'hola' }).catch((e) => e);
  assert.ok(err instanceof TelegramApiError);
  assert.equal(err.code, 'telegram_api_error');
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterMs, 3000);
  assert.ok(!err.message.includes(TOKEN), 'token must never appear in error messages');
});

test('send: network errors are typed and token-redacted; missing destination rejected', async () => {
  const boom = new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const { impl, calls } = makeFetchMock([boom]);
  const adapter = createTelegramAdapter({ config: { botToken: TOKEN }, fetchImpl: impl });

  const err = await adapter.send({ to: 55, text: 'hi' }).catch((e) => e);
  assert.ok(err instanceof TelegramApiError);
  assert.equal(err.code, 'network_error');
  assert.ok(!err.message.includes(TOKEN), 'token must be redacted from network errors');
  assert.ok(err.message.includes('[redacted]'));

  const noDest = await adapter.send({ text: 'hi' }).catch((e) => e);
  assert.equal(noDest.code, 'missing_destination');
  assert.equal(calls.length, 1, 'no request without a destination');

  const noToken = await createTelegramAdapter({ fetchImpl: impl }).send({ to: 1, text: 'x' }).catch((e) => e);
  assert.equal(noToken.code, 'missing_bot_token');
});

test('verifyConfig: getMe drives the verdict; empty config never hits the network', async () => {
  const { impl, calls } = makeFetchMock([
    jsonResponse({ body: { ok: true, result: { id: 99, username: 'sira_bot' } } }),
  ]);
  const adapter = createTelegramAdapter({ config: { botToken: TOKEN }, fetchImpl: impl });

  const good = await adapter.verifyConfig();
  assert.deepEqual(good, { ok: true, errors: [], bot: { id: 99, username: 'sira_bot' } });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getMe`);

  const { impl: impl401 } = makeFetchMock([
    jsonResponse({ ok: false, status: 401, body: { ok: false, description: 'Unauthorized' } }),
  ]);
  const bad = await createTelegramAdapter({ config: { botToken: 'bad' }, fetchImpl: impl401 }).verifyConfig();
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[0].includes('Unauthorized'));

  const { impl: implUnused, calls: unusedCalls } = makeFetchMock([jsonResponse()]);
  const missing = await createTelegramAdapter({ fetchImpl: implUnused }).verifyConfig();
  assert.deepEqual(missing, { ok: false, errors: ['missing_bot_token'] });
  assert.equal(unusedCalls.length, 0, 'missing token must not trigger a network call');
});

test('registry: telegram registered; unknown kinds and invalid factories rejected', () => {
  assert.ok(listAdapterKinds().includes('telegram'));

  const adapter = getAdapter('telegram', { config: { botToken: TOKEN } });
  assert.equal(adapter.kind, 'telegram');
  assert.equal(typeof adapter.send, 'function');

  assert.throws(() => getAdapter('fax'), (e) => e.code === 'unknown_adapter');
  assert.throws(() => registerAdapter('broken', () => ({ kind: 'broken' })), /contract/);
  assert.throws(() => registerAdapter('mismatch', () => createTelegramAdapter()), /kinds must match/);
});

test('gateAndNormalize: unknown sender gets a pairing code; approval opens the door', async () => {
  const pairingService = createPairingService();
  const adapter = createTelegramAdapter();
  const update = telegramUpdate();
  const channelConfig = { accountId: 'acme' };

  const first = await gateAndNormalize({ adapter, update, channelConfig, pairingService });
  assert.equal(first.status, 'pairing_required');
  assert.equal(first.created, true);
  assert.equal(typeof first.code, 'string');
  assert.equal(first.message, null, 'ungated messages never surface content');

  // Re-contact while pending: same code, still gated.
  const again = await gateAndNormalize({ adapter, update, channelConfig, pairingService });
  assert.equal(again.status, 'pairing_required');
  assert.equal(again.code, first.code);
  assert.equal(again.created, false);

  const approved = await pairingService.approve({ channel: 'telegram', accountId: 'acme', code: first.code });
  assert.equal(approved.ok, true);
  assert.equal(approved.senderId, '987654321');

  const after = await gateAndNormalize({ adapter, update, channelConfig, pairingService });
  assert.equal(after.status, 'allowed');
  assert.equal(after.message.from, '987654321');
  assert.equal(after.message.text, 'hola, ¿estado del pedido 118?');
});

test('gateAndNormalize: allowlist policy drops unknowns; non-message updates ignored', async () => {
  const pairingService = createPairingService();
  const adapter = createTelegramAdapter();

  const dropped = await gateAndNormalize({
    adapter,
    update: telegramUpdate(),
    channelConfig: { dmPolicy: 'allowlist' },
    pairingService,
  });
  assert.deepEqual(dropped, { status: 'dropped', reason: 'not_allowlisted', message: null });

  const ignored = await gateAndNormalize({
    adapter,
    update: { update_id: 9, callback_query: { id: 'x' } },
    pairingService,
  });
  assert.deepEqual(ignored, { status: 'ignored', message: null });

  // allowFrom pre-seeding admits the sender without a stored approval.
  const seeded = await gateAndNormalize({
    adapter,
    update: telegramUpdate(),
    channelConfig: { allowFrom: ['987654321'] },
    pairingService,
  });
  assert.equal(seeded.status, 'allowed');
});
