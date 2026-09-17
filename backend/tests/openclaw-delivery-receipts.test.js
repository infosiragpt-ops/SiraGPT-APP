'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
  DELIVERY_STATUSES,
  DELIVERY_ERRORS_ES,
  createDeliveryReceipt,
  receiptHasNoSecrets,
} = require('../src/orchestration/multichannel/delivery-receipt');

const adapterMod = require('../src/orchestration/multichannel/openclaw-adapter');
const {
  resolveOpenClawConfig,
  deliverOutbound,
  attachCronDeliveryReceipt,
} = adapterMod;
const { createOrchestrationContext } = require('../src/orchestration/orchestration-context');
const { createHermesGateway } = require('../src/services/agents/hermes-gateway-bridge');
const cron = require('../src/services/cron-as-turn');
const { createCron } = require('../src/services/agent-cron');

const ENABLED = Object.freeze({
  OPENCLAW_ENABLED: 'true',
  OPENCLAW_API_KEY: 'test-key-not-a-secret',
  OPENCLAW_GATEWAY_URL: 'https://channels.example.test/deliver',
});

function enabledAdapter(overrides = {}) {
  return adapterMod.createOpenClawAdapter({ env: { ...ENABLED }, ...overrides });
}

test('receipt helpers are re-exported from the adapter module', () => {
  assert.equal(typeof adapterMod.createDeliveryReceipt, 'function');
  assert.equal(typeof adapterMod.deliverOutbound, 'function');
  assert.equal(adapterMod.DELIVERY_STATUSES.DELIVERED, 'delivered');
  assert.ok(DELIVERY_ERRORS_ES.transport_missing.includes('aceptó'));
});

test('createDeliveryReceipt never marks delivered without accepted', () => {
  const receipt = adapterMod.createDeliveryReceipt({
    accepted: false,
    delivered: true,
    status: 'delivered',
    channel: 'telegram',
  });
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.delivered, false);
  assert.notEqual(receipt.status, DELIVERY_STATUSES.DELIVERED);
});

test('disabled adapter rejects outbound and inbound without claiming delivery', async () => {
  const adapter = adapterMod.createOpenClawAdapter({ env: {} });
  const out = await adapter.deliverOutbound({ channel: 'telegram', text: 'hola', chatId: '1' });
  assert.equal(out.accepted, false);
  assert.equal(out.delivered, false);
  assert.equal(out.status, 'rejected');
  assert.equal(out.error.code, 'openclaw_disabled');
  assert.match(out.error.message, /desactivado/);

  const inbound = await adapter.handleInboundMessage({ channel: 'telegram', userId: 'u1' });
  assert.equal(inbound.accepted, false);
  assert.equal(inbound.delivered, false);
});

test('missing API key is rejected, not Conectada', async () => {
  const out = await deliverOutbound(
    { channel: 'slack', text: 'hola', chatId: 'C1' },
    { env: { OPENCLAW_ENABLED: 'true' } },
  );
  assert.equal(out.accepted, false);
  assert.equal(out.delivered, false);
  assert.equal(out.error.code, 'missing_api_key');
  assert.match(out.error.message, /clave de API/);
});

test('unknown channel is rejected in Spanish', async () => {
  const out = await deliverOutbound(
    { channel: 'irc', text: 'hola', chatId: '1' },
    { env: ENABLED },
  );
  assert.equal(out.accepted, false);
  assert.equal(out.delivered, false);
  assert.equal(out.error.code, 'channel_not_allowed');
  assert.match(out.error.message, /no está permitido/);
});

test('empty message is rejected', async () => {
  const out = await deliverOutbound(
    { channel: 'telegram', text: '   ', chatId: '1' },
    { env: ENABLED },
  );
  assert.equal(out.error.code, 'empty_message');
  assert.equal(out.delivered, false);
});

test('missing destination is rejected', async () => {
  const out = await deliverOutbound(
    { channel: 'whatsapp', text: 'hola' },
    { env: ENABLED },
  );
  assert.equal(out.error.code, 'missing_destination');
  assert.match(out.error.message, /destino/);
});

test('configured endpoint without transport is accepted but not delivered', async () => {
  const adapter = adapterMod.createOpenClawAdapter({
    env: ENABLED,
    fetchImpl: null,
    transport: null,
  });
  const out = await adapter.deliverOutbound({
    channel: 'telegram',
    text: 'hola desde Sira',
    chatId: '99',
    userId: 'u-1',
  });
  assert.equal(out.accepted, true);
  assert.equal(out.delivered, false);
  assert.equal(out.status, 'accepted');
  assert.equal(out.error.code, 'transport_missing');
  assert.match(out.error.message, /aceptó/);
  assert.doesNotMatch(JSON.stringify(out), /test-key-not-a-secret|Bearer /);
});

