'use strict';

/**
 * Slide-progress — guardia anti-bucle + checkpoints por diapositiva +
 * streaming en vivo (caso «Crea una ppt del embarazo»).
 *
 * (a) stepSignature normaliza espacios y orden de claves;
 * (b) createRepeatStepGuard corta con ≥3 repeticiones en ventana 6, tolera
 *     repeticiones separadas y detecta alternancias A-B-A-B;
 * (c) checkpoints: markSlideDone / isCheckpointFresh / resumeInstruction;
 * (d) KV save/load/clear con cliente falso (y fail-open sin kv);
 * (e) emitSlideEvent produce el evento que trace.js mapea a stage español;
 * (f) integración: runAgentLoop corta un bucle real de tool_calls idénticas
 *     con stoppedReason 'repeat_loop_cut' SIN gastar más iteraciones;
 * (g) integración tools.js: makeToolExecutors con slideProgress emite
 *     slide_progress por diapositiva y guarda checkpoint en KV.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHECKPOINT_TTL_MS,
  stepSignature,
  createRepeatStepGuard,
  classifyRepeatLoopCut,
  createSlideCheckpointer,
  markSlideDone,
  isCheckpointFresh,
  resumeInstruction,
  saveSlideCheckpoint,
  loadSlideCheckpoint,
  clearSlideCheckpoint,
  emitSlideEvent,
} = require('../src/services/agent-runner/slide-progress');
const { toStageEvent } = require('../src/services/agent-runner/trace');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { makeToolExecutors } = require('../src/services/agent-runner/tools');

/* ── helpers ─────────────────────────────────────────────────────────────── */

function fakeKv() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, String(v)); },
    async del(k) { store.delete(k); },
    _store: store,
  };
}

function scriptedClient(turns) {
  let i = 0;
  const client = {
    calls: 0,
    chat: {
      completions: {
        create: async () => {
          if (i >= turns.length) throw new Error('script exhausted');
          const t = turns[i++];
          client.calls += 1;
          return {
            choices: [{
              message: t.toolCalls
                ? {
                    content: null,
                    tool_calls: t.toolCalls.map((c, idx) => ({
                      id: `call_${i}_${idx}`,
                      type: 'function',
                      function: { name: c.name, arguments: JSON.stringify(c.args) },
                    })),
                  }
                : { content: t.content || 'done' },
            }],
          };
        },
      },
    },
  };
  return client;
}

const noopExecutor = async () => JSON.stringify({ ok: true });

/* ── (a) firmas ──────────────────────────────────────────────────────────── */

test('stepSignature normaliza whitespace libre y orden de claves', () => {
  const a = stepSignature('execute_python', { code: 'print(1)\nprint(2)', x: 1 });
  const b = stepSignature('execute_python', { x: 1, code: ' print(1)   print(2)' });
  assert.equal(a, b);

  assert.notEqual(
    stepSignature('write_file', { path: 'a.pptx' }),
    stepSignature('write_file', { path: 'b.pptx' }),
  );
});

/* ── (b) guardia deslizante ──────────────────────────────────────────────── */

test('el guardia tolera pasos únicos y repeticiones separadas por otros pasos', () => {
  const g = createRepeatStepGuard({ window: 6, threshold: 3 });
  // El mismo paso python aparece dos veces separadas por otros pasos — legal
  // (p.ej. editar + previsualizar + re-editar). Nunca supera el umbral 3 en
  // ninguna ventana de 6.
  for (const [tool, args] of [
    ['execute_python', { code: 'a' }],
    ['write_file', { content: 'x' }],
    ['render_preview', { path: 'outputs/a.pptx' }],
    ['execute_python', { code: 'a' }],
    ['write_file', { content: 'y' }],
    ['execute_bash', { command: 'ls outputs' }],
    ['render_preview', { path: 'outputs/b.pptx' }],
    ['execute_bash', { command: 'wc -l x.txt' }],
  ]) {
    const v = g.record(tool, args);
    assert.equal(v.cut, false, `cortó antes de tiempo tras ${tool} ${JSON.stringify(args)}`);
  }
  assert.equal(g.size <= 6, true);
});

test('el guardia corta al alcanzar el umbral dentro de la ventana', () => {
  const g = createRepeatStepGuard({ window: 6, threshold: 3 });
  g.record('execute_python', { code: 'same' });
  g.record('execute_bash', { command: 'other' });
  g.record('execute_python', { code: 'same' });
  const third = g.record('execute_python', { code: 'same' });
  assert.equal(third.cut, true);
  assert.equal(third.reason, 'repeat_loop_cut');
  assert.equal(third.count >= 3, true);
  // Tras el corte la ventana se reinicia: un retry limpio puede trabajar.
  assert.equal(g.record('execute_python', { code: 'same' }).cut, false);
});

