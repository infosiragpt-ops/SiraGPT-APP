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
 * gateAndNormalize is the single inbound door: signature verification →
 * adapter normalisation → persistent tenant-scoped authorizer → canonical
 * InboxMessage. An unknown sender NEVER reaches the caller's agent path.
 */

const { assertValidAdapter, validateInboxMessage, AdapterContractError } = require('./adapter-contract');
const { createTelegramAdapter } = require('./adapters/telegram');

const factories = new Map(); // kind → (deps) => adapter

function ingressContractError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
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
 * @param {object} [args.headers]       Provider webhook request headers.
 * @param {Buffer|string} [args.rawBody] Original body when a provider signs it.
 * @param {object} args.authorizer      Persistent, tenant-scoped authorizer
 *   from createBusinessChannelAuthorizer().
 * @returns {Promise<
 *   | { status: 'ignored', message: null }
 *   | { status: 'allowed', message: object, authorization: object }
 *   | { status: 'pairing_required', code: string, created: boolean, expiresAt: Date|null, message: null }
 *   | { status: 'dropped', reason: string, message: null }
 * >}
 */
async function gateAndNormalize({
  adapter,
  update,
  headers = {},
  rawBody,
  authorizer,
} = {}) {
  assertValidAdapter(adapter);
  if (!authorizer || typeof authorizer.authorizeInbound !== 'function') {
    throw ingressContractError('pairing_authorizer_required');
  }
  const accountId = typeof authorizer.accountId === 'string'
    ? authorizer.accountId.trim()
    : '';
  if (!accountId) throw ingressContractError('channel_account_id_required');

  const verified = await adapter.verifyInbound({ headers, rawBody, update });
  if (typeof verified !== 'boolean') {
    throw ingressContractError('adapter_inbound_verification_contract_violation');
  }
  if (verified !== true) {
    return { status: 'dropped', reason: 'invalid_signature', message: null };
  }

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
  if (message.channelKind !== adapter.kind) {
    throw new AdapterContractError(
      `adapter '${adapter.kind}' emitted channelKind '${message.channelKind}'`,
      ['channelKind must match adapter kind'],
    );
  }

  const authorization = await authorizer.authorizeInbound({
    accountId,
    senderId: message.from,
    message,
  });
  if (!authorization || typeof authorization !== 'object') {
    throw ingressContractError('pairing_authorizer_contract_violation');
  }
  if (typeof authorization.allowed !== 'boolean') {
    throw ingressContractError('pairing_authorizer_contract_violation');
  }
  if (authorization.allowed === true) {
    return { status: 'allowed', message, authorization };
  }
  if (authorization.reason === 'pairing_required') {
    if (!authorization.pairingCode) {
      throw ingressContractError('pairing_authorizer_contract_violation');
    }
    return {
      status: 'pairing_required',
      code: authorization.pairingCode,
      created: authorization.created === true,
      expiresAt: authorization.expiresAt || null,
      message: null,
    };
  }
  return {
    status: 'dropped',
    reason: authorization.reason || 'sender_not_allowed',
    message: null,
  };
}

registerAdapter('telegram', createTelegramAdapter);

module.exports = {
  registerAdapter,
  getAdapter,
  listAdapterKinds,
  gateAndNormalize,
};