test('injectable transport confirmation is the only delivered path', async () => {
  const adapter = enabledAdapter({
    transport: async () => ({ ok: true, platformMessageId: 'tg-42' }),
  });
  const out = await adapter.deliverOutbound({
    channel: 'telegram',
    text: 'enviado de verdad',
    chatId: '99',
  });
  assert.equal(out.accepted, true);
  assert.equal(out.delivered, true);
  assert.equal(out.status, 'delivered');
  assert.equal(out.platformMessageId, 'tg-42');
  assert.equal(out.error, null);
});

test('transport {ok:false} stays accepted-failed, never delivered', async () => {
  const adapter = enabledAdapter({
    transport: async () => ({ ok: false, code: 'transport_failed' }),
  });
  const out = await adapter.deliverOutbound({
    channel: 'slack',
    text: 'fallará',
    chatId: 'C1',
  });
  assert.equal(out.accepted, true);
  assert.equal(out.delivered, false);
  assert.equal(out.status, 'failed');
  assert.equal(out.error.code, 'transport_failed');
  assert.match(out.error.message, /rechazó/);
});

test('thrown transport maps timeout vs unreachable in Spanish', async () => {
  const timeout = await enabledAdapter({
    transport: async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  }).deliverOutbound({ channel: 'discord', text: 'x', chatId: '1' });
  assert.equal(timeout.delivered, false);
  assert.equal(timeout.error.code, 'transport_timeout');
  assert.match(timeout.error.message, /tiempo de espera/);

  const down = await enabledAdapter({
    transport: async () => {
      const err = new Error('down');
      err.code = 'ECONNREFUSED';
      throw err;
    },
  }).deliverOutbound({ channel: 'discord', text: 'x', chatId: '1' });
  assert.equal(down.error.code, 'transport_unreachable');
  assert.match(down.error.message, /alcanzar/);
});

test('HTTP 200 without confirmation is not delivered', async () => {
  const out = await adapterMod.httpTransport(
    { channel: 'telegram', text: 'hola', chatId: '1' },
    {
      endpoint: 'https://channels.example.test/deliver',
      apiKey: 'test-key-not-a-secret',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    },
  );
  assert.equal(out.delivered, false);
  assert.equal(out.code, 'not_confirmed');
});

test('HTTP 200 with {delivered:true,id} is delivered', async () => {
  const out = await adapterMod.httpTransport(
    { channel: 'whatsapp', text: 'hola', userId: '52155' },
    {
      endpoint: 'https://channels.example.test/deliver',
      apiKey: 'test-key-not-a-secret',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ delivered: true, id: 'wa-9' }),
      }),
    },
  );
  assert.equal(out.ok, true);
  assert.equal(out.delivered, true);
  assert.equal(out.platformMessageId, 'wa-9');
});

test('HTTP 500 is failed, not accepted-as-success', async () => {
  const adapter = enabledAdapter({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'nope' }) }),
  });
  const out = await adapter.deliverOutbound({ channel: 'signal', text: 'x', chatId: 's1' });
  assert.equal(out.accepted, true);
  assert.equal(out.delivered, false);
  assert.equal(out.status, 'failed');
});

test('inbound accept is not outbound delivery', async () => {
  const adapter = enabledAdapter();
  const inbound = await adapter.handleInboundMessage({
    userId: 'ext-1',
    channel: 'telegram',
    content: 'hola inbound',
  });
  assert.equal(inbound.accepted, true);
  assert.equal(inbound.delivered, false);
  assert.equal(inbound.receipt.delivered, false);
  assert.equal(inbound.receipt.error.code, 'inbound_only');
  assert.match(inbound.receipt.error.message, /entrada/);
});

