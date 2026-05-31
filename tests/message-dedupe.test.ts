import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeMessages,
  mergeChatPreservingUserMessages,
} from '../lib/message-preservation';

/**
 * Regression guard for the "sigue duplicando los mensajes" bug.
 *
 * The chat uses optimistic UI: a turn renders locally with a temp id
 * (`msg-user-…` / `msg-ai-…`) and is later reconciled against the server
 * copy (a stable id). When the content/ordinal-based merge couldn't align
 * the two ids, BOTH used to survive and the message rendered twice.
 * `dedupeMessages` is the guaranteed safety net (used by the merge AND by
 * the render layer); these tests pin its contract.
 */

test('dedupeMessages drops the optimistic twin when its server copy is present', () => {
  const msgs = [
    { id: 'srv-u1', role: 'USER', content: 'hola' },
    { id: 'msg-ai-1700000000000', role: 'ASSISTANT', content: 'Respuesta del asistente' },
    { id: 'clx_server_a1', role: 'ASSISTANT', content: 'Respuesta del asistente' },
  ];
  const out = dedupeMessages(msgs);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.id), ['srv-u1', 'clx_server_a1']);
});

test('dedupeMessages collapses exact-id duplicates, keeping the richer copy', () => {
  const msgs = [
    { id: 'a1', role: 'ASSISTANT', content: 'short' },
    { id: 'a1', role: 'ASSISTANT', content: 'a substantially longer answer body' },
  ];
  const out = dedupeMessages(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'a substantially longer answer body');
});

test('dedupeMessages keeps messages with distinct content', () => {
  const msgs = [
    { id: 'msg-ai-1', role: 'ASSISTANT', content: 'uno' },
    { id: 'srv-a2', role: 'ASSISTANT', content: 'dos' },
  ];
  assert.equal(dedupeMessages(msgs).length, 2);
});

test('dedupeMessages does NOT collapse two genuine same-text user sends (no stable twin)', () => {
  // Sending "hola" twice is legitimate — neither has a server twin yet, so
  // both must survive. We only drop an optimistic message when a *stable-id*
  // sibling already carries the same text.
  const msgs = [
    { id: 'msg-user-1', role: 'USER', content: 'hola' },
    { id: 'msg-user-2', role: 'USER', content: 'hola' },
  ];
  assert.equal(dedupeMessages(msgs).length, 2);
});

test('dedupeMessages collapses adjacent stable-id twins from a backend double-write', () => {
  // The gap Pass C closes: the backend persisted the SAME user turn twice, so
  // both rows carry a distinct stable cuid — no id collision for Pass A, no
  // optimistic twin for Pass B — yet they render back-to-back and the user
  // sees their message duplicated. This is the residual "sigue duplicando"
  // case that survived the earlier front-end guards.
  const msgs = [
    { id: 'clx_user_aaa', role: 'USER', content: 'hazme un resumen' },
    { id: 'clx_user_bbb', role: 'USER', content: 'hazme un resumen' },
    { id: 'clx_asst_ccc', role: 'ASSISTANT', content: 'Claro, aquí va.' },
  ];
  const out = dedupeMessages(msgs);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.role), ['USER', 'ASSISTANT']);
});

test('dedupeMessages preserves a stable-id message legitimately repeated after a reply', () => {
  // Same text, but separated by the assistant's turn → two real turns, not a
  // duplication artifact. Pass C only collapses *adjacent* twins, so both stay.
  const msgs = [
    { id: 'u1', role: 'USER', content: 'continúa' },
    { id: 'a1', role: 'ASSISTANT', content: 'primer tramo' },
    { id: 'u2', role: 'USER', content: 'continúa' },
    { id: 'a2', role: 'ASSISTANT', content: 'segundo tramo' },
  ];
  assert.equal(dedupeMessages(msgs).length, 4);
});

test('dedupeMessages is reference-stable when nothing is duplicated', () => {
  const msgs = [
    { id: 'u1', role: 'USER', content: 'a' },
    { id: 'a1', role: 'ASSISTANT', content: 'b' },
  ];
  assert.equal(dedupeMessages(msgs), msgs);
});

test('dedupeMessages handles empty and single-element arrays', () => {
  assert.deepEqual(dedupeMessages([]), []);
  assert.equal(dedupeMessages([{ id: 'x', role: 'USER', content: 'a' }]).length, 1);
});

test('mergeChatPreservingUserMessages never emits duplicate ids or optimistic survivors', () => {
  // Local snapshot already carries an optimistic assistant turn AND its
  // freshly-synced server copy (the exact state a racing syncId retry can
  // leave behind). The merge must converge to a single, server-id turn.
  const local = {
    id: 'c1',
    messages: [
      { id: 'srv-u1', role: 'USER', content: 'pregunta' },
      { id: 'msg-ai-1', role: 'ASSISTANT', content: 'la respuesta' },
      { id: 'srv-a1', role: 'ASSISTANT', content: 'la respuesta' },
    ],
  };
  const incoming = {
    id: 'c1',
    messages: [
      { id: 'srv-u1', role: 'USER', content: 'pregunta' },
      { id: 'srv-a1', role: 'ASSISTANT', content: 'la respuesta' },
    ],
  };
  const merged = mergeChatPreservingUserMessages(incoming, local);
  const ids = (merged.messages ?? []).map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  assert.ok(
    !ids.some((id) => typeof id === 'string' && /^msg-(?:user|ai|temp)-/.test(id)),
    'no optimistic temp ids survive the merge',
  );
});
