'use strict';

/**
 * Edición milimétrica — Fase D (docs/specs/edicion-milimetrica/SPEC.md §7):
 * stage v2 SSE fields, thumbnails, object tool results and the persisted
 * activity trace. The F3 contract (tests/agent-runner-f3-traces.test.js)
 * stays unchanged: v2 only ADDS fields.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const trace = require('../src/services/agent-runner/trace');
const { runAgentLoop, thumbsToDataUrls, objectResultText } = require('../src/services/agent-runner/loop');
const { TOOL_DEFINITIONS } = require('../src/services/agent-runner/tools');
const {
  createActivityTraceCollector,
  createArtifactThumbSaver,
  MAX_TRACE_EVENTS,
} = require('../src/services/agent-runner/activity-trace');

const { toStageEvent, previewArgs, sanitizeThumbs, agentThumbsEnabled, STAGE_LABELS } = trace;

const SMALL_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

function scriptedClient(script) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (turn.toolCalls) {
            return {
              choices: [{
                message: {
                  content: null,
                  tool_calls: turn.toolCalls.map((c, idx) => ({
                    id: c.id || `call_${i}_${idx}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                },
              }],
            };
          }
          return { choices: [{ message: { content: turn.content } }] };
        },
      },
    },
  };
}

/* ── toStageEvent: stage v2 fields ───────────────────────────────────────── */

test('stage v2: a paired tool_call carries callId, kind, status running, description as label and a detail', () => {
  const ev = toStageEvent({
    type: 'tool_call',
    tool: 'office_edit',
    iteration: 3,
    callId: 'call_3_edit',
    description: 'Cambiando el año\nde la portada',
    label: 'Ejecutando código',
    args: { src: 'uploads/tesis.docx', dst: 'outputs/tesis-editado.docx', ops: [{ op: 'replace_text', find: '2024', replace: '2025' }] },
  });
  assert.equal(ev.type, 'stage');
  assert.equal(ev.step, 'tool_call');
  assert.equal(ev.callId, 'call_3_edit');
  assert.equal(ev.kind, 'edit');
  assert.equal(ev.status, 'running');
  assert.equal(ev.description, 'Cambiando el año de la portada', 'one line, no control characters');
  assert.equal(ev.label, 'Cambiando el año de la portada', 'the model phrase is the label');
  assert.match(ev.detail, /uploads\/tesis\.docx → outputs\/tesis-editado\.docx/);
  assert.match(ev.detail, /"find":"2024"/);
  assert.equal(ev.args, undefined, 'raw args never travel to the client');
});

test('stage v2: the SPEC contract for a verify_visual result (kind check, status done, thumbs)', () => {
  const thumb = `data:image/jpeg;base64,${SMALL_JPEG_B64}`;
  const ev = toStageEvent({
    type: 'tool_result',
    tool: 'verify_visual',
    iteration: 4,
    ok: true,
    preview: 'Verificación: tesis-editado.docx vs tesis.docx …',
    label: 'Verificando resultado',
    description: 'Comparando antes y después',
    callId: 'call_4_verify',
    thumbs: [thumb, 'javascript:alert(1)', 'https://evil.example/x.png'],
  });
  assert.deepEqual(
    { step: ev.step, tool: ev.tool, label: ev.label, ok: ev.ok, callId: ev.callId, kind: ev.kind, status: ev.status, description: ev.description },
    { step: 'tool_result', tool: 'verify_visual', label: 'Comparando antes y después', ok: true, callId: 'call_4_verify', kind: 'check', status: 'done', description: 'Comparando antes y después' },
  );
  assert.deepEqual(ev.thumbs, [thumb], 'only real image data URLs reach the client');
  assert.equal(ev.detail, 'Verificación: tesis-editado.docx vs tesis.docx …', 'result detail = preview');
  assert.equal(ev.preview, 'Verificación: tesis-editado.docx vs tesis.docx …');
});