test('payload that looks like a secret is rejected and redacted', async () => {
  const out = await deliverOutbound(
    { channel: 'telegram', text: 'Bearer sk-abcdefghijklmnopqrstuvwxyz', chatId: '1' },
    { env: ENABLED },
  );
  assert.equal(out.accepted, false);
  assert.equal(out.error.code, 'secret_rejected');
  assert.equal(JSON.stringify(out).includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
});

test('receipt JSON never echoes the API key or gateway URL token', async () => {
  const adapter = enabledAdapter({
    transport: async () => ({ ok: true, id: 'ok-1' }),
  });
  const out = await adapter.deliverOutbound({
    channel: 'imessage',
    text: 'ping',
    chatId: 'im-1',
  });
  const blob = JSON.stringify(out);
  assert.equal(blob.includes(ENABLED.OPENCLAW_API_KEY), false);
  assert.equal(blob.includes('Bearer'), false);
  assert.equal(receiptHasNoSecrets(out, [ENABLED.OPENCLAW_API_KEY]), true);
});

test('orchestration context.deliverChannel uses the honest adapter', async () => {
  const ctx = createOrchestrationContext({ env: ENABLED });
  assert.equal(typeof ctx.deliverChannel, 'function');
  assert.equal(typeof ctx.multichannel.deliverOutbound, 'function');
  const out = await ctx.deliverChannel(
    { channel: 'telegram', text: 'desde contexto', chatId: '1' },
    { transport: async () => ({ ok: true, platformMessageId: 'ctx-1' }) },
  );
  assert.equal(out.delivered, true);
  assert.equal(out.platformMessageId, 'ctx-1');
});

test('Hermes sendMessage no longer returns ok/queued just because a URL exists', async () => {
  const gateway = createHermesGateway({
    env: { ...ENABLED, HERMES_GATEWAY_ENABLED: '1' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ queued: true }) }),
  });
  const sent = await gateway.sendMessage({
    channel: 'telegram',
    text: 'no fingir Conectada',
    chatId: '77',
  });
  assert.equal(sent.ok, false);
  assert.equal(sent.delivered, false);
  assert.equal(sent.accepted, true);
  assert.equal(sent.receipt.status, 'failed');
  assert.equal(sent.receipt.error.code, 'not_confirmed');
});

