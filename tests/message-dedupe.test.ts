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

test('dedupeMessages collapses a rapid duplicated user/assistant turn pair', () => {
  const msgs = [
    { id: 'u1', role: 'USER', content: 'hola', timestamp: '2026-05-31T15:40:59.065Z' },
    { id: 'a1', role: 'ASSISTANT', content: '¡Hola! ¿Cómo puedo ayudarte hoy?', timestamp: '2026-05-31T15:40:59.076Z' },
    { id: 'u2', role: 'USER', content: 'hola', timestamp: '2026-05-31T15:40:59.415Z' },
    { id: 'a2', role: 'ASSISTANT', content: '¡Hola! ¿Cómo puedo ayudarte hoy?', timestamp: '2026-05-31T15:40:59.422Z' },
  ];
  const out = dedupeMessages(msgs);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.id), ['u1', 'a1']);
});

test('dedupeMessages preserves repeated turn pairs outside the rapid duplicate window', () => {
  const msgs = [
    { id: 'u1', role: 'USER', content: 'hola', timestamp: '2026-05-31T15:40:00.000Z' },
    { id: 'a1', role: 'ASSISTANT', content: '¡Hola! ¿Cómo puedo ayudarte hoy?', timestamp: '2026-05-31T15:40:01.000Z' },
    { id: 'u2', role: 'USER', content: 'hola', timestamp: '2026-05-31T15:40:05.000Z' },
    { id: 'a2', role: 'ASSISTANT', content: '¡Hola! ¿Cómo puedo ayudarte hoy?', timestamp: '2026-05-31T15:40:06.000Z' },
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

// «Subí un video y desaparece… luego vuelve a aparecer»: a file-only send
// reuses the composer's automatic prompt, so the new optimistic bubble read
// as a twin of the previous turn's server row and vanished until the server
// persisted the new turn. Attachments and answered turns now disambiguate.
const RUNNING_TASK = '```agent-task-state\n{"done":false,"steps":[]}\n```';
const DONE_TASK = '```agent-task-state\n{"done":true,"steps":[]}\n```\n\n**1 de 1 archivos transcritos.**';
const AUTO_PROMPT = 'Analiza los archivos adjuntos y responde según el contexto del hilo.';

test('dedupeMessages keeps a new file-only turn whose attachment differs from the older identical prompt', () => {
  const msgs = [
    { id: 'clx_user_v1', role: 'USER', content: AUTO_PROMPT, files: [{ id: 'file-1', name: 'lunes.mp4', mimeType: 'video/mp4' }] },
    { id: 'clx_asst_v1', role: 'ASSISTANT', content: DONE_TASK },
    { id: 'msg-user-1700000000001', role: 'USER', content: AUTO_PROMPT, files: [{ id: 'file-2', name: 'martes.mp4', mimeType: 'video/mp4' }] },
    { id: 'msg-ai-1700000000002', role: 'ASSISTANT', content: RUNNING_TASK },
  ];
  const out = dedupeMessages(msgs);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((m) => m.id), ['clx_user_v1', 'clx_asst_v1', 'msg-user-1700000000001', 'msg-ai-1700000000002']);
  // The older row must not swallow the new video either.
  assert.deepEqual((out[0] as { files?: Array<{ id: string }> }).files?.map((f) => f.id), ['file-1']);
});

test('dedupeMessages still collapses the optimistic bubble onto its own server row (same upload, task running)', () => {
  const msgs = [
    { id: 'clx_user_v2', role: 'USER', content: AUTO_PROMPT, files: [{ id: 'file-2', name: 'martes.mp4' }] },
    { id: 'clx_asst_v2', role: 'ASSISTANT', content: RUNNING_TASK },
    { id: 'msg-user-1700000000003', role: 'USER', content: AUTO_PROMPT, files: [{ id: 'file-2', name: 'martes.mp4', mimeType: 'video/mp4' }] },
  ];
  const out = dedupeMessages(msgs);
  assert.deepEqual(out.map((m) => m.id), ['clx_user_v2', 'clx_asst_v2']);
  assert.equal((out[0] as { files?: Array<{ mimeType?: string }> }).files?.[0]?.mimeType, 'video/mp4');
});

test('dedupeMessages keeps a text-only prompt repeated after the previous reply was answered', () => {
  const msgs = [
    { id: 'clx_user_r1', role: 'USER', content: 'resume esto' },
    { id: 'clx_asst_r1', role: 'ASSISTANT', content: 'Resumen: …' },
    { id: 'msg-user-1700000000004', role: 'USER', content: 'resume esto' },
    { id: 'msg-ai-1700000000005', role: 'ASSISTANT', content: '' },
  ];
  assert.equal(dedupeMessages(msgs).length, 4);
});

test('dedupeMessages drops the optimistic twin when the server row is id-only (files grafted) and unanswered', () => {
  const msgs = [
    { id: 'msg-user-1700000000006', role: 'USER', content: AUTO_PROMPT, files: [{ id: 'file-3', name: 'audio.m4a' }] },
    { id: 'clx_user_a3', role: 'USER', content: AUTO_PROMPT, files: null },
    { id: 'clx_asst_a3', role: 'ASSISTANT', content: RUNNING_TASK },
  ];
  const out = dedupeMessages(msgs);
  assert.deepEqual(out.map((m) => m.id), ['clx_user_a3', 'clx_asst_a3']);
  assert.equal((out[0] as { files?: Array<{ id: string }> }).files?.[0]?.id, 'file-3');
});