test('stage v2: preview redacts synthetic credentials before reaching SSE and persisted trace', () => {
  const raw = 'ERROR: verificación fallida — sk-FakeSecret123456 Bearer abc.def.ghi AKIAABCDEFGHIJKLMNOP -----BEGIN PRIVATE KEY-----FAKEKEY';
  const ev = toStageEvent({
    type: 'tool_result', tool: 'verify_visual', callId: 'c_secret', ok: false, preview: raw,
  });
  assert.match(ev.preview, /^ERROR: verificación fallida/);
  assert.match(ev.preview, /\[secreto\]/);
  for (const secret of ['sk-FakeSecret123456', 'abc.def.ghi', 'AKIAABCDEFGHIJKLMNOP', 'FAKEKEY']) {
    assert.ok(!ev.preview.includes(secret), `stage.preview must redact ${secret}`);
    assert.ok(!ev.detail.includes(secret), `stage.detail must redact ${secret}`);
  }
  const error = toStageEvent({ type: 'error', message: 'Bearer abc.def.ghi' });
  assert.ok(!error.preview.includes('abc.def.ghi'), 'fallback error preview is also public');
});

test('stage v2: model description and explicit label cannot expose synthetic credentials', () => {
  const described = toStageEvent({
    type: 'tool_result', tool: 'verify_visual', callId: 'c_description', ok: false,
    description: 'Comparando sk-FakeDescription123456',
    label: 'Revisión Bearer abc.def.ghi',
    preview: 'ERROR: verificación fallida',
  });
  assert.match(described.description, /Comparando \[secreto\]/);
  assert.equal(described.label, described.description, 'model description wins as the visible label');
  assert.ok(!JSON.stringify(described).includes('sk-FakeDescription123456'));

  const explicit = toStageEvent({ type: 'stage', label: 'Preparando AKIAABCDEFGHIJKLMNOP' });
  assert.match(explicit.label, /Preparando \[secreto\]/);
  assert.ok(!JSON.stringify(explicit).includes('AKIAABCDEFGHIJKLMNOP'));
});

