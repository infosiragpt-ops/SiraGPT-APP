'use strict';

/**
 * business-channels/registry — adapter registry + pairing-gated ingestion.
 *
 * Native rewrite of OpenClaw's channel registry (MIT,
 * github.com/openclaw/openclaw src/channels). Adapters register as
 * FACTORIES (kind → createAdapter(deps)) so each call site can bind its own
 * decrypted config and injectable fetch; the registry enforces the
 * adapter-contract at registration time (against a dependency-free probe
 * instance) and again on every getAdapter, so a misbehaving factory can
 * never hand out a half-shaped adapter.
 *
 * gateAndNormalize is the single inbound door: webhook update → adapter
 * normalisation → pairing gate (./pairing) → canonical InboxMessage. An
 * unknown sender NEVER reaches the caller's agent path — they get a pairing
 * code (or are dropped, per the channel's dmPolicy).
 */

const { assertValidAdapter, validateInboxMessage, AdapterContractError } = require('./adapter-contract');
const { createPairingService } = require('./pairing');
const { createTelegramAdapter } = require('./adapters/telegram');

const factories = new Map(); // kind → (deps) => adapter

// Shared by gateAndNormalize calls that do not inject their own service, so
// "same code while pending" survives across webhook deliveries in-process.
let defaultPairingService = null;
function getDefaultPairingService() {
  if (!defaultPairingService) defaultPairingService = createPairingService();
  return defaultPairingService;
}

/**
 * Register an adapter factory under a channel kind. The factory must build
 * with empty deps (config arrives later, at getAdapter time) and its product
 * must satisfy the adapter contract with a matching kind.
 */
function registerAdapter(kind, factory) {
  const key = String(kind || '').trim();
  if (!key) throw new AdapterContractError('registerAdapter requires a non-empty kind');
  if (typeof factory !== 'function') {
    throw new AdapterContractError(`registerAdapter('${key}') requires a factory function`);
  }
  const probe = assertValidAdapter(factory({}), `adapter '${key}'`);
  if (probe.kind !== key) {
    throw new AdapterContractError(`adapter '${key}' reports kind '${probe.kind}' — kinds must match`);
  }
  factories.set(key, factory);
  return { kind: key };
}

/** Build a validated adapter instance bound to the caller's deps/config. */
function getAdapter(kind, deps = {}) {
  const key = String(kind || '').trim();
  const factory = factories.get(key);
  if (!factory) {
    const err = new Error(`unknown channel adapter: '${key}'`);
    err.code = 'unknown_adapter';
    throw err;
  }
  return assertValidAdapter(factory(deps), `adapter '${key}'`);
}

function listAdapterKinds() {
  return [...factories.keys()].sort();
}

/**
 * Gate an inbound webhook update through pairing and normalise it.
 *
 * @param {object} args
 * @param {object} args.adapter        Contract-conforming adapter instance.
 * @param {object} args.update         Raw provider webhook payload.
 * @param {object} [args.channelConfig] { accountId?, dmPolicy?, allowFrom? }.
 * @param {object} [args.pairingService] Injectable (defaults to a shared
 *   in-process service from ./pairing).
 * @returns {Promise<
 *   | { status: 'ignored', message: null }
 *   | { status: 'allowed', message: object }
 *   | { status: 'pairing_required', code: string, created: boolean, message: null }
 *   | { status: 'dropped', reason: string, message: null }
 * >}
 */
async function gateAndNormalize({ adapter, update, channelConfig = {}, pairingService } = {}) {
  assertValidAdapter(adapter);
  const message = adapter.receive(update);
  if (message === null || message === undefined) {
    return { status: 'ignored', message: null };
  }
  const shape = validateInboxMessage(message);
  if (!shape.ok) {
    throw new AdapterContractError(
      `adapter '${adapter.kind}' emitted an invalid InboxMessage: ${shape.errors.join('; ')}`,
      shape.errors,
    );
  }
  const pairing = pairingService || getDefaultPairingService();
  const gate = await pairing.gateInbound({
    channel: message.channelKind,
    accountId: channelConfig.accountId,
    senderId: message.from,
    dmPolicy: channelConfig.dmPolicy,
    allowFrom: channelConfig.allowFrom,
    meta: { externalId: message.externalId, threadId: message.threadId },
  });
  if (gate.status === 'allowed') return { status: 'allowed', message };
  if (gate.status === 'pairing_required') {
    return { status: 'pairing_required', code: gate.code, created: gate.created, message: null };
  }
  return { status: 'dropped', reason: gate.reason || 'not_allowlisted', message: null };
}

registerAdapter('telegram', createTelegramAdapter);

module.exports = {
  registerAdapter,
  getAdapter,
  listAdapterKinds,
  gateAndNormalize,
};