test('Hermes sendMessage is ok only after transport proof', async () => {
  const gateway = createHermesGateway({
    env: { ...ENABLED, HERMES_GATEWAY_ENABLED: '1' },
    transport: async () => ({ ok: true, platformMessageId: 'h-1' }),
  });
  const sent = await gateway.sendMessage({
    channel: 'slack',
    text: 'sí se envió',
    chatId: 'C9',
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.delivered, true);
  assert.equal(sent.receipt.platformMessageId, 'h-1');
});

test('Hermes disabled gateway is rejected, not stored-as-success', async () => {
  const gateway = createHermesGateway({
    env: { HERMES_GATEWAY_ENABLED: '0', OPENCLAW_ENABLED: 'true', OPENCLAW_API_KEY: 'x' },
  });
  const sent = await gateway.sendMessage({ channel: 'telegram', text: 'hola', chatId: '1' });
  assert.equal(sent.ok, false);
  assert.equal(sent.delivered, false);
  assert.equal(sent.accepted, false);
  assert.match(sent.receipt.error.message, /Hermes/);
});

test('Hermes inbound accept still sets delivered false', async () => {
  const gateway = createHermesGateway({
    env: { ...ENABLED, HERMES_GATEWAY_ENABLED: '1' },
  });
  const inbound = await gateway.handleInboundMessage({ channel: 'telegram', userId: 'u' });
  assert.equal(inbound.accepted, true);
  assert.equal(inbound.delivered, false);
});

test('cron dispatch without channel keeps the legacy result shape', async () => {
  const result = await cron.dispatchCronJobAsAgentTurn(
    { startAgent: async () => ({ runId: 'r-1' }) },
    { id: 'job-plain', userId: 'u1', prompt: 'tick' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.runId, 'r-1');
  assert.equal(result.delivery, undefined);
});

test('cron dispatch with channel and no transport is accepted, not delivered', async () => {
  const result = await cron.dispatchCronJobAsAgentTurn(
    { startAgent: async () => ({ runId: 'r-2', answer: 'listo' }) },
    {
      id: 'job-ch',
      userId: 'u1',
      prompt: 'avísame',
      channel: 'telegram',
      chatId: '88',
      env: ENABLED,
    },
  );
  assert.equal(result.ok, true);
  assert.ok(result.delivery);
  assert.equal(result.delivery.accepted, true);
  assert.equal(result.delivery.delivered, false);
  assert.equal(result.delivery.error.code, 'cron_not_delivered');
  assert.match(result.delivery.error.message, /cron/);
});

test('cron dispatch failure with channel is failed, not delivered', async () => {
  const result = await cron.dispatchCronJobAsAgentTurn(
    { startAgent: async () => ({ ok: false, code: 'E_QUOTA' }) },
    {
      id: 'job-fail',
      userId: 'u1',
      prompt: 'avísame',
      channel: 'telegram',
      chatId: '88',
      env: ENABLED,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.delivery.accepted, false);
  assert.equal(result.delivery.delivered, false);
  assert.equal(result.delivery.error.code, 'cron_dispatch_failed');
});

test('cron + injectable transport delivers only with proof', async () => {
  const result = await cron.dispatchCronJobAsAgentTurn(
    {
      startAgent: async () => ({ ok: true, answer: 'el informe está listo' }),
    },
    {
      id: 'job-ok',
      userId: 'u1',
      prompt: 'manda el informe',
      channel: 'whatsapp',
      chatId: '52100',
      env: ENABLED,
      transport: async (payload) => {
        assert.equal(payload.channel, 'whatsapp');
        assert.match(payload.text, /informe/);
        return { ok: true, platformMessageId: 'wa-cron' };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.delivery.delivered, true);
  assert.equal(result.delivery.platformMessageId, 'wa-cron');
});

test('attachCronDeliveryReceipt without channel still refuses to claim delivered', async () => {
  const wrapped = await attachCronDeliveryReceipt({ ok: true, runId: 'x' }, { id: 'j', prompt: 'solo turno' });
  assert.equal(wrapped.delivery.accepted, true);
  assert.equal(wrapped.delivery.delivered, false);
  assert.equal(wrapped.delivery.error.code, 'cron_not_delivered');
});

test('agent-cron tick does not record ok when the dispatcher returns ok:false', async () => {
  const persistPath = path.join(os.tmpdir(), `oc-receipt-cron-${process.pid}-${Date.now()}.json`);
  const clock = { t: Date.now() };
  const svc = createCron({ now: () => clock.t, persistPath });
  const created = svc.createJob({ userId: 'u1', prompt: 'tick', everyMs: 60_000 });
  assert.equal(created.ok, true);
  clock.t += 60_000;
  const ran = await svc.tick({
    startAgent: async () => ({ ok: false, error: 'overlap_skipped' }),
  });
  assert.equal(ran.ran, 1);
  assert.equal(ran.results[0].lastStatus, 'error');
  try { fs.unlinkSync(persistPath); } catch { /* tmp */ }
});

test('agent-cron tick records accepted, not ok, when channel receipt is undelivered', async () => {
  const persistPath = path.join(os.tmpdir(), `oc-receipt-cron2-${process.pid}-${Date.now()}.json`);
  const clock = { t: Date.now() };
  const svc = createCron({ now: () => clock.t, persistPath });
  const created = svc.createJob({ userId: 'u1', prompt: 'tick canal', everyMs: 60_000 });
  created.job.channel = 'telegram';
  created.job.chatId = '1';
  created.job.env = ENABLED;
  clock.t += 60_000;
  const ran = await svc.tick({
    startAgent: async () => ({ ok: true, answer: 'hecho' }),
  });
  assert.equal(ran.results[0].lastStatus, 'accepted');
  const listed = svc.listJobs({ userId: 'u1' })[0];
  assert.equal(listed.lastDelivery.delivered, false);
  assert.equal(listed.lastDelivery.accepted, true);
  try { fs.unlinkSync(persistPath); } catch { /* tmp */ }
});

test('Spanish catalog covers every receipt error code used by the adapter', () => {
  for (const code of [
    'openclaw_disabled', 'missing_api_key', 'channel_not_allowed', 'empty_message',
    'missing_destination', 'transport_missing', 'transport_failed', 'transport_timeout',
    'transport_unreachable', 'not_confirmed', 'cron_dispatch_failed', 'cron_not_delivered',
    'hermes_gateway_disabled', 'inbound_only', 'secret_rejected',
  ]) {
    assert.equal(typeof DELIVERY_ERRORS_ES[code], 'string');
    assert.match(DELIVERY_ERRORS_ES[code], /[áéíóúñÁÉÍÓÚÑa-z]/i);
  }
});

test('resolveOpenClawConfig still lists the six default channels', () => {
  const config = resolveOpenClawConfig({});
  assert.deepEqual(config.allowedChannels, [
    'whatsapp', 'telegram', 'slack', 'discord', 'signal', 'imessage',
  ]);
});

test('delivery receipt preview is capped and adapter export stays stable', () => {
  const long = 'x'.repeat(400);
  const preview = adapterMod.previewText(long);
  assert.ok(preview.length <= 161);
  const receipt = createDeliveryReceipt({
    accepted: true,
    delivered: true,
    preview: long,
    channel: 'telegram',
    platformMessageId: 'p1',
  });
  assert.equal(receipt.delivered, true);
  assert.ok(receipt.preview.length <= 161);
});