test('stage v2: a failed result is status error; thinking events are kind thinking; legacy events keep the v1 shape', () => {
  const failed = toStageEvent({ type: 'tool_result', tool: 'office_edit', ok: false, callId: 'c9', preview: 'ERROR: find no encontrado' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.kind, 'edit');
  assert.equal(failed.label, 'Reintentando', 'without a description the v1 label stays');

  assert.equal(toStageEvent({ type: 'iteration_start', iteration: 1 }).kind, 'thinking');
  assert.equal(toStageEvent({ type: 'thought', preview: 'voy a leer' }).kind, 'thinking');

  // No callId → a legacy producer (queue fast path, orchestrator): exact v1 shape.
  assert.deepEqual(toStageEvent({ type: 'tool_call', tool: 'execute_python', iteration: 2, preview: 'print(1)' }), {
    type: 'stage', step: 'tool_call', tool: 'execute_python', iteration: 2, preview: 'print(1)', label: 'Ejecutando código',
  });
  assert.equal(toStageEvent({ type: 'tool_call', tool: 'render_preview' }).label, 'Verificando resultado', 'F3 label unchanged');
});

test('stage v2: default phrases for the office tools; verify_visual is a verification tool', () => {
  assert.equal(toStageEvent({ type: 'tool_call', tool: 'inspect_document' }).label, 'Leyendo el documento');
  assert.equal(toStageEvent({ type: 'tool_call', tool: 'office_edit' }).label, 'Editando el documento');
  assert.equal(toStageEvent({ type: 'tool_call', tool: 'verify_visual' }).label, 'Comparando antes y después');
  assert.equal(STAGE_LABELS.comparing, 'Comparando antes y después');
  assert.ok(trace.VERIFY_TOOLS.has('verify_visual'));
  assert.ok(trace.VERIFY_TOOLS.has('render_preview'));
});

test('previewArgs: code / command / checklist, ≤600 characters, secrets redacted', () => {
  const code = [
    'import requests',
    'key = "sk-live_ABCDEFGHIJKLMNOP"',
    'requests.get(u, headers={"Authorization": "Bearer abc.def.ghi"})',
    'password=hunter2',
    'x = "' + 'A'.repeat(300) + '"',
  ].join('\n');
  const detail = previewArgs('execute_python', { code });
  assert.doesNotMatch(detail, /sk-live_ABCDEFGHIJKLMNOP/);
  assert.doesNotMatch(detail, /abc\.def\.ghi/);
  assert.doesNotMatch(detail, /hunter2/);
  assert.match(detail, /\[datos binarios\]/, 'long base64-like blobs are elided');
  assert.ok(previewArgs('execute_bash', { command: 'x'.repeat(2000) }).length <= 600);

  const verify = previewArgs('verify_visual', { before: 'uploads/t.docx', after: 'outputs/t.docx', checklist: ['2024 → 2025 en la portada', 'no cambia nada más'] });
  assert.equal(verify, 'uploads/t.docx → outputs/t.docx\n1. 2024 → 2025 en la portada\n2. no cambia nada más');
  assert.equal(previewArgs('inspect_document', { path: 'uploads/t.docx', query: 'Lima' }), 'uploads/t.docx\nquery: Lima');
  assert.equal(previewArgs('write_file', { path: 'outputs/a.md', content: 'x' }).includes('"path":"outputs/a.md"'), true);
  assert.equal(previewArgs('read_file', { path: 'uploads/a.md' }), 'uploads/a.md');
  assert.equal(previewArgs('execute_python', null), '');
});

test('sanitizeThumbs / agentThumbsEnabled', () => {
  const ok = `data:image/png;base64,${SMALL_JPEG_B64}`;
  assert.deepEqual(sanitizeThumbs([ok, ok, ok]), [ok, ok], 'at most 2');
  assert.deepEqual(sanitizeThumbs(['data:text/html;base64,PGI+', 'data:image/png;base64,<script>']), []);
  assert.deepEqual(sanitizeThumbs('nope'), []);

  assert.equal(agentThumbsEnabled({ NODE_ENV: 'test' }), false, 'off under NODE_ENV=test');
  assert.equal(agentThumbsEnabled({ NODE_ENV: 'production' }), true, 'on in production');
  assert.equal(agentThumbsEnabled({ NODE_ENV: 'production', SIRAGPT_AGENT_THUMBS: '0' }), false);
  assert.equal(agentThumbsEnabled({ NODE_ENV: 'test', SIRAGPT_AGENT_THUMBS: '1' }), true);
});

/* ── loop.js: object results + thumbnails ────────────────────────────────── */

test('loop: an object result without __f7Image never reaches the model as "[object Object]"', () => {
  assert.equal(objectResultText({ text: 'hola' }, false), 'hola');
  assert.equal(objectResultText({ __f7Image: { base64: 'x' } }, true), '[imagen capturada]');
  assert.equal(objectResultText({ __thumbs: [] }, false), '[resultado sin texto]');
  assert.equal(objectResultText({ ok: true, rows: 2, __thumbs: [] }, false), '{"ok":true,"rows":2}');
});

test('thumbsToDataUrls: ≤2, ≤80 KB, images only', () => {
  const small = { base64: SMALL_JPEG_B64, mediaType: 'image/jpeg', bytes: 10 };
  const big = { base64: 'A'.repeat(120_000), mediaType: 'image/jpeg', bytes: 90 * 1024 };
  const bigNoBytes = { base64: 'A'.repeat(120_000), mediaType: 'image/jpeg' };
  const html = { base64: SMALL_JPEG_B64, mediaType: 'text/html', bytes: 10 };
  assert.deepEqual(thumbsToDataUrls([small, big, bigNoBytes, html]), [`data:image/jpeg;base64,${SMALL_JPEG_B64}`]);
  assert.equal(thumbsToDataUrls([big]), undefined, 'a thumbnail over 80 KB is dropped');
  assert.equal(thumbsToDataUrls([small, small, small]).length, 2);
  assert.equal(thumbsToDataUrls(null), undefined);
});

async function runVerifyTurn({ thumbs, thumbBytes = 10 }) {
  const events = [];
  const messages = [{ role: 'user', content: 'Cambia 2024 por 2025 en la portada' }];
  const client = scriptedClient([
    { toolCalls: [{ id: 'call_edit', name: 'office_edit', args: { src: 'uploads/t.docx', ops: [{ op: 'replace_text', find: '2024', replace: '2025' }] } }] },
    { toolCalls: [{ id: 'call_verify', name: 'verify_visual', args: { before: 'uploads/t.docx', after: 'outputs/t.docx', checklist: ['2025 en la portada'], description: 'Comparando la portada antes y después' } }] },
    { content: 'Listo: cambié 2024 por 2025 y lo verifiqué.' },
  ]);
  const result = await runAgentLoop({
    client,
    model: 'test/model',
    messages,
    tools: TOOL_DEFINITIONS,
    thumbs,
    executors: {
      async office_edit() { return '{"ok":true,"dst":"outputs/t.docx"}'; },
      async verify_visual() {
        return {
          text: 'Verificación OK\nVEREDICTO: VERIFICADO',
          __thumbs: [{ base64: SMALL_JPEG_B64, mediaType: 'image/jpeg', bytes: thumbBytes }],
        };
      },
    },
    maxIterations: 6,
    onEvent: (ev) => events.push(ev),
  });
  return { result, events, messages };
}

test('loop: a { text, __thumbs } result → the model sees the text, the timeline gets the thumbnail', async () => {
  const { result, events, messages } = await runVerifyTurn({ thumbs: true });
  assert.equal(result.stoppedReason, 'final');
  const toolMsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_verify');
  assert.equal(toolMsg.content, 'Verificación OK\nVEREDICTO: VERIFICADO');
  assert.ok(!messages.some((m) => typeof m.content === 'string' && m.content.includes('[object Object]')));

  const stages = events.map(toStageEvent).filter(Boolean);
  const editCall = stages.find((s) => s.step === 'tool_call' && s.tool === 'office_edit');
  assert.equal(editCall.label, 'Editando el documento', 'no description → the office default phrase');
  assert.equal(editCall.callId, 'call_edit');
  const verifyResult = stages.find((s) => s.step === 'tool_result' && s.tool === 'verify_visual');
  assert.equal(verifyResult.callId, 'call_verify');
  assert.equal(verifyResult.status, 'done');
  assert.equal(verifyResult.kind, 'check');
  assert.equal(verifyResult.description, 'Comparando la portada antes y después', 'the result carries the call phrase');
  assert.equal(verifyResult.label, 'Comparando la portada antes y después');
  assert.deepEqual(verifyResult.thumbs, [`data:image/jpeg;base64,${SMALL_JPEG_B64}`]);
});

test('loop: thumbnails off (flag) or over 80 KB never reach the SSE', async () => {
  const off = await runVerifyTurn({ thumbs: false });
  const offResult = off.events.find((e) => e.type === 'tool_result' && e.tool === 'verify_visual');
  assert.equal(offResult.thumbs, undefined);
  const big = await runVerifyTurn({ thumbs: true, thumbBytes: 81 * 1024 });
  const bigResult = big.events.find((e) => e.type === 'tool_result' && e.tool === 'verify_visual');
  assert.equal(bigResult.thumbs, undefined);
  // NODE_ENV=test default: off.
  const dflt = await runVerifyTurn({ thumbs: null });
  assert.equal(dflt.events.find((e) => e.type === 'tool_result' && e.tool === 'verify_visual').thumbs, undefined);
});

/* ── D.3 persisted trace ─────────────────────────────────────────────────── */

test('activity trace: compact stage copies, thumbnails stored as artifact URLs (never base64)', () => {
  const saved = [];
  const collector = createActivityTraceCollector({
    saveThumb: (dataUrl, { callId, index }) => { saved.push({ dataUrl, callId, index }); return `/api/agent/artifact/abc${saved.length}?name=t.jpg`; },
  });
  const thumb = `data:image/jpeg;base64,${SMALL_JPEG_B64}`;
  collector.push(toStageEvent({ type: 'tool_call', tool: 'verify_visual', callId: 'c1', description: 'Comparando', args: { after: 'outputs/t.docx', checklist: ['x'] } }));
  collector.push(toStageEvent({ type: 'tool_result', tool: 'verify_visual', callId: 'c1', ok: true, preview: 'OK', description: 'Comparando', thumbs: [thumb] }));
  collector.push({ type: 'not-a-stage' });
  const meta = collector.toMetadata();
  assert.equal(meta.kind, 'agent_runner_trace');
  assert.equal(meta.version, 2);
  assert.equal(meta.activityTrace.length, 2);
  assert.equal(meta.activityTrace[0].status, 'running');
  assert.equal(meta.activityTrace[1].status, 'done');
  assert.deepEqual(meta.activityTrace[1].thumbs, ['/api/agent/artifact/abc1?name=t.jpg']);
  assert.equal(saved[0].callId, 'c1');
  assert.doesNotMatch(JSON.stringify(meta), /base64/, 'no base64 in the persisted trace');
  assert.equal(meta.steps, undefined, 'no `steps`: the AgentTrace timeline never renders a second copy');
});

test('activity trace: a thumbnail that cannot be stored is dropped; at most 6 per turn', () => {
  const failing = createActivityTraceCollector({ saveThumb: () => { throw new Error('disk full'); } });
  const thumb = `data:image/jpeg;base64,${SMALL_JPEG_B64}`;
  failing.push(toStageEvent({ type: 'tool_result', tool: 'render_preview', callId: 'r1', ok: true, thumbs: [thumb] }));
  assert.equal(failing.toMetadata().activityTrace[0].thumbs, undefined);

  let n = 0;
  const capped = createActivityTraceCollector({ saveThumb: () => `/api/agent/artifact/t${++n}` });
  for (let i = 0; i < 5; i += 1) {
    capped.push(toStageEvent({ type: 'tool_result', tool: 'render_preview', callId: `r${i}`, ok: true, thumbs: [thumb, thumb] }));
  }
  const all = capped.toMetadata().activityTrace.flatMap((e) => e.thumbs || []);
  assert.equal(all.length, 6);

  const none = createActivityTraceCollector({});
  none.push(toStageEvent({ type: 'tool_result', tool: 'render_preview', callId: 'r1', ok: true, thumbs: [thumb] }));
  assert.equal(none.toMetadata().activityTrace[0].thumbs, undefined, 'no saver → dropped, never inlined');
  assert.equal(createActivityTraceCollector({}).toMetadata(), null, 'nothing to persist');
});

test('activity trace: ≤60 events — «Pensando» ticks go first, then the oldest steps (the first stays)', () => {
  const c = createActivityTraceCollector({});
  c.push(toStageEvent({ type: 'stage', label: 'Agente trabajando', tool: 'agent_runner' }));
  for (let i = 1; i <= 40; i += 1) {
    c.push(toStageEvent({ type: 'iteration_start', iteration: i }));
    c.push(toStageEvent({ type: 'tool_call', tool: 'execute_python', callId: `c${i}`, args: { code: `print(${i})` } }));
  }
  const meta = c.toMetadata();
  assert.equal(meta.activityTrace.length, MAX_TRACE_EVENTS);
  assert.equal(meta.activityTrace[0].label, 'Agente trabajando');
  assert.equal(meta.activityTrace.filter((e) => e.step === 'tool_call').length, 40, 'every tool step survives');
  assert.equal(meta.omitted, 81 - MAX_TRACE_EVENTS);

  const d = createActivityTraceCollector({});
  for (let i = 1; i <= 70; i += 1) d.push(toStageEvent({ type: 'tool_call', tool: 'execute_bash', callId: `b${i}`, args: { command: `echo ${i}` } }));
  const dm = d.toMetadata();
  assert.equal(dm.activityTrace.length, MAX_TRACE_EVENTS);
  assert.equal(dm.activityTrace[0].callId, 'b1', 'the first step stays');
  assert.equal(dm.activityTrace[MAX_TRACE_EVENTS - 1].callId, 'b70', 'the latest steps stay');
  assert.equal(dm.omitted, 10);
});

test('artifact thumb saver: owner-scoped, NOT tied to the chat, images only', () => {
  const calls = [];
  const saver = createArtifactThumbSaver({
    userId: 'u1',
    saveArtifact: (args) => { calls.push(args); return { id: 'abc', downloadUrl: '/api/agent/artifact/abc?name=x.jpg' }; },
  });
  assert.equal(saver(`data:image/jpeg;base64,${SMALL_JPEG_B64}`, { callId: 'call_4/../x', index: 0 }), '/api/agent/artifact/abc?name=x.jpg');
  assert.equal(calls[0].ownerUserId, 'u1');
  assert.equal(calls[0].chatId, null, 'never a conversation artifact (follow-ups edit the real document)');
  assert.equal(calls[0].category, 'agent_trace_thumb');
  assert.equal(calls[0].mime, 'image/jpeg');
  assert.match(calls[0].filename, /^timeline-call_4x-1\.jpg$/);
  assert.equal(saver('data:text/html;base64,PGI+'), null);
  assert.equal(createArtifactThumbSaver({ userId: null }), null, 'no user → no saver');
});

test('activity trace: live-progress rows keep stageId / phase / elapsedMs; tool_progress ticks are never persisted', () => {
  let clock = 1000;
  const collector = createActivityTraceCollector({ now: () => clock });
  const base = { type: 'stage', tool: 'read_file', phase: 'attachments', stageId: 'pipe:attachments:1' };
  collector.push({ ...base, label: 'Leyendo «contrato.pdf»', step: 'tool_call', status: 'running' });
  clock = 1400;
  collector.push({ ...base, label: 'Extrayendo el texto de «contrato.pdf»', step: 'tool_progress', status: 'running', detail: '12.340 palabras' });
  clock = 2800;
  collector.push({ ...base, label: 'Archivo listo', step: 'tool_result', status: 'done', ok: true, detail: '1 documento · 12.340 palabras', elapsedMs: 1800 });
  const meta = collector.toMetadata();
  assert.equal(meta.activityTrace.length, 2);
  const [begin, result] = meta.activityTrace;
  assert.deepEqual(begin, { at: 0, step: 'tool_call', tool: 'read_file', label: 'Leyendo «contrato.pdf»', status: 'running', stageId: 'pipe:attachments:1', phase: 'attachments' });
  assert.equal(result.stageId, 'pipe:attachments:1');
  assert.equal(result.phase, 'attachments');
  assert.equal(result.elapsedMs, 1800);
  assert.equal(result.ok, true);
  assert.equal(result.detail, '1 documento · 12.340 palabras');
  assert.equal(result.at, 1800);
});

/* ── wiring (source contracts) ───────────────────────────────────────────── */

test('wiring: the chat streams + collects runner stages and persists them with the assistant row', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const stream = read('src/services/agentic-chat-stream.js');
  assert.match(stream, /agentRunnerTrace = createActivityTraceCollector\(\{\s*saveThumb: createArtifactThumbSaver\(\{ userId: toolContext\.userId \}\),/);
  assert.match(stream, /if \(agentRunnerTrace\) agentRunnerTrace\.push\(stage\);\s*await writeSse\(res, stage\);/);
  assert.match(stream, /reason === 'agent_runner' \|\| reason === 'agent_runner_failed'/);
  // Fase G: the document-edit pre-step persists its timeline the same way.
  assert.match(stream, /reason\.startsWith\('source_preserving_document'\) \? documentEditTrace : null/);
  assert.match(stream, /if \(documentEditTrace\) \{ try \{ documentEditTrace\.push\(frame\); \}/);
  assert.match(stream, /\.\.\.\(agentActivityTrace \? \{ agentActivityTrace \} : \{\}\)/);

  const ai = read('src/routes/ai.js');
  assert.match(ai, /req\._agentActivityTrace = agenticResult\.agentActivityTrace \|\| null;/);
  // AgentRunner trace first; a plain / agentic-chat turn persists its live
  // pipeline timeline (services/turn-progress) instead.
  assert.equal((ai.match(/activityTrace: req\._agentActivityTrace \|\| req\._turnProgress\?\.toMetadata\(\{ durationMs: __firstByteAt \? __firstByteAt - __generateStartedAt : null \}\) \|\| null/g) || []).length, 2, 'both generate save paths');
  assert.match(ai, /rlhfFeedback = null, activityTrace = null \} = \{\}\) \{/);
  assert.match(ai, /activityTrace && typeof activityTrace === 'object' && !agentRun\s*\?\s*\{ agentMetadata: activityTrace \}/);
  assert.match(ai, /_attempt \+ 1, \{ observabilityLog: persistenceLog, activityTrace, skipUsageMetering \}\)/);

  const index = read('src/services/agent-runner/index.js');
  assert.match(index, /thumbs: agentThumbsEnabled\(\),/);
});

test('a file listing reads as «Revisando los archivos», not «Ejecutando código»', () => {
  const { labelForToolCall } = require('../src/services/agent-runner/trace');
  assert.equal(labelForToolCall('list_files'), 'Revisando los archivos');
  assert.equal(labelForToolCall('execute_python'), 'Ejecutando código');
});
