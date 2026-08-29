'use strict';

/**
 * Event-sourced session bus + SSE formatter.
 *
 * Each session keeps an append-only log. Subscribers receive live frames
 * for the /api/opencode/events stream. Stage labels stay Spanish and
 * reuse the AgentRunner F3 vocabulary.
 */

const { EventEmitter } = require('events');
const { STAGE_LABELS } = require('../agent-runner/trace');

const bus = new EventEmitter();
bus.setMaxListeners(100);

function nextSeq(session) {
  session.seq = (session.seq || 0) + 1;
  return session.seq;
}

function appendEvent(session, type, data = {}) {
  const event = {
    id: `${session.id}:${nextSeq(session)}`,
    type,
    sessionId: session.id,
    ts: Date.now(),
    ...data,
  };
  session.events.push(event);
  bus.emit('event', event);
  bus.emit(`session:${session.id}`, event);
  return event;
}

function stageEvent(session, step, extra = {}) {
  const label = extra.label || STAGE_LABELS[step] || STAGE_LABELS.working;
  return appendEvent(session, 'stage', {
    step,
    label,
    tool: extra.tool || 'sira_code',
    ...extra,
    label, // keep Spanish label authoritative
  });
}

function formatSse(event) {
  const type = event.type || 'message';
  const id = event.id || '';
  const payload = { ...event };
  return `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function subscribe(onEvent, { sessionId } = {}) {
  const handler = (event) => {
    if (sessionId && event.sessionId !== sessionId) return;
    onEvent(event);
  };
  const key = sessionId ? `session:${sessionId}` : 'event';
  bus.on(key, handler);
  return () => bus.off(key, handler);
}

function replay(session, { afterId } = {}) {
  if (!session) return [];
  if (!afterId) return session.events.slice();
  const idx = session.events.findIndex((ev) => ev.id === afterId);
  return idx === -1 ? session.events.slice() : session.events.slice(idx + 1);
}

module.exports = {
  bus,
  appendEvent,
  stageEvent,
  formatSse,
  subscribe,
  replay,
  STAGE_LABELS,
};
