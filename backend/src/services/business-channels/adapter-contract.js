'use strict';

/**
 * business-channels/adapter-contract — the shape every channel adapter obeys.
 *
 * Native rewrite of OpenClaw's channel-adapter contract (MIT,
 * github.com/openclaw/openclaw src/channels): a channel adapter is a small
 * object that (a) normalises provider webhook payloads into ONE canonical
 * inbox shape, (b) sends plain-text replies, and (c) can verify its own
 * config against the provider before going live. Everything channel-specific
 * (auth headers, payload envelopes, rate limits) stays inside the adapter;
 * everything downstream (pairing gate, routing, agents) sees only the
 * canonical InboxMessage.
 *
 * Adapter shape (validated by validateAdapter):
 *   kind:         non-empty string — canonical channel id ('telegram', …)
 *   verifyInbound({ headers, rawBody, update })
 *                  → boolean | Promise<boolean>
 *   receive(update)        → InboxMessage | null (null = ignore the update)
 *   send({ to, text })     → Promise (typed error on provider failure)
 *   verifyConfig(config)   → Promise<{ ok: boolean, errors: string[] }>
 *
 * Canonical InboxMessage:
 *   channelKind:  adapter kind that produced it
 *   externalId:   provider-side message id (string)
 *   from:         provider-side sender id (string) — what pairing gates on
 *   text:         plain-text content ('' when the message carries no text)
 *   ts:           epoch milliseconds
 *   threadId?:    where a reply should go (chat/conversation id)
 *   raw:          the original provider payload, untouched
 */

const REQUIRED_METHODS = ['verifyInbound', 'receive', 'send', 'verifyConfig'];
const INBOX_REQUIRED_FIELDS = ['channelKind', 'externalId', 'from', 'text', 'ts', 'raw'];

class AdapterContractError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'AdapterContractError';
    this.code = 'adapter_contract_violation';
    this.errors = errors;
  }
}

/** Structural check of an adapter object. Never calls the adapter. */
function validateAdapter(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['adapter must be an object'] };
  }
  if (typeof obj.kind !== 'string' || !obj.kind.trim()) {
    errors.push('kind must be a non-empty string');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof obj[method] !== 'function') {
      errors.push(`${method} must be a function`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** validateAdapter that throws AdapterContractError instead of reporting. */
function assertValidAdapter(obj, label = 'adapter') {
  const { ok, errors } = validateAdapter(obj);
  if (!ok) throw new AdapterContractError(`${label} violates the channel-adapter contract: ${errors.join('; ')}`, errors);
  return obj;
}

/** Structural check of the canonical inbox shape adapters must emit. */
function validateInboxMessage(msg) {
  const errors = [];
  if (!msg || typeof msg !== 'object') {
    return { ok: false, errors: ['inbox message must be an object'] };
  }
  for (const field of INBOX_REQUIRED_FIELDS) {
    if (!(field in msg)) errors.push(`missing field: ${field}`);
  }
  if ('channelKind' in msg && (typeof msg.channelKind !== 'string' || !msg.channelKind)) {
    errors.push('channelKind must be a non-empty string');
  }
  if ('externalId' in msg && (typeof msg.externalId !== 'string' || !msg.externalId)) {
    errors.push('externalId must be a non-empty string');
  }
  if ('from' in msg && (typeof msg.from !== 'string' || !msg.from)) {
    errors.push('from must be a non-empty string');
  }
  if ('text' in msg && typeof msg.text !== 'string') {
    errors.push('text must be a string');
  }
  if ('ts' in msg && !Number.isFinite(msg.ts)) {
    errors.push('ts must be epoch milliseconds');
  }
  if (msg.threadId !== undefined && (typeof msg.threadId !== 'string' || !msg.threadId)) {
    errors.push('threadId, when present, must be a non-empty string');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  AdapterContractError,
  validateAdapter,
  assertValidAdapter,
  validateInboxMessage,
  REQUIRED_METHODS,
  INBOX_REQUIRED_FIELDS,
};