test('el guardia detecta alternancia A-B-A-B (no solo repetición consecutiva)', () => {
  const g = createRepeatStepGuard({ window: 6, threshold: 3 });
  g.record('execute_python', { code: 'A' });
  g.record('execute_python', { code: 'B' });
  g.record('execute_python', { code: 'A' });
  g.record('execute_python', { code: 'B' });
  const verdict = g.record('execute_python', { code: 'A' });
  assert.equal(verdict.cut, true, 'la tercera aparición de A cae dentro de la ventana');
});

/* ── (c) checkpoints ─────────────────────────────────────────────────────── */

test('markSlideDone recorta títulos/bullets y filtra vacíos', () => {
  const cp = createSlideCheckpointer({ topic: 'embarazo', color: 'F8FAFC', filename: 'deck.pptx' });
  markSlideDone(cp, {
    title: 'T'.repeat(500),
    bullets: ['', '  ', 'bullet válido'.repeat(100), 'ok'],
  });
  assert.equal(cp.slidesDone.length, 1);
  assert.equal(cp.slidesDone[0].title.length, 200);
  assert.deepEqual(cp.slidesDone[0].bullets.filter((b) => b === 'ok'), ['ok']);
  assert.ok(cp.slidesDone[0].bullets.every((b) => b.length <= 300));
});

test('isCheckpointFresh exige slides y respeta el TTL', () => {
  const cp = createSlideCheckpointer({ topic: 't' });
  assert.equal(isCheckpointFresh(cp), false, 'sin slides no hay checkpoint');
  markSlideDone(cp, { title: 's1' });
  assert.equal(isCheckpointFresh(cp, { now: Date.now() }), true);
  assert.equal(isCheckpointFresh(cp, { now: Date.now() + CHECKPOINT_TTL_MS + 1 }), false);
  assert.equal(isCheckpointFresh(null), false);
});

test('resumeInstruction nombra las slides hechas y prohíbe reiniciar', () => {
  const cp = createSlideCheckpointer({ topic: 'embarazo' });
  markSlideDone(cp, { title: 'Portada' });
  markSlideDone(cp, { title: 'Primer trimestre' });
  const text = resumeInstruction(cp, 'embarazo');
  assert.match(text, /2 diapositivas válidas/);
  assert.match(text, /Portada \| Primer trimestre/);
  assert.match(text, /NO repitas/i);
});

test('resumeInstruction trunca listas largas (>5 títulos)', () => {
  const cp = createSlideCheckpointer({ topic: 't' });
  for (let i = 1; i <= 8; i += 1) markSlideDone(cp, { title: `S${i}` });
  const text = resumeInstruction(cp, 't');
  assert.match(text, /\(8 en total\)/);
});

/* ── (d) KV persistencia ─────────────────────────────────────────────────── */

test('save/load/clear sobre KV falso, y fail-open sin kv o sin threadId', async () => {
  const kv = fakeKv();
  const cp = createSlideCheckpointer({ topic: 'embarazo', filename: 'deck.pptx' });
  markSlideDone(cp, { title: 'Portada', bullets: ['a'] });

  assert.equal(await saveSlideCheckpoint(kv, 'thread-1', cp), true);
  const loaded = await loadSlideCheckpoint(kv, 'thread-1');
  assert.equal(loaded.slidesDone.length, 1);
  assert.equal(loaded.slidesDone[0].title, 'Portada');
  assert.equal(await clearSlideCheckpoint(kv, 'thread-1'), true);
  assert.equal(await loadSlideCheckpoint(kv, 'thread-1'), null);

  assert.equal(await saveSlideCheckpoint(null, 't', cp), false);
  assert.equal(await loadSlideCheckpoint(kv, null), null);
  assert.equal(await clearSlideCheckpoint(kv, 'missing-key'), true, 'del inexistente no es error');
});

/* ── (e) streaming ───────────────────────────────────────────────────────── */

test('emitSlideEvent produce label N/M y trace.js lo mapea a stage español', () => {
  const seen = [];
  emitSlideEvent((ev) => seen.push(ev), { index: 2, total: 6, title: 'Control prenatal' });
  assert.equal(seen.length, 1);
  const ev = seen[0];
  assert.equal(ev.type, 'slide_progress');
  assert.equal(ev.index, 2);
  assert.equal(ev.total, 6);
  assert.match(ev.label, /^Diapositiva 2\/6: Control prenatal$/);

  const stage = toStageEvent(ev);
  assert.equal(stage.type, 'stage');
  assert.equal(stage.step, 'slide_progress');
  assert.equal(stage.label, 'Diapositiva 2/6: Control prenatal');
  assert.equal(stage.index, 2);
  assert.equal(stage.tool, 'agent_runner');

  // Sin callback ni total: silencioso y válido.
  emitSlideEvent(undefined, { index: 1 });
  const bare = [];
  emitSlideEvent((e) => bare.push(e), { index: 3 });
  assert.equal(toStageEvent(bare[0]).label, 'Diapositiva 3: ');
});

