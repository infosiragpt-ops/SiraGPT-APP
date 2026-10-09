'use strict';

/**
 * Automation origin — how an agent-created automation is told apart from a
 * Cowork scheduled task created from the UI, WITHOUT a schema migration.
 *
 * `ScheduledAgentTask.createdFrom` is a free String (≤60 chars, default
 * 'ui'). Automations encode their kind and the originating chat in it:
 *
 *     agent:<kind>;chat=<chatId>
 *
 * kind ∈ once | recurring | loop | heartbeat. The scheduler reads it to
 * deliver the answer into the chat where the user asked for the automation
 * (OpenClaw delivers cron output to the originating channel the same way)
 * and to apply the automation lifecycle (one-shot deletion, NO_REPLY,
 * backoff, auto-disable). A row whose createdFrom does not start with
 * `agent:` keeps the legacy Cowork behaviour untouched.
 */

const AUTOMATION_KINDS = Object.freeze(['once', 'recurring', 'loop', 'heartbeat']);
const PREFIX = 'agent:';
const MAX_CREATED_FROM = 60;

function encodeOrigin({ kind, chatId }) {
  const k = AUTOMATION_KINDS.includes(kind) ? kind : 'recurring';
  const chat = String(chatId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const encoded = chat ? `${PREFIX}${k};chat=${chat}` : `${PREFIX}${k}`;
  return encoded.slice(0, MAX_CREATED_FROM);
}

function decodeOrigin(createdFrom) {
  const raw = String(createdFrom || '');
  if (!raw.startsWith(PREFIX)) return { isAutomation: false, kind: null, chatId: null };
  const body = raw.slice(PREFIX.length);
  const [kindRaw, ...rest] = body.split(';');
  const kind = AUTOMATION_KINDS.includes(kindRaw) ? kindRaw : 'recurring';
  let chatId = null;
  for (const part of rest) {
    const m = /^chat=([A-Za-z0-9_-]+)$/.exec(part);
    if (m) chatId = m[1];
  }
  return { isAutomation: true, kind, chatId };
}

function isAutomationOrigin(createdFrom) {
  return String(createdFrom || '').startsWith(PREFIX);
}

module.exports = {
  AUTOMATION_KINDS,
  ORIGIN_PREFIX: PREFIX,
  encodeOrigin,
  decodeOrigin,
  isAutomationOrigin,
};
