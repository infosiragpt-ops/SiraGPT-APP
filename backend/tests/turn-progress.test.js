'use strict';

// Live progress of a chat turn (services/turn-progress): the frame contract
// the thinking timeline relies on, throttling, persistence, display names
// and the Spanish labels.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tp = require('../src/services/turn-progress');
const { frameShowsProviderFirstByte } = require('../src/services/generate-first-byte');
const { createActivityTraceCollector } = require('../src/services/agent-runner/activity-trace');

function harness({ protocol = 2, env = {}, canWrite = () => true, collector = null } = {}) {
  let t = 1_000_000;
  const timers = [];
  const frames = [];
  const emitStage = (label, extra = {}) => {
    if (!label) return;
    frames.push({ type: 'stage', label, ...extra });
  };
  const progress = tp.createTurnProgress({
    emitStage,
    protocol,
    canWriteProgress: canWrite,
    collector,
    env,
    now: () => t,
    setTimer: (fn, ms) => {
      const handle = { fn, at: t + ms, cleared: false, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => { if (handle) handle.cleared = true; },
    log: { warn() {} },
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((h) => !h.cleared && h.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = Math.max(t, due.at);
      due.cleared = true;
      due.fn();
    }
    t = end;
  };
  return { progress, frames, advance, timers, now: () => t };
}

const FORBIDDEN = ['content', 'replace', 'error', 'callId'];

test('frames never carry content / replace / error / callId', () => {
  const { progress, frames, advance } = harness();
  const a = progress.begin('attachments', 'Leyendo «contrato.pdf»', { tool: 'read_file', detail: 'x', meta: { files: 1 } });
  a.update({ detail: '38 páginas' });
  advance(1500);
  a.update({ detail: '38 páginas · 12.340 palabras' });
  a.done('Archivos listos');
  const m = progress.begin('model', 'Conectando con DeepSeek V4 Pro', { tool: 'model' });
  m.fail('DeepSeek V4 Pro no pudo responder (sin saldo)', { category: 'billing' });
  progress.note('context', 'Contexto listo · ~12.400 tokens', { tool: 'plan' });
  assert.ok(frames.length >= 5);
  for (const frame of frames) {
    for (const key of FORBIDDEN) assert.equal(Object.prototype.hasOwnProperty.call(frame, key), false, `${key} in ${JSON.stringify(frame)}`);
  }
});

test('no frame counts as the provider first byte; a document-work tool is coerced to pipeline', () => {
  const { progress, frames } = harness();
  const h = progress.begin('attachments', 'Editando', { tool: 'document_edit' });
  h.done();
  progress.begin('rag', 'Indexando', { tool: 'agent_runner' }).done();
  progress.begin('x', 'Algo', { tool: 'create_document' }).fail('Falló');
  progress.begin('model', 'Conectando', { tool: 'model' }).done();
  progress.note('web', 'Nota', { tool: 'web_search' });
  for (const frame of frames) {
    assert.equal(frameShowsProviderFirstByte(frame), false, JSON.stringify(frame));
    assert.ok(tp.PIPELINE_TOOLS.has(frame.tool), frame.tool);
  }
  assert.equal(frames[0].tool, 'pipeline');
  assert.equal(frames.find((f) => f.label === 'Indexando').tool, 'pipeline');
  // An unknown tool is never forwarded verbatim either.
  progress.begin('misc', 'Otro', { tool: 'host_bash' });
  assert.equal(frames[frames.length - 1].tool, 'pipeline');
});

test('protocol 1 emits begin frames only, in the legacy shape', () => {
  const { progress, frames, advance } = harness({ protocol: 1 });
  const h = progress.begin('attachments', 'Leyendo «a.pdf»', { tool: 'read_file', detail: 'd', meta: { files: 1 } });
  h.update({ detail: 'otra' });
  advance(3000);
  h.update({ label: 'Leyendo 2', detail: 'mas' });
  advance(3000);
  h.done('Listo');
  progress.note('context', 'Contexto listo', { tool: 'plan' });
  assert.deepEqual(frames, [
    { type: 'stage', label: 'Leyendo «a.pdf»', tool: 'read_file' },
    { type: 'stage', label: 'Contexto listo', tool: 'plan' },
  ]);
  assert.equal(progress.protocol, 1);
});

test('protocol 2 shapes: stable stageId across begin / progress / result, elapsedMs from the clock', () => {
  const { progress, frames, advance } = harness();
  const h = progress.begin('attachments', 'Leyendo «a.pdf»', { tool: 'read_file', kind: 'document', meta: { files: 1 } });
  advance(1200);
  h.update({ detail: '38 páginas' });
  advance(600);
  h.done('Archivos listos', { detail: '38 páginas · 12.340 palabras', meta: { pages: 38, words: 12340 } });
  assert.equal(frames.length, 3);
  const [b, p, r] = frames;
  assert.match(b.stageId, /^pipe:attachments:\d+$/);
  assert.equal(p.stageId, b.stageId);
  assert.equal(r.stageId, b.stageId);
  assert.deepEqual(b, { type: 'stage', label: 'Leyendo «a.pdf»', tool: 'read_file', phase: 'attachments', stageId: b.stageId, step: 'tool_call', status: 'running', kind: 'document', meta: { files: 1 } });
  assert.equal(p.step, 'tool_progress');
  assert.equal(p.status, 'running');
  assert.equal(p.detail, '38 páginas');
  assert.equal(r.step, 'tool_result');
  assert.equal(r.status, 'done');
  assert.equal(r.ok, true);
  assert.equal(r.elapsedMs, 1800);
  assert.deepEqual(r.meta, { pages: 38, words: 12340 });
  // Repeated phases stay distinct rows.
  const again = progress.begin('attachments', 'Leyendo «b.pdf»', { tool: 'read_file' });
  assert.notEqual(again.stageId, b.stageId);
  // A failure is an error result with ok:false.
  again.fail('No pude leer «b.pdf»', { category: 'timeout' });
  const last = frames[frames.length - 1];
  assert.equal(last.status, 'error');
  assert.equal(last.ok, false);
  assert.equal(last.detail, 'No respondió a tiempo');
  // A settled handle ignores later calls.
  again.done('otra vez');
  again.update({ detail: 'tarde' });
  assert.equal(frames[frames.length - 1], last);
});

test('progress is throttled: ≤1 per row per second (+ trailing flush) and ≤4 per second per turn', () => {
  const { progress, frames, advance } = harness();
  const h = progress.begin('rag', 'Buscando pasajes', { tool: 'rag_retrieve' });
  for (let i = 0; i < 10; i += 1) {
    h.update({ detail: `paso ${i}` });
    advance(90);
  }
  const burst = frames.filter((f) => f.step === 'tool_progress');
  assert.equal(burst.length, 1, 'one frame inside the first second');
  advance(1000);
  const flushed = frames.filter((f) => f.step === 'tool_progress');
  assert.equal(flushed.length, 2, 'the trailing flush sends the latest state');
  assert.equal(flushed[1].detail, 'paso 9');

  // Six rows updated four times a second: the turn never exceeds 4
  // progress frames in any 1000 ms window.
  const rec = [];
  let clock = 0;
  const timers = [];
  const p2 = tp.createTurnProgress({
    emitStage: (label, extra) => { if (extra.step === 'tool_progress') rec.push(clock); },
    protocol: 2,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
  });
  const rows = [0, 1, 2, 3, 4, 5].map((i) => p2.begin(`q${i}`, `Fase ${i}`));
  const step = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cleared && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = Math.max(clock, due.at);
      due.cleared = true;
      due.fn();
    }
    clock = end;
  };
  for (let round = 0; round < 12; round += 1) {
    rows.forEach((row, i) => row.update({ detail: `r${round}-${i}` }));
    step(250);
  }
  step(3000);
  assert.ok(rec.length > 4, 'progress keeps flowing');
  for (let i = 0; i < rec.length; i += 1) {
    const inWindow = rec.filter((x) => x >= rec[i] && x < rec[i] + 1000).length;
    assert.ok(inWindow <= 4, `≤4 progress frames per second (got ${inWindow} from t=${rec[i]})`);
  }
});

test('done cancels a pending progress frame', () => {
  const { progress, frames, advance } = harness();
  const h = progress.begin('memory', 'Consultando tu memoria', { tool: 'memory' });
  h.update({ detail: 'uno' });
  h.update({ detail: 'dos' }); // throttled → pending
  h.done('Memoria consultada');
  advance(5000);
  const kinds = frames.map((f) => f.step);
  assert.deepEqual(kinds, ['tool_call', 'tool_progress', 'tool_result']);
  assert.equal(frames[2].detail, 'dos', 'the result carries the latest state');
});

test('backpressure drops progress frames but never begin / result', () => {
  const { progress, frames, advance } = harness({ canWrite: () => false });
  const h = progress.begin('web', 'Buscando en la web', { tool: 'web_search' });
  h.update({ detail: 'uno' });
  advance(2000);
  h.update({ detail: 'dos' });
  advance(2000);
  h.done('Fuentes encontradas');
  assert.deepEqual(frames.map((f) => f.step), ['tool_call', 'tool_result']);
});

test('labels ≤ 90 chars, details ≤ 200, control characters stripped, meta is a numeric whitelist', () => {
  const { progress, frames } = harness();
  const h = progress.begin('attachments', `Leyendo «${'x'.repeat(200)}»\u0000\u0007`, {
    tool: 'read_file',
    detail: `a\nb\tc\u0000${'y'.repeat(400)}`,
    meta: { files: 2, pages: Infinity, words: '12', secret: 5, tokens: NaN, bytes: 1024 },
  });
  h.done();
  for (const frame of frames) {
    assert.ok(frame.label.length <= 90, frame.label.length);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(frame.label, /[\u0000-\u001f]/);
    if (frame.detail) {
      assert.ok(frame.detail.length <= 200);
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(frame.detail, /[\u0000-\u001f]/);
      assert.match(frame.detail, /^a b c/);
    }
  }
  assert.deepEqual(frames[0].meta, { files: 2, bytes: 1024 });
});

test('model labels are display names only: never a raw id, never a transport', () => {
  assert.equal(tp.modelLabel('deepseek-v4-pro'), 'DeepSeek V4 Pro');
  assert.equal(tp.modelLabel('deepseek-v4-flash'), 'DeepSeek V4 Flash');
  assert.equal(tp.modelLabel('deepseek/deepseek-v4-pro'), 'DeepSeek V4 Pro');
  assert.equal(tp.modelLabel('kimi-k2.6'), 'Kimi K2.6');
  for (const id of ['openrouter/auto', 'unknown-model-xyz', 'meta-llama/llama-9-private', 'claude-fable-5-1', '', null]) {
    const label = tp.modelLabel(id);
    assert.equal(label, 'el modelo', String(id));
    assert.doesNotMatch(label, /openrouter|\//i);
  }
  const { progress, frames } = harness();
  const sink = progress.modelSink({ contextTokens: 12400 });
  for (const model of ['openrouter/auto', 'x-private/secret-model-7', 'deepseek-v4-pro']) {
    sink({ type: 'attempt_start', model, attempt: 1, maxAttempts: 2 });
    sink({ type: 'first_byte', model, kind: 'content', ms: 1400 });
  }
  for (const frame of frames) {
    assert.doesNotMatch(`${frame.label} ${frame.detail || ''}`, /openrouter|secret-model|x-private|\//i);
  }
  assert.ok(frames.some((f) => f.label === 'Conectando con DeepSeek V4 Pro'));
  assert.ok(frames.some((f) => f.label === 'DeepSeek V4 Pro respondió · 1,4 s'));
  assert.ok(frames.some((f) => f.label === 'Conectando con el modelo'));
});

test('SIRAGPT_TURN_PROGRESS=0 keeps the legacy phases only, on protocol 1', () => {
  const { progress, frames } = harness({ protocol: 2, env: { SIRAGPT_TURN_PROGRESS: '0' } });
  assert.equal(progress.protocol, 1);
  assert.equal(progress.enabled, false);
  progress.begin('attachments', 'Leyendo «a.pdf»', { tool: 'read_file' }).done();
  progress.begin('memory', 'Consultando tu memoria', { tool: 'memory' }).done();
  progress.begin('rag', 'Buscando pasajes', { tool: 'rag_retrieve' }).done();
  progress.begin('web', 'Buscando en la web', { tool: 'web_search' }).done();
  progress.begin('history', 'Comprimiendo el contexto (8 mensajes)', { tool: 'compact' }).done();
  progress.begin('vision', 'Preparando la imagen', { tool: 'vision' }).done();
  progress.begin('model', 'Conectando con DeepSeek V4 Pro', { tool: 'model' }).done();
  progress.note('context', 'Contexto listo', { tool: 'plan' });
  assert.deepEqual(frames.map((f) => f.label), [
    'Leyendo «a.pdf»',
    'Buscando en la web',
    'Comprimiendo el contexto (8 mensajes)',
    'Preparando la imagen',
    'Conectando con DeepSeek V4 Pro',
  ]);
  for (const f of frames) assert.deepEqual(Object.keys(f).sort(), ['label', 'tool', 'type']);
});

test('the collector persists begin / result (not progress) and toMetadata honours durationMs', () => {
  let clock = 0;
  const collector = createActivityTraceCollector({ now: () => clock });
  const { progress, advance } = harness({ collector });
  const h = progress.begin('attachments', 'Leyendo «a.pdf»', { tool: 'read_file' });
  advance(1200);
  clock = 1200;
  h.update({ detail: '38 páginas' });
  advance(1500);
  h.update({ detail: '38 páginas · 12.340 palabras' });
  clock = 2400;
  h.done('Archivos listos');
  progress.note('context', 'Contexto listo · ~12.400 tokens', { tool: 'plan' });
  const meta = progress.toMetadata({ durationMs: 4321 });
  assert.equal(meta.durationMs, 4321);
  const trace = meta.activityTrace;
  assert.equal(trace.length, 3);
  assert.equal(trace.some((e) => e.step === 'tool_progress'), false);
  assert.equal(trace[0].stageId, trace[1].stageId);
  assert.equal(trace[0].phase, 'attachments');
  assert.equal(trace[1].status, 'done');
  assert.equal(trace[1].elapsedMs, 2700);
  assert.equal(trace[1].detail, '38 páginas · 12.340 palabras');
  assert.equal(trace[2].label, 'Contexto listo · ~12.400 tokens');
  assert.equal(trace[2].elapsedMs, undefined, 'an instant note carries no duration');
  // Without a collector there is nothing to persist.
  assert.equal(harness().progress.toMetadata({ durationMs: 1 }), null);
});

test('formatters: Spanish grouping, durations and sizes', () => {
  assert.equal(tp.fmtInt(1240), '1.240');
  assert.equal(tp.fmtInt(12340), '12.340');
  assert.equal(tp.fmtInt(420), '420');
  assert.equal(tp.fmtInt(1234567), '1.234.567');
  assert.equal(tp.fmtMs(180), '180 ms');
  assert.equal(tp.fmtMs(1840), '1,8 s');
  assert.equal(tp.fmtMs(12000), '12 s');
  assert.equal(tp.fmtMs(65000), '1 min 5 s');
  assert.equal(tp.fmtMs(120000), '2 min');
  assert.equal(tp.fmtBytes(2_400_000), '2,3 MB');
  assert.equal(tp.fmtBytes(34 * 1024), '34 KB');
  assert.equal(tp.fmtBytes(512), '512 B');
});

test('model event labels: timeout, rate limit, billing, retry — never the provider text', () => {
  const secret = 'Error: 402 {"error":{"message":"sk-live-SECRET insufficient credits for org_123"}}';
  const timeout = tp.modelEventLabel({ type: 'attempt_failed', category: 'timeout', timeoutMs: 30000, attempt: 1, maxAttempts: 2, willRetry: true, message: secret }, 'DeepSeek V4 Flash');
  assert.equal(timeout, 'DeepSeek V4 Flash no respondió en 30 s · reintento 2 de 2');
  const rate = tp.modelEventLabel({ type: 'attempt_failed', category: 'rate_limit', retryAfterSeconds: 12, attempt: 2, maxAttempts: 2, willRetry: false, message: secret }, 'Gemini 2.5 Flash');
  assert.equal(rate, 'Gemini 2.5 Flash alcanzó el límite por minuto · espera 12 s');
  const billing = tp.modelEventLabel({ type: 'failover', reason: 'billing', message: secret }, 'DeepSeek V4 Flash');
  assert.equal(billing, 'DeepSeek V4 Flash no disponible (sin saldo)');
  const retry = tp.modelEventLabel({ type: 'attempt_start', attempt: 2, maxAttempts: 2 }, 'DeepSeek V4 Pro');
  assert.equal(retry, 'Reintentando con DeepSeek V4 Pro · intento 2 de 2');
  const failed = tp.modelEventLabel({ type: 'failed', category: 'auth', message: secret }, 'el modelo');
  assert.equal(failed, 'El modelo no pudo responder (clave rechazada)');
  for (const label of [timeout, rate, billing, retry, failed]) {
    assert.doesNotMatch(label, /SECRET|sk-live|org_123|insufficient|402/);
  }
  assert.equal(tp.errorCategoryEs('billing'), 'no tiene saldo en su proveedor');
  assert.equal(tp.errorCategoryEs('unconfigured'), 'no está configurado');
});

test('web label caps the query at 60 chars; sources note lists the top 3 domains', () => {
  const long = 'precio del cobre 2026 en la bolsa de metales de Londres y proyecciones para el año siguiente';
  const label = tp.webLabel(long);
  assert.match(label, /^Buscando en la web · “/);
  const quoted = label.slice(label.indexOf('“') + 1, label.lastIndexOf('”'));
  assert.ok(quoted.length <= 60, quoted.length);
  assert.equal(tp.webLabel(''), 'Buscando en la web');
  const note = tp.sourcesNote([
    { url: 'https://www.reuters.com/a' },
    { url: 'https://reuters.com/b' },
    { domain: 'bbc.com' },
    { url: 'https://elpais.com/x' },
    { url: 'https://lanacion.com.ar/y' },
    { url: 'not a url' },
  ]);
  assert.equal(note, '6 fuentes · reuters.com, bbc.com, elpais.com');
  assert.equal(tp.sourcesNote([{ url: 'https://a.com' }]), '1 fuente · a.com');
  assert.equal(tp.sourcesNote([]), '');
});

test('model sink: connect → waiting → first byte, retries and failures by category', () => {
  const { progress, frames, advance } = harness();
  const sink = progress.modelSink({ contextTokens: 12400 });
  const vision = progress.begin('vision', 'Preparando 2 imágenes para el modelo', { tool: 'vision' });
  sink({ type: 'vision_prep', files: 2 });
  sink({ type: 'vision_ready', requested: 2, loaded: 2, stripped: 0 });
  assert.equal(vision.open, false, 'the images reaching the model settle the preparation');
  assert.equal(frames.filter((f) => f.phase === 'vision').pop().label, '2 imágenes listas para el modelo');
  // `thinking` is the level the provider really received (ai-service).
  sink({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 1, maxAttempts: 2, slot: 1, slots: 1, thinking: 'high' });
  const begin = frames.find((f) => f.phase === 'model' && f.step === 'tool_call');
  assert.equal(begin.label, 'Conectando con DeepSeek V4 Pro');
  assert.equal(begin.detail, 'contexto ~12.400 tokens · razonamiento alto · 2 imágenes');
  advance(8000);
  sink({ type: 'waiting', model: 'deepseek-v4-pro', attempt: 1, waitedMs: 8000, timeoutMs: 30000, willRetry: true });
  advance(12000);
  sink({ type: 'waiting', model: 'deepseek-v4-pro', attempt: 1, waitedMs: 20000, timeoutMs: 30000, willRetry: true });
  advance(10000);
  sink({ type: 'attempt_failed', model: 'deepseek-v4-pro', attempt: 1, maxAttempts: 2, category: 'timeout', timeoutMs: 30000, willRetry: true });
  advance(1000);
  sink({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 2, maxAttempts: 2, thinking: 'high' });
  advance(3200);
  sink({ type: 'first_byte', model: 'deepseek-v4-pro', kind: 'reasoning', ms: 3200 });
  const modelFrames = frames.filter((f) => f.phase === 'model');
  const details = modelFrames.map((f) => f.detail).filter(Boolean);
  assert.ok(details.includes('Sin respuesta todavía · procesando ~12.400 tokens de contexto'));
  assert.ok(details.includes('Tarda más de lo habitual · reintento automático a los 30 s'));
  assert.ok(modelFrames.some((f) => f.label === 'DeepSeek V4 Pro no respondió en 30 s · reintento 2 de 2'));
  assert.ok(modelFrames.some((f) => f.label === 'Reintentando con DeepSeek V4 Pro · intento 2 de 2'));
  const result = modelFrames[modelFrames.length - 1];
  assert.equal(result.step, 'tool_result');
  assert.equal(result.label, 'DeepSeek V4 Pro empezó a razonar · 3,2 s');
  assert.equal(new Set(modelFrames.map((f) => f.stageId)).size, 1, 'retries stay on one row');

  // A picked model that cannot answer: the row fails with the exact cause.
  const second = harness();
  const s2 = second.progress.modelSink({});
  s2({ type: 'attempt_start', model: 'deepseek-v4-flash', attempt: 1, maxAttempts: 2 });
  s2({ type: 'failed', model: 'deepseek-v4-flash', category: 'billing' });
  const last = second.frames[second.frames.length - 1];
  assert.equal(last.status, 'error');
  assert.equal(last.label, 'DeepSeek V4 Flash no pudo responder (sin saldo)');
  assert.equal(last.detail, 'No tiene saldo en su proveedor');

  // Internal failover, in the exact order ai-service emits it: the dry
  // model's row fails, the next model's row is reused by its own
  // attempt_start (nothing failed there) and ends done.
  const third = harness();
  const s3 = third.progress.modelSink({});
  s3({ type: 'attempt_start', model: 'deepseek-v4-flash', attempt: 1, maxAttempts: 2 });
  s3({ type: 'attempt_failed', model: 'deepseek-v4-flash', attempt: 1, maxAttempts: 2, category: 'billing', willRetry: false });
  s3({ type: 'failover', from: 'deepseek-v4-flash', to: 'gemini-2.5-flash', reason: 'billing' });
  s3({ type: 'attempt_start', model: 'gemini-2.5-flash', attempt: 1, maxAttempts: 2 });
  s3({ type: 'first_byte', model: 'gemini-2.5-flash', kind: 'content', ms: 1400 });
  const labels = third.frames.map((f) => `${f.step}:${f.status}:${f.label}`);
  assert.deepEqual(labels, [
    'tool_call:running:Conectando con DeepSeek V4 Flash',
    'tool_progress:running:DeepSeek V4 Flash no tiene saldo en su proveedor',
    'tool_result:error:DeepSeek V4 Flash no disponible (sin saldo)',
    'tool_call:running:Conectando con Gemini 2.5 Flash',
    // attempt_start of the same model refreshes the row in place (attempt
    // n of m) — a progress frame, never a failure.
    'tool_progress:running:Conectando con Gemini 2.5 Flash',
    'tool_result:done:Gemini 2.5 Flash respondió · 1,4 s',
  ]);
  const errors = third.frames.filter((f) => f.status === 'error');
  assert.equal(errors.length, 1, 'only the dry model is an error row');
  const fallbackRows = new Set(third.frames.filter((f) => /Gemini/.test(f.label)).map((f) => f.stageId));
  assert.equal(fallbackRows.size, 1, 'the model that answered has one row');
});

test('model sink: a rung skipped for no credit, then the next one answers — one error row per dry model', () => {
  const { progress, frames } = harness();
  const sink = progress.modelSink({});
  sink({ type: 'attempt_start', model: 'deepseek-v4-flash', attempt: 1, maxAttempts: 2 });
  sink({ type: 'attempt_failed', model: 'deepseek-v4-flash', attempt: 1, maxAttempts: 2, category: 'billing', willRetry: false });
  sink({ type: 'failover', from: 'deepseek-v4-flash', to: 'deepseek-v4-pro', reason: 'billing' });
  // deepseek-v4-pro is memoised as unfunded: no attempt, straight on.
  sink({ type: 'failover', from: 'deepseek-v4-pro', to: 'gemini-2.5-flash', reason: 'billing' });
  sink({ type: 'attempt_start', model: 'gemini-2.5-flash', attempt: 1, maxAttempts: 2 });
  sink({ type: 'first_byte', model: 'gemini-2.5-flash', kind: 'reasoning', ms: 2100 });
  const results = frames.filter((f) => f.step === 'tool_result').map((f) => `${f.status}:${f.label}`);
  assert.deepEqual(results, [
    'error:DeepSeek V4 Flash no disponible (sin saldo)',
    'error:DeepSeek V4 Pro no disponible (sin saldo)',
    'done:Gemini 2.5 Flash empezó a razonar · 2,1 s',
  ]);
});

test('model sink: a failure after the model started reasoning is its own row; the retry is never causeless', () => {
  const { progress, frames } = harness();
  const sink = progress.modelSink({});
  sink({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 1, maxAttempts: 2 });
  sink({ type: 'first_byte', model: 'deepseek-v4-pro', kind: 'reasoning', ms: 900 });
  sink({ type: 'attempt_failed', model: 'deepseek-v4-pro', attempt: 1, maxAttempts: 2, category: 'empty', willRetry: true });
  sink({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 2, maxAttempts: 2 });
  sink({ type: 'first_byte', model: 'deepseek-v4-pro', kind: 'content', ms: 1500 });
  const results = frames.filter((f) => f.step === 'tool_result').map((f) => `${f.status}:${f.label}`);
  assert.deepEqual(results, [
    'done:DeepSeek V4 Pro empezó a razonar · 900 ms',
    'error:DeepSeek V4 Pro devolvió una respuesta vacía · reintento 2 de 2',
    'done:DeepSeek V4 Pro respondió · 1,5 s',
  ]);
  const retryBegin = frames.filter((f) => f.step === 'tool_call').pop();
  assert.equal(retryBegin.label, 'Reintentando con DeepSeek V4 Pro · intento 2 de 2');

  // The last attempt fails the same way and the turn ends: one row says so.
  const second = harness();
  const s2 = second.progress.modelSink({});
  s2({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 2, maxAttempts: 2 });
  s2({ type: 'first_byte', model: 'deepseek-v4-pro', kind: 'reasoning', ms: 900 });
  s2({ type: 'attempt_failed', model: 'deepseek-v4-pro', attempt: 2, maxAttempts: 2, category: 'network', willRetry: false });
  s2({ type: 'failed', model: 'deepseek-v4-pro', category: 'network' });
  const errors = second.frames.filter((f) => f.status === 'error');
  assert.deepEqual(errors.map((f) => f.label), ['DeepSeek V4 Pro perdió la conexión']);
});

test('model sink: the reasoning level is only what the provider received', () => {
  const claimed = harness();
  const s1 = claimed.progress.modelSink({ contextTokens: 900 });
  s1({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 1, maxAttempts: 2, thinking: 'disabled' });
  assert.equal(claimed.frames[0].detail, 'contexto ~900 tokens · sin razonamiento extendido');
  // The route asked for «alto» but the rung sent no knob: nothing claimed.
  const unclaimed = harness();
  const s2 = unclaimed.progress.modelSink({ contextTokens: 900, thinkingLevel: 'high' });
  s2({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 1, maxAttempts: 2, thinking: null });
  assert.equal(unclaimed.frames[0].detail, 'contexto ~900 tokens');
  assert.equal(tp.effectiveThinkingLevel({ reasoning_effort: 'high' }, { level: 'high', explicit: true }), 'high');
  assert.equal(tp.effectiveThinkingLevel({ thinking: { type: 'enabled' } }, { level: 'max', explicit: true }), 'max');
  assert.equal(tp.effectiveThinkingLevel({ temperature: 0.5 }, { level: 'high', explicit: true }), null, 'no knob, no claim');
  assert.equal(tp.effectiveThinkingLevel({ reasoning_effort: 'high' }, { level: 'high', explicit: false }), null, 'the default is never claimed');
  assert.equal(tp.effectiveThinkingLevel({}, { level: 'high', disabled: true }), 'disabled');
  assert.equal(tp.effectiveThinkingLevel({ thinking: { type: 'disabled' } }, { level: 'low', explicit: true }), 'disabled');
});

test('model sink: images — only what really reaches the model is «lista»', () => {
  // Every load failed.
  const lost = harness();
  const s1 = lost.progress.modelSink({});
  const row = lost.progress.begin('vision', 'Preparando la imagen para el modelo', { tool: 'vision' });
  s1({ type: 'vision_prep', files: 1, name: 'foto.png' });
  s1({ type: 'vision_ready', requested: 1, loaded: 0, stripped: 0, failedName: 'foto.png' });
  s1({ type: 'attempt_start', model: 'gemini-2.5-flash', attempt: 1, maxAttempts: 2 });
  assert.equal(row.open, false);
  const visionResult = lost.frames.filter((f) => f.phase === 'vision' && f.step === 'tool_result');
  assert.equal(visionResult.length, 1);
  assert.equal(visionResult[0].status, 'error');
  assert.equal(visionResult[0].label, 'No pude cargar «foto.png»');
  assert.doesNotMatch(JSON.stringify(lost.frames), /Imagen lista/);
  const modelBegin = lost.frames.find((f) => f.phase === 'model');
  assert.doesNotMatch(modelBegin.detail || '', /imagen/);

  // The model takes no images and no vision runtime exists: stripped.
  const stripped = harness();
  const s2 = stripped.progress.modelSink({});
  s2({ type: 'vision_prep', files: 2 });
  s2({ type: 'vision_ready', model: 'deepseek-v4-flash', requested: 2, loaded: 2, stripped: 2 });
  s2({ type: 'attempt_start', model: 'deepseek-v4-flash', attempt: 1, maxAttempts: 2 });
  const strippedRow = stripped.frames.filter((f) => f.phase === 'vision').pop();
  assert.equal(strippedRow.status, 'error');
  assert.equal(strippedRow.label, 'DeepSeek V4 Flash no recibe imágenes: respondo con tu texto');
  assert.doesNotMatch(stripped.frames.find((f) => f.phase === 'model').detail || '', /imagen/);

  // One of two failed.
  const partial = harness();
  const s3 = partial.progress.modelSink({});
  s3({ type: 'vision_prep', files: 2 });
  s3({ type: 'vision_ready', requested: 2, loaded: 1, stripped: 0, failedName: 'b.png' });
  const partialRow = partial.frames.filter((f) => f.phase === 'vision').pop();
  assert.equal(partialRow.status, 'done');
  assert.equal(partialRow.label, '1 de 2 imágenes listas para el modelo');
  assert.equal(partialRow.detail, 'No pude cargar «b.png»');

  // The stream fails before the images reach the model: never «lista».
  const failed = harness();
  const s4 = failed.progress.modelSink({});
  const pending = failed.progress.begin('vision', 'Preparando la imagen para el modelo', { tool: 'vision' });
  s4({ type: 'vision_prep', files: 1, name: 'foto.png' });
  s4({ type: 'failed', model: 'gemini-2.5-flash', category: 'unavailable' });
  assert.equal(pending.open, false);
  const failedVision = failed.frames.filter((f) => f.phase === 'vision').pop();
  assert.equal(failedVision.status, 'error');
  assert.equal(failedVision.label, 'La imagen no llegó al modelo');
});

test('model sink: the 20 s notice says what really happens at the limit', () => {
  const run = (ev) => {
    const { progress, frames } = harness();
    const sink = progress.modelSink({});
    sink({ type: 'attempt_start', model: 'deepseek-v4-flash', attempt: ev.attempt || 1, maxAttempts: 2 });
    sink({ type: 'waiting', model: 'deepseek-v4-flash', waitedMs: 20000, timeoutMs: 30000, ...ev });
    return frames.filter((f) => f.step === 'tool_progress').pop().detail;
  };
  assert.equal(run({ retrySameModel: true, nextModel: null, willRetry: true }), 'Tarda más de lo habitual · reintento automático a los 30 s');
  assert.equal(run({ attempt: 2, retrySameModel: false, nextModel: 'gemini-2.5-flash', willRetry: true }), 'Tarda más de lo habitual · a los 30 s pruebo con Gemini 2.5 Flash');
  assert.equal(run({ attempt: 2, retrySameModel: false, nextModel: 'x-private/unknown', willRetry: true }), 'Tarda más de lo habitual · a los 30 s pruebo con otro modelo');
  assert.equal(run({ attempt: 2, retrySameModel: false, nextModel: null, willRetry: false }), 'Tarda más de lo habitual · límite de espera 30 s');
});

test('model sink: the caller names its model (FlashGPT, a user connection), never an id or a transport', () => {
  const { progress, frames } = harness();
  const sink = progress.modelSink({ modelId: 'gpt-oss-120b', modelLabel: '⚡ FlashGPT' });
  sink({ type: 'attempt_start', model: 'gpt-oss-120b', attempt: 1, maxAttempts: 2 });
  assert.equal(frames[0].label, 'Conectando con ⚡ FlashGPT');
  const other = harness();
  const s2 = other.progress.modelSink({ modelId: 'x/y', modelLabel: 'OpenRouter: x/y' });
  s2({ type: 'attempt_start', model: 'x/y', attempt: 1, maxAttempts: 2 });
  assert.equal(other.frames[0].label, 'Conectando con el modelo');
});

test('protocol 1: a stale tab is told the model started reasoning (it only sees begins)', () => {
  const { progress, frames } = harness({ protocol: 1 });
  const sink = progress.modelSink({});
  sink({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 1, maxAttempts: 2 });
  sink({ type: 'first_byte', model: 'deepseek-v4-pro', kind: 'reasoning', ms: 1200 });
  assert.deepEqual(frames, [
    { type: 'stage', label: 'Conectando con DeepSeek V4 Pro', tool: 'model' },
    { type: 'stage', label: 'DeepSeek V4 Pro está razonando', tool: 'model' },
  ]);
});

test('history summary: applied, skipped and failed are told apart', () => {
  const outcome = (ev) => {
    const { progress, frames } = harness();
    const sink = progress.modelSink({});
    sink({ type: 'summarize_history', messages: 6 });
    sink({ type: 'summarize_done', ...ev });
    const last = frames[frames.length - 1];
    return `${last.status}:${last.label}`;
  };
  assert.equal(outcome({ applied: true, reason: 'summarized' }), 'done:Mensajes antiguos resumidos');
  assert.equal(outcome({ applied: false, reason: 'summarizer_error' }), 'error:No se pudieron resumir los mensajes antiguos');
  assert.equal(outcome({ applied: false, reason: 'empty_summary' }), 'error:No se pudieron resumir los mensajes antiguos');
  assert.equal(outcome({ applied: false, reason: 'disabled_by_env' }), 'done:Los mensajes antiguos se omitieron sin resumen');
});

test('quality pass and history summary are real rows with their own results', () => {
  const { progress, frames } = harness();
  const sink = progress.modelSink({});
  sink({ type: 'summarize_history', messages: 18 });
  sink({ type: 'summarize_done', applied: true });
  sink({ type: 'quality_pass', reason: 'too_short' });
  sink({ type: 'quality_done', replaced: true });
  assert.deepEqual(frames.map((f) => `${f.phase}:${f.step}:${f.label}`), [
    'history:tool_call:Resumiendo 18 mensajes antiguos para que quepan en el contexto',
    'history:tool_result:Mensajes antiguos resumidos',
    'post:tool_call:Mejorando la respuesta (la primera versión fue corta)',
    'post:tool_result:Respuesta mejorada',
  ]);
});

test('settleAll closes open rows; dispose clears timers and silences the helper; cap of 48 begins', () => {
  const { progress, frames, timers, advance } = harness();
  const a = progress.begin('memory', 'Consultando tu memoria', { tool: 'memory' });
  const b = progress.begin('rag', 'Buscando pasajes', { tool: 'rag_retrieve' });
  a.update({ detail: 'x' });
  a.update({ detail: 'y' });
  progress.settleAll();
  assert.equal(a.open, false);
  assert.equal(b.open, false);
  assert.equal(frames.filter((f) => f.step === 'tool_result').length, 2);
  const c = progress.begin('web', 'Buscando', { tool: 'web_search' });
  c.update({ detail: 'uno' });
  c.update({ detail: 'dos' });
  progress.dispose();
  assert.ok(timers.every((t) => t.cleared), 'no pending timer after dispose');
  const before = frames.length;
  advance(5000);
  progress.begin('late', 'Tarde');
  c.done('Listo');
  assert.equal(frames.length, before);

  const capped = harness();
  for (let i = 0; i < 60; i += 1) capped.progress.begin(`p${i}`, `Fase ${i}`).done();
  assert.equal(capped.frames.filter((f) => f.step === 'tool_call').length, tp.MAX_BEGINS_PER_TURN);
});

test('a throwing emitter or collector never escapes the helper', () => {
  const progress = tp.createTurnProgress({
    emitStage: () => { throw new Error('socket gone'); },
    protocol: 2,
    collector: { push() { throw new Error('boom'); }, toMetadata() { throw new Error('boom'); } },
    canWriteProgress: () => { throw new Error('no'); },
  });
  const h = progress.begin('attachments', 'Leyendo', { tool: 'read_file' });
  h.update({ detail: 'x' });
  h.done('Listo');
  progress.note('context', 'Contexto listo');
  const sink = progress.modelSink({});
  sink({ type: 'attempt_start', model: 'deepseek-v4-pro', attempt: 1, maxAttempts: 2 });
  sink(null);
  sink({ type: 'unknown' });
  assert.equal(progress.toMetadata({ durationMs: 1 }), null);
  progress.dispose();
});

test('attachment rows: the user’s file names, a note with real counts, extraction updates', () => {
  assert.equal(tp.attachmentsLabel([{ originalName: 'contrato.pdf' }]), 'Leyendo «contrato.pdf»');
  assert.equal(tp.attachmentsLabel(['id-1']), 'Leyendo el archivo adjunto');
  assert.equal(tp.attachmentsLabel(['a', 'b']), 'Leyendo 2 archivos adjuntos');
  assert.equal(
    tp.attachmentsLabel([{ originalName: 'contrato.pdf' }, { name: 'anexo.xlsx' }, { name: 'c.docx' }]),
    'Leyendo 3 archivos: contrato.pdf, anexo.xlsx +1',
  );
  assert.equal(tp.attachmentsLabel([{ originalName: 'X.pdf' }], { recovered: true }), 'Recuperando «X.pdf» de un mensaje anterior');
  assert.equal(
    tp.attachmentsNote([
      { mimeType: 'application/pdf', extractedText: 'uno dos tres' },
      { mimeType: 'application/pdf', extractedText: 'cuatro' },
      { mimeType: 'image/png', extractedText: 'ocr text ignored' },
    ]),
    '2 documentos · 4 palabras · 1 imagen',
  );

  const { progress, frames, advance } = harness();
  const h = progress.begin('attachments', 'Leyendo «contrato.pdf»', { tool: 'read_file' });
  const sink = tp.attachmentExtractSink(h);
  sink({ type: 'extract_wait', file: 'contrato.pdf' });
  advance(1500);
  sink({ type: 'extract_done', file: 'contrato.pdf', words: 12340 });
  advance(1500);
  sink({ type: 'bogus' });
  sink(null);
  const progressFrames = frames.filter((f) => f.step === 'tool_progress');
  assert.equal(progressFrames[0].label, 'Esperando que termine la extracción de «contrato.pdf»');
  assert.equal(progressFrames[progressFrames.length - 1].detail, '«contrato.pdf» · 12.340 palabras');
});

test('rag rows are lazy and settle with what really happened', () => {
  // No event → no row.
  const quiet = harness();
  const s0 = tp.ragProgressSink(quiet.progress);
  s0.finish({ hits: [] });
  assert.equal(quiet.frames.length, 0);

  // Index → retrieve → filter → found.
  const { progress, frames } = harness();
  const sink = tp.ragProgressSink(progress);
  sink.onProgress({ type: 'index_start', files: 1, file: 'contrato.pdf' });
  sink.onProgress({ type: 'index_done', chunksAdded: 142 });
  sink.onProgress({ type: 'retrieve_start', docs: 2 });
  sink.onProgress({ type: 'retrieve_done', hits: 8, totalChunks: 142, docs: 2 });
  sink.noteFiltering();
  sink.noteFiltered(8, 5);
  sink.finish({ hits: new Array(5).fill({}) });
  assert.equal(frames[0].label, 'Indexando «contrato.pdf»');
  const result = frames[frames.length - 1];
  assert.equal(result.step, 'tool_result');
  assert.equal(result.label, 'Pasajes relevantes encontrados');
  assert.equal(result.detail, '8 → 5 pasajes pertinentes · 2 documentos');
  assert.equal(new Set(frames.map((f) => f.stageId)).size, 1);

  // Retrieval started but never finished (the store failed) → an honest failure.
  const broken = harness();
  const s2 = tp.ragProgressSink(broken.progress);
  s2.onProgress({ type: 'retrieve_start', docs: 1 });
  s2.finish({ active: false, hits: [] });
  const last = broken.frames[broken.frames.length - 1];
  assert.equal(last.status, 'error');
  assert.equal(last.label, 'No pude consultar tus documentos');

  // Nothing relevant.
  const empty = harness();
  const s3 = tp.ragProgressSink(empty.progress);
  s3.onProgress({ type: 'retrieve_start', docs: 1 });
  s3.onProgress({ type: 'retrieve_done', hits: 0, totalChunks: 40, docs: 1 });
  s3.finish({ hits: [] });
  assert.equal(empty.frames[empty.frames.length - 1].label, 'Ningún pasaje relevante en tus documentos');
});

test('planning / document helpers map ids to Spanish, never echo unknown ids', () => {
  assert.equal(tp.difficultyEs('complex'), 'tarea compleja');
  assert.equal(tp.difficultyEs('whatever'), '');
  assert.equal(tp.docTypeEs('legal_contract'), 'contrato');
  assert.equal(tp.docTypeEs('general_document'), '');
  assert.equal(tp.thinkingLevelEs('high'), 'razonamiento alto');
  assert.equal(tp.thinkingLevelEs('nonsense'), '');
});

test('display names: a legacy alias never names a different, newer model', () => {
  // The catalog maps these legacy ids to newer rows (gpt-5 → GPT 5.5…):
  // naming them would name a model that is not the one answering.
  for (const id of ['gpt-5', 'x-ai/grok-4', 'claude-3-5-sonnet', 'claude-3.5-sonnet', 'qwen-2.5-72b', 'gemini-2.5', 'deepseek-v3-chat', 'phi-4-reasoning']) {
    assert.equal(tp.displayNameFor(id), '', id);
    assert.equal(tp.modelLabel(id), 'el modelo', id);
  }
  // The same model under another spelling keeps its name.
  assert.equal(tp.displayNameFor('claude-opus-4-7'), 'Opus 4.7');
  assert.equal(tp.displayNameFor('anthropic/claude-opus-4.7'), 'Opus 4.7');
  assert.equal(tp.displayNameFor('claude-3-haiku-20240307'), 'Claude 3 Haiku');
  assert.equal(tp.displayNameFor('mistral-large-latest'), 'Mistral Large');
  assert.equal(tp.displayNameFor('gemma-3-27b'), 'Gemma 3 27B');
  assert.equal(tp.displayNameFor('grok-4.2'), 'Grok 4.2');
  assert.equal(tp.displayNameFor('kimi-k2.6'), 'Kimi K2.6');
  // Product aliases of the DeepSeek V4 pair (input only) name the real model.
  assert.equal(tp.displayNameFor('sira-pro'), 'DeepSeek V4 Pro');
  assert.equal(tp.displayNameFor('sira-rapido'), 'DeepSeek V4 Flash');
});

test('display names: the free tier model is named by its picker brand', () => {
  const saved = { id: process.env.FREE_IA_MODEL_ID, name: process.env.FREE_IA_DISPLAY_NAME };
  try {
    process.env.FREE_IA_MODEL_ID = 'llama-3.1-8b';
    process.env.FREE_IA_DISPLAY_NAME = '⚡ FlashGPT';
    assert.equal(tp.displayNameFor('llama-3.1-8b', 'Cerebras'), '⚡ FlashGPT');
    assert.equal(tp.displayNameFor('llama-3.1-8b'), '⚡ FlashGPT');
    assert.equal(tp.displayNameFor('llama-3.1-8b', 'Groq'), '', 'the same weights elsewhere are not the free tier');
    assert.equal(tp.displayNameFor('llama-3.3-70b', 'Cerebras'), 'Llama 3.3 70B');
  } finally {
    if (saved.id === undefined) delete process.env.FREE_IA_MODEL_ID; else process.env.FREE_IA_MODEL_ID = saved.id;
    if (saved.name === undefined) delete process.env.FREE_IA_DISPLAY_NAME; else process.env.FREE_IA_DISPLAY_NAME = saved.name;
  }
});

test('Spanish failure sentences: the model is the subject; no redundant causes', () => {
  const name = 'DeepSeek V4 Pro';
  const failedOf = (category) => tp.modelEventLabel({ type: 'attempt_failed', category, attempt: 1, maxAttempts: 2, willRetry: false }, name);
  assert.equal(failedOf('auth'), 'El proveedor de DeepSeek V4 Pro rechazó la clave');
  assert.equal(failedOf('forbidden'), 'El proveedor de DeepSeek V4 Pro no permite usarlo ahora');
  assert.equal(failedOf('network'), 'DeepSeek V4 Pro perdió la conexión');
  assert.equal(failedOf('breaker'), 'DeepSeek V4 Pro está en pausa tras varios fallos seguidos');
  assert.equal(failedOf('billing'), 'DeepSeek V4 Pro no tiene saldo en su proveedor');
  assert.equal(failedOf('overloaded'), 'DeepSeek V4 Pro está saturado');
  const endOf = (category) => tp.modelEventLabel({ type: 'failed', category }, name);
  assert.equal(endOf('timeout'), 'DeepSeek V4 Pro no pudo responder (sin respuesta a tiempo)');
  assert.equal(endOf('unavailable'), 'DeepSeek V4 Pro no pudo responder (sin respuesta)');
  assert.equal(endOf('overloaded'), 'DeepSeek V4 Pro no pudo responder (saturado)');
  assert.equal(endOf('network'), 'DeepSeek V4 Pro no pudo responder (conexión interrumpida)');
  assert.equal(endOf('bad_request'), 'DeepSeek V4 Pro no pudo responder (rechazó la solicitud)');
  assert.equal(endOf('empty'), 'DeepSeek V4 Pro no pudo responder (respuesta vacía)');
  assert.equal(endOf('rate_limit'), 'DeepSeek V4 Pro no pudo responder (límite por minuto)');
  assert.equal(endOf('unconfigured'), 'DeepSeek V4 Pro no pudo responder (no configurado)');
  assert.equal(endOf('whatever'), 'DeepSeek V4 Pro no pudo responder');
  for (const label of [failedOf('auth'), endOf('timeout'), endOf('whatever')]) {
    assert.doesNotMatch(label, /no responde\)|\(falló\)|su proveedor rechazó/);
  }
  assert.equal(tp.modelFailureText('el modelo', 'rate_limit', { retryAfterSeconds: 12 }), 'El modelo alcanzó el límite por minuto · espera 12 s');
});

test('failure categories come from the error class, never its text', () => {
  assert.equal(tp.failureCategoryOf(null, { timedOut: true }), 'timeout');
  assert.equal(tp.failureCategoryOf(Object.assign(new Error('Insufficient Balance'), { status: 402 })), 'billing');
  assert.equal(tp.failureCategoryOf(Object.assign(new Error('invalid api key'), { status: 401 })), 'auth');
  assert.equal(tp.failureCategoryOf(Object.assign(new Error('Too Many Requests'), { status: 429 })), 'rate_limit');
  assert.equal(tp.failureCategoryOf(Object.assign(new Error('x'), { code: 'EMPTY_COMPLETION' })), 'empty');
  assert.equal(tp.failureCategoryOf(Object.assign(new Error('x'), { name: 'CircuitBreakerError' })), 'breaker');
  assert.equal(tp.failureCategoryOf(Object.assign(new Error('x'), { siraFailureReason: 'unconfigured' })), 'unconfigured');
  assert.equal(tp.retryAfterSecondsOf(Object.assign(new Error('x'), { siraRetryAfterSeconds: 7.2 })), 8);
});

test('word counts retain ECMAScript whitespace and treat other Unicode characters as word content', () => {
  const whitespace = [9, 10, 11, 12, 13, 32, 0xa0, 0x1680,
    ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
  for (const code of whitespace) {
    const separator = String.fromCharCode(code);
    assert.deepEqual(tp.countWordsBounded(`${separator}uno${separator}dos${separator}`), { words: 2, approx: false });
    assert.deepEqual(tp.countWordsBounded(separator.repeat(3)), { words: 0, approx: false });
  }
  for (const content of ['\u0085', '\u180e', '\u200b', '\u200d', '\u2060', '😀', '漢']) {
    assert.deepEqual(tp.countWordsBounded(`uno${content}dos`), { words: 1, approx: false });
  }
});

test('bounded word counts preserve partial-word and fractional scan-boundary semantics', () => {
  for (const text of ['', 'uno dos tres', '  uno\tdos\n', '😀\u2028agua\ufeffmar', ' '.repeat(100), 'x '.repeat(60_000)]) {
    for (const cap of [0, -1, 1, 1.2, 2.9, 3, 4, 5, 100_000, Infinity, NaN]) {
      const end = Math.min(text.length, Math.max(1, Number(cap) || 100_000));
      const prefix = text.slice(0, Math.ceil(end)).trim();
      const words = prefix ? prefix.split(/\s+/u).length : 0;
      const expected = end >= text.length
        ? { words, approx: false }
        : { words: Math.round(words * (text.length / end)), approx: true };
      assert.deepEqual(tp.countWordsBounded(text, cap), expected, `length=${text.length}, cap=${cap}`);
    }
  }
});

test('word counts are bounded on the request path and marked approximate beyond the cap', () => {
  assert.equal(tp.countWords('  uno\tdos\ntres cuatro  '), 4);
  assert.equal(tp.countWords(''), 0);
  const text = 'palabra '.repeat(5000); // 40.000 chars
  assert.deepEqual(tp.countWordsBounded(text), { words: 5000, approx: false });
  const big = 'palabra '.repeat(200_000); // 1,6 M chars
  const bounded = tp.countWordsBounded(big);
  assert.equal(bounded.approx, true);
  assert.ok(Math.abs(bounded.words - 200_000) <= 2, String(bounded.words));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i += 1) tp.countWordsBounded(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 400, `50 × 1,6 MB counted in ${ms.toFixed(0)} ms`);
  assert.equal(
    tp.attachmentsNote([{ mimeType: 'application/pdf', extractedText: big }]),
    '1 documento · ~200.000 palabras',
  );
});

test('a quick turn with only routine rows is not persisted; errors and real work are', () => {
  const run = (build, durationMs) => {
    const collector = createActivityTraceCollector({ now: () => 0 });
    const { progress } = harness({ collector });
    build(progress);
    return progress.toMetadata({ durationMs });
  };
  const routine = (p) => {
    p.begin('understanding', 'Analizando tu mensaje', { tool: 'plan' }).done();
    p.begin('planning', 'Planificando la respuesta', { tool: 'plan' }).done();
    p.note('context', 'Contexto listo · ~900 tokens', { tool: 'plan' });
    p.begin('model', 'Conectando con DeepSeek V4 Flash', { tool: 'model' }).done('DeepSeek V4 Flash respondió · 800 ms');
  };
  assert.equal(run(routine, 1200), null, '«hola» keeps no trace');
  assert.ok(run(routine, 5200), 'a slow turn keeps it');
  assert.ok(run(routine, null), 'unknown duration keeps it');
  assert.ok(run((p) => { routine(p); p.begin('attachments', 'Leyendo «a.pdf»', { tool: 'read_file' }).done(); }, 1200), 'real work keeps it');
  assert.ok(run((p) => { routine(p); p.begin('model', 'Conectando con X', { tool: 'model' }).fail('X no disponible (sin saldo)'); }, 1200), 'a failure keeps it');
});

test('failover labels: «no disponible» only for provider causes', () => {
  const label = (reason) => tp.modelEventLabel({ type: 'failover', reason }, 'Gemini 2.5 Flash');
  assert.equal(label('billing'), 'Gemini 2.5 Flash no disponible (sin saldo)');
  assert.equal(label('auth'), 'Gemini 2.5 Flash no disponible (clave rechazada)');
  assert.equal(label('rate_limit'), 'Gemini 2.5 Flash no disponible (límite por minuto)');
  assert.equal(label('timeout'), 'Gemini 2.5 Flash no disponible (no responde)');
  assert.equal(label('unconfigured'), 'Gemini 2.5 Flash no disponible (no configurado)');
  assert.equal(label('bad_request'), 'Gemini 2.5 Flash no pudo responder (rechazó la solicitud)');
  assert.equal(label('empty'), 'Gemini 2.5 Flash no pudo responder (respuesta vacía)');
  assert.equal(label('unknown'), 'Gemini 2.5 Flash no pudo responder');
  for (const r of ['billing', 'bad_request', 'empty', 'unknown', 'timeout']) assert.doesNotMatch(label(r), /\(falló\)/);
});