/* ── (f) integración: el loop REAL corta un bucle de tool_calls idénticas ── */

test('runAgentLoop corta con repeat_loop_cut sin quemar el presupuesto', async () => {
  const loopCall = { name: 'execute_python', args: { code: 'make_deck()' } };
  const client = scriptedClient([
    { toolCalls: [loopCall] },
    { toolCalls: [loopCall] },
    { toolCalls: [loopCall] },
    { toolCalls: [loopCall] }, // nunca debería llegar
  ]);
  const events = [];
  const result = await runAgentLoop({
    client,
    model: 'test-model',
    messages: [{ role: 'user', content: 'crea una ppt' }],
    tools: [],
    executors: { execute_python: noopExecutor },
    maxIterations: 25,
    onEvent: (ev) => events.push(ev),
  });

  assert.equal(result.stoppedReason, 'repeat_loop_cut');
  assert.equal(result.errorCode, 'repeat_loop_cut');
  assert.ok(result.iterations < 25, `debe cortar antes del tope (fueron ${result.iterations})`);
  assert.ok(client.calls <= 3, `el corte debe ahorrar llamadas al modelo (fueron ${client.calls})`);
  const cutEvent = events.find((e) => e.type === 'error' && e.code === 'repeat_loop_cut');
  assert.ok(cutEvent, 'se emite un error con código honesto');
  assert.match(cutEvent.message, /repitió el mismo paso/i);
  assert.equal(cutEvent.retryable, false);
});

test('classifyRepeatLoopCut expone copy honesta y no-reintentable', () => {
  const cut = classifyRepeatLoopCut({ count: 3 });
  assert.equal(cut.code, 'repeat_loop_cut');
  assert.equal(cut.retryable, false);
  assert.match(cut.message, /avance ya generado se conserva/i);
  assert.equal(cut.count, 3);
});

/* ── (g) integración tools.js: streaming + checkpoint desde el executor ──── */

test('create_presentation emite slide_progress por diapositiva y checkpointea en KV', async () => {
  const kv = fakeKv();
  const sandbox = {
    async writeFile(rel, buffer) {
      this.written = this.written || {};
      this.written[rel] = buffer;
    },
  };
  const events = [];
  const executors = makeToolExecutors(sandbox, {
    web: { enabled: false },
    slideProgress: { kv, threadId: 'chat-9' },
  });
  executors.__setSlideEventSink((ev) => events.push(ev));

  const raw = await executors.create_presentation({
    topic: 'embarazo',
    color: '#FFC0CB',
    filename: 'deck.pptx',
    outline: [
      { title: 'Primer trimestre', bullets: ['Ecografía', 'Análisis'] },
      { title: 'Segundo trimestre' },
    ],
  });
  const out = JSON.parse(raw);
  assert.equal(out.ok, true);
  assert.equal(out.slides, 3); // portada + 2
  assert.equal(out.checkpointed, true);
  assert.equal(sandbox.written['outputs/deck.pptx'].length > 0, true);

  // Streaming: portada + 2 diapositivas, índices 1..3, labels N/M.
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.index), [1, 2, 3]);
  assert.match(events[0].label, /^Diapositiva 1\/3: embarazo$/);
  assert.match(events[2].label, /^Diapositiva 3\/3: Segundo trimestre$/);
  assert.ok(events.every((e) => e.type === 'slide_progress'));

  // Checkpoint en KV con las 3 diapositivas.
  const cp = await loadSlideCheckpoint(kv, 'chat-9');
  assert.equal(cp.topic, 'embarazo');
  assert.equal(cp.filename, 'deck.pptx');
  assert.equal(cp.slidesDone.length, 3);
  assert.deepEqual(cp.slidesDone.map((s) => s.title),
    ['embarazo', 'Primer trimestre', 'Segundo trimestre']);
});

test('sin slideProgress el executor funciona igual pero no checkpointea', async () => {
  const sandbox = { async writeFile() {} };
  const events = [];
  const executors = makeToolExecutors(sandbox, { web: { enabled: false } });
  executors.__setSlideEventSink((ev) => events.push(ev));

  const out = JSON.parse(await executors.create_presentation({
    topic: 't',
    outline: [{ title: 'A' }],
  }));
  assert.equal(out.ok, true);
  assert.equal(out.checkpointed, false);
  assert.equal(events.length, 2, 'el streaming por sí solo también funciona');
  assert.equal(await executors.resumeCheckpoint(), null);
});
