'use strict';

/**
 * Edición milimétrica — Fase C (docs/specs/edicion-milimetrica/SPEC.md §6):
 * verification gate v2, vision review ladder, context that never loses the
 * request, honest endings.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgentLoop, restorePinnedMessages, resolveContextBudgetTokens } = require('../src/services/agent-runner/loop');
const { needsVerification, verificationNudge, isRendererUnavailable } = require('../src/services/agent-runner/verify');
const { OUTPUTS_SNAPSHOT, changedOutputs } = require('../src/services/agent-runner/tools.office');
const tools = require('../src/services/agent-runner/tools');
const ladder = require('../src/services/agent-runner/multimodal/vision-ladder');
const { makeVisionVerifier } = require('../src/services/agent-runner/multimodal/visual-verifier');
const runner = require('../src/services/agent-runner');
const { buildAgentRunnerPrompt } = require('../src/services/agent-runner/prompt');

function scriptedClient(script) {
  let i = 0;
  return {
    calls: [],
    chat: {
      completions: {
        create: async (payload) => {
          if (i >= script.length) throw new Error('scripted client exhausted');
          const turn = script[i++];
          if (turn.toolCalls) {
            return { choices: [{ message: { content: turn.content || null, tool_calls: turn.toolCalls.map((c, idx) => ({
              id: `call_${i}_${idx}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
            })) } }] };
          }
          return { choices: [{ message: { content: turn.content } }] };
        },
      },
    },
  };
}

// ── gate v2 ────────────────────────────────────────────────────────────────

test('gate: office_edit without verify_visual → missing_visual_verify; a render alone does not count', () => {
  assert.deepEqual(needsVerification([{ tool: 'office_edit', ok: true }], { strict: true }),
    { needed: true, reason: 'missing_visual_verify' });
  assert.equal(needsVerification([{ tool: 'office_edit', ok: true }, { tool: 'render_preview', ok: true }], { strict: true }).reason,
    'missing_visual_verify');
  assert.deepEqual(needsVerification([{ tool: 'office_edit', ok: true }, { tool: 'verify_visual', ok: true }], { strict: true }),
    { needed: false, reason: null });
});

test('gate: verify_visual ERROR → visual_checks_failed; no renderer → terminal', () => {
  assert.deepEqual(needsVerification([{ tool: 'office_edit', ok: true }, { tool: 'verify_visual', ok: false }], { strict: true }),
    { needed: true, reason: 'visual_checks_failed' });
  assert.deepEqual(
    needsVerification([{ tool: 'office_edit', ok: true }, { tool: 'verify_visual', ok: false, renderUnavailable: true }], { strict: true }),
    { needed: true, reason: 'renderer_unavailable', terminal: true },
  );
  assert.equal(isRendererUnavailable('ERROR: LibreOffice (soffice) no está instalado en el sandbox: no se puede renderizar'), true);
  assert.equal(isRendererUnavailable('ERROR: verificación fallida\n✗ contiene «2026»'), false);
});

test('gate: read-only execute_python does not re-arm it; one that rewrote a docx requires verify_visual', () => {
  const verified = [{ tool: 'office_edit', ok: true }, { tool: 'verify_visual', ok: true }];
  assert.equal(needsVerification([...verified, { tool: 'execute_python', ok: true, mutated: false, changedOutputs: [] }], { strict: true }).needed, false);
  assert.equal(needsVerification([...verified, { tool: 'execute_python', ok: true, mutated: true, changedOutputs: ['outputs/tesis-editado-v2.docx'] }], { strict: true }).reason,
    'missing_visual_verify');
  // a .md written by a sub-agent keeps the render rule
  assert.equal(needsVerification([{ tool: 'write_file', ok: true, args: { path: 'outputs/informe.md' } }], { strict: true }).reason, 'missing_preview');
  assert.equal(needsVerification([{ tool: 'write_file', ok: true, args: { path: 'outputs/informe.md' } }, { tool: 'render_preview', ok: true }], { strict: true }).needed, false);
  // unknown snapshot → conservative: still an edit, render rule
  assert.equal(needsVerification([{ tool: 'execute_python', ok: true }], { strict: true }).reason, 'missing_preview');
  // the deterministic pptx tools keep render_preview
  assert.equal(needsVerification([{ tool: 'set_slide_background', ok: true }, { tool: 'render_preview', ok: true }], { strict: true }).needed, false);
});

test('gate: SIRAGPT_OFFICE_ENGINE=0 keeps the previous gate exactly', () => {
  const cases = [
    [],
    [{ tool: 'execute_python', ok: true }],
    [{ tool: 'execute_python', ok: true }, { tool: 'render_preview', ok: true }],
    [{ tool: 'execute_python', ok: true }, { tool: 'render_preview', ok: false }],
    [{ tool: 'execute_python', ok: true, mutated: false }],
    [{ tool: 'set_slide_background', ok: true }, { tool: 'render_preview', ok: true }],
  ];
  const expected = [
    { needed: false, reason: null },
    { needed: true, reason: 'missing_preview' },
    { needed: false, reason: null },
    { needed: true, reason: 'preview_failed' },
    { needed: true, reason: 'missing_preview' },
    { needed: false, reason: null },
  ];
  cases.forEach((steps, i) => assert.deepEqual(needsVerification(steps, { strict: false }), expected[i], `case ${i}`));
  const prev = process.env.SIRAGPT_OFFICE_ENGINE;
  process.env.SIRAGPT_OFFICE_ENGINE = '0';
  try {
    assert.deepEqual(needsVerification([{ tool: 'office_edit', ok: true }, { tool: 'render_preview', ok: true }]), { needed: false, reason: null });
  } finally {
    if (prev === undefined) delete process.env.SIRAGPT_OFFICE_ENGINE; else process.env.SIRAGPT_OFFICE_ENGINE = prev;
  }
});

test('nudges name the right tool', () => {
  assert.match(verificationNudge(1, 'missing_visual_verify'), /verify_visual NOW/);
  assert.match(verificationNudge(2, 'visual_checks_failed'), /Fix ONLY those items with office_edit/);
  assert.match(verificationNudge(1, 'missing_preview'), /render_preview/);
});

// ── loop integration ───────────────────────────────────────────────────────

test('loop: an office edit without verify_visual gets nudged, then finishes verified', async () => {
  const client = scriptedClient([
    { toolCalls: [{ name: 'office_edit', args: { src: 'uploads/t.docx', ops: [{ op: 'replace_text', find: '2024', replace: '2025' }] } }] },
    { content: 'Listo.' },
    { toolCalls: [{ name: 'verify_visual', args: { before: 'uploads/t.docx', after: 'outputs/t-editado.docx', checklist: ['2025'] } }] },
    { content: 'Listo, verificado.' },
  ]);
  const events = [];
  const result = await runAgentLoop({
    client, model: 'x', messages: [{ role: 'user', content: 'cambia el año' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async office_edit() { return '{"ok":true,"dst":"outputs/t-editado.docx"}'; },
      async verify_visual() { return 'VEREDICTO: VERIFICADO'; },
    },
    maxIterations: 8,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.stoppedReason, 'final');
  assert.equal(result.verificationAttempts, 1);
  const retry = events.find((e) => e.type === 'retry');
  assert.equal(retry.reason, 'missing_visual_verify');
});

test('loop: exec snapshot marks read-only vs rewrote-a-docx', async () => {
  let n = 0;
  const snapshots = [{ 'outputs/t.docx': '10 1' }, { 'outputs/t.docx': '10 1' }, { 'outputs/t.docx': '10 1' }, { 'outputs/t.docx': '12 2' }];
  const client = scriptedClient([
    { toolCalls: [{ name: 'execute_python', args: { code: 'print(open("outputs/t.docx","rb").read()[:4])' } }] },
    { toolCalls: [{ name: 'execute_python', args: { code: 'rewrite()' } }] },
    { toolCalls: [{ name: 'verify_visual', args: { after: 'outputs/t.docx', checklist: ['x'] } }] },
    { content: 'Listo.' },
  ]);
  const executors = {
    async execute_python() { return 'ok\n[exit 0]'; },
    async verify_visual() { return 'VEREDICTO: VERIFICADO'; },
    [OUTPUTS_SNAPSHOT]: async () => snapshots[Math.min(n++, snapshots.length - 1)],
  };
  const result = await runAgentLoop({
    client, model: 'x', messages: [{ role: 'user', content: 'edita el documento' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }), executors, maxIterations: 8,
  });
  const execs = result.steps.filter((s) => s.tool === 'execute_python');
  assert.equal(execs[0].mutated, false);
  assert.deepEqual(execs[0].changedOutputs, []);
  assert.equal(execs[1].mutated, true);
  assert.deepEqual(execs[1].changedOutputs, ['outputs/t.docx']);
  assert.equal(result.stoppedReason, 'final');
  assert.deepEqual(changedOutputs({ a: '1' }, { a: '1', b: '2' }), ['b']);
  assert.equal(changedOutputs(null, {}), null);
});

test('loop: no renderer in the sandbox ends honestly as «Sin verificación visual»', async () => {
  const client = scriptedClient([
    { toolCalls: [{ name: 'office_edit', args: { src: 'uploads/t.docx', ops: [{ op: 'replace_text', find: 'a', replace: 'b' }] } }] },
    { toolCalls: [{ name: 'verify_visual', args: { after: 'outputs/t-editado.docx', checklist: ['b'] } }] },
    { content: 'Listo.' },
  ]);
  const events = [];
  const result = await runAgentLoop({
    client, model: 'x', messages: [{ role: 'user', content: 'cambia a por b' }],
    tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
    executors: {
      async office_edit() { return '{"ok":true}'; },
      async verify_visual() { return 'ERROR: LibreOffice (soffice) no está instalado en el sandbox: no se puede renderizar'; },
    },
    maxIterations: 8,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.stoppedReason, 'verification_unavailable');
  assert.match(result.finalText, /No pude verificar visualmente/);
  const fin = events.find((e) => e.type === 'final');
  assert.equal(fin.verified, false);
  assert.equal(fin.label, 'Sin verificación visual');
});

test('context: the user request and the last document map survive heavy compaction', async () => {
  const prev = process.env.SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS;
  process.env.SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS = '8000';
  try {
    const request = `Cambia 2024 por 2025 en la portada y pon el título en negrita, sin tocar nada más. ${'contexto '.repeat(60)}`;
    const script = [{ toolCalls: [{ name: 'inspect_document', args: { path: 'uploads/t.docx' } }] }];
    for (let k = 0; k < 10; k += 1) script.push({ toolCalls: [{ name: 'read_file', args: { path: `tmp/big${k}.txt` } }] });
    script.push({ content: 'Listo, nada que editar.' });
    const client = scriptedClient(script);
    const map = `{"ok":true,"paragraphs":[{"i":8,"text":"Lima, 2024"}],"pad":"${'m'.repeat(3000)}"}`;
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: request }];
    const result = await runAgentLoop({
      client, model: 'x', messages,
      tools: tools.buildToolDefinitions({ NODE_ENV: 'test' }),
      executors: {
        async inspect_document() { return map; },
        async read_file(args) { return `${args.path}\n${'x'.repeat(20_000)}`; },
      },
      maxIterations: 16,
    });
    assert.equal(result.stoppedReason, 'final');
    assert.ok(messages.some((m) => m.role === 'user' && m.content === request), 'the literal request survived verbatim');
    assert.ok(messages.some((m) => typeof m.content === 'string' && m.content.includes(map)), 'the document map survived verbatim');
  } finally {
    if (prev === undefined) delete process.env.SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS; else process.env.SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS = prev;
  }
});

test('context: budget is separate from max_tokens and clamped', () => {
  assert.equal(resolveContextBudgetTokens({}), 60_000);
  assert.equal(resolveContextBudgetTokens({ SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS: '500' }), 8_000);
  assert.equal(resolveContextBudgetTokens({ SIRAGPT_AGENT_RUNNER_CONTEXT_TOKENS: '999999' }), 120_000);
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'Cambia 2024…' }];
  restorePinnedMessages(msgs, { request: 'Cambia 2024 por 2025 en la portada' });
  assert.equal(msgs[1].content, 'Cambia 2024 por 2025 en la portada', 'a truncated request is restored in place');
});

// ── vision ladder ──────────────────────────────────────────────────────────

function candidates() {
  return [
    { provider: 'DeepSeek', model: 'deepseek-flash', apiKey: 'k', baseURL: 'u' },
    { provider: 'xAI', model: 'grok-4.6', apiKey: 'k', baseURL: 'u' },
  ];
}

test('vision ladder: quota errors fail over; "cannot take images" fails over AND demotes', async () => {
  ladder.resetVisionDemotions();
  const seen = [];
  const behaviour = { 'deepseek-flash': [Object.assign(new Error('402'), { status: 402 })], 'grok-4.6': [] };
  const client = ladder.createVisionClient(candidates(), {
    createClient: (c) => ({ chat: { completions: { create: async (p) => {
      seen.push(p.model);
      const err = (behaviour[c.model] || []).shift();
      if (err) throw err;
      return { choices: [{ message: { content: '{"veredicto":"ok","items":[],"problemas":[]}' } }] };
    } } } }),
  });
  await client.chat.completions.create({ model: 'ignored', messages: [] });
  assert.deepEqual(seen, ['deepseek-flash', 'grok-4.6']);
  seen.length = 0;
  await client.chat.completions.create({ model: 'ignored', messages: [] });
  assert.deepEqual(seen, ['deepseek-flash'], '402 is transient: DeepSeek is tried again next time');

  behaviour['deepseek-flash'] = [Object.assign(new Error('unsupported image'), { status: 400 })];
  seen.length = 0;
  await client.chat.completions.create({ model: 'ignored', messages: [] });
  seen.length = 0;
  await client.chat.completions.create({ model: 'ignored', messages: [] });
  assert.deepEqual(seen, ['grok-4.6'], 'a 400 on images demotes the candidate (live probe, cached)');
  ladder.resetVisionDemotions();
});

test('vision ladder: no candidate → no verifier; every candidate down → ok:null (automatic checks only)', async () => {
  assert.equal(ladder.createVisionClient([]), null);
  ladder.resetVisionDemotions();
  const client = ladder.createVisionClient(candidates(), {
    createClient: () => ({ chat: { completions: { create: async () => { throw Object.assign(new Error('503'), { status: 503 }); } } } }),
  });
  const verify = makeVisionVerifier({ client });
  const out = await verify({ images: [], checklist: ['x'] });
  assert.equal(out.ok, null);
  assert.match(out.text, /visión no disponible/);
  ladder.resetVisionDemotions();
});

test('vision ladder: an empty / JSON-less answer (reasoning budget spent) moves to the next model', async () => {
  ladder.resetVisionDemotions();
  const seen = [];
  const payloads = [];
  const answers = {
    'deepseek-flash': { choices: [{ message: { content: '', reasoning_content: 'pensando…' } }] },
    'grok-4.6': { choices: [{ message: { content: '```json\n{"veredicto":"ok","items":[{"requisito":"Lima, 2025","cumple":true,"evidencia":"pág. 1"}],"problemas":[]}\n```' } }] },
  };
  const failovers = [];
  const client = ladder.createVisionClient(candidates(), {
    createClient: (c) => ({ chat: { completions: { create: async (p) => { seen.push(p.model); payloads.push(p); return answers[c.model]; } } } }),
    onFailover: (f) => failovers.push(`${f.model}:${f.status}:${f.demoted}`),
  });
  const verify = makeVisionVerifier({ client });
  const out = await verify({ images: [], checklist: ['Lima, 2025'] });
  assert.deepEqual(seen, ['deepseek-flash', 'grok-4.6']);
  assert.equal(out.ok, true);
  assert.match(out.text, /✓ Lima, 2025/);
  assert.deepEqual(failovers, ['deepseek-flash:unusable:false'], 'no demotion: the next review tries it again');
  assert.ok(payloads.every((p) => p.max_tokens >= 4000), 'room for reasoning models');
  // Nobody answers usably → the first answer is kept and the review is ok:null.
  answers['grok-4.6'] = { choices: [{ message: { content: 'No puedo ver la imagen.' } }] };
  const none = await verify({ images: [], checklist: ['x'] });
  assert.equal(none.ok, null);
  assert.match(none.text, /no devolvió JSON/);
  ladder.resetVisionDemotions();
});

test('vision ladder: resolves only configured providers, picked vision model first', () => {
  ladder.resetVisionDemotions();
  const env = { XAI_API_KEY: 'x', DEEPSEEK_API_KEY: 'd' };
  assert.deepEqual(ladder.resolveVisionCandidates({ env }).map((c) => c.model), ['deepseek-flash', 'grok-4.6']);
  assert.deepEqual(ladder.resolveVisionCandidates({ env, pickedModel: 'grok-4.7' }).map((c) => c.model), ['grok-4.7', 'deepseek-flash', 'grok-4.6']);
  assert.deepEqual(ladder.resolveVisionCandidates({ env, pickedModel: 'deepseek-v4-pro' }).map((c) => c.model), ['deepseek-flash', 'grok-4.6'],
    'a text-only picked model is skipped');
  assert.equal(ladder.resolveVisionCandidates({ env: {} }).length, 0);
});

// ── runner-level honesty + budgets ─────────────────────────────────────────

test('runner: the reply says when no vision model reviewed the result', () => {
  const t = 'Listo: cambié 2024 por 2025.';
  assert.match(runner.withVisionHonesty(t, { passed: true, visionOk: null }), /no hubo revisión con modelo de visión/);
  assert.equal(runner.withVisionHonesty(t, { passed: true, visionOk: true }), t);
  assert.equal(runner.withVisionHonesty(`${t} Sin revisión visual.`, { passed: true, visionOk: null }), `${t} Sin revisión visual.`);
  assert.equal(runner.withVisionHonesty(t, null), t);
  assert.equal(runner.buildVisionVerifier({ env: { NODE_ENV: 'test', XAI_API_KEY: 'x' } }), null, 'no network in tests');
});

test('runner: document turns get 8192 output tokens unless the env pins a value', () => {
  assert.equal(runner.documentTurnMaxTokens(['tesis.docx'], {}), 8192);
  assert.equal(runner.documentTurnMaxTokens(['notas.md'], {}), null);
  assert.equal(runner.documentTurnMaxTokens(['tesis.docx'], { SIRAGPT_AGENT_RUNNER_MAX_TOKENS: '4096' }), null);
});

test('prompt: office workflow with the engine on; previous rules verbatim with it off', () => {
  const on = buildAgentRunnerPrompt({ fileNames: ['t.docx'], officeEngine: true });
  assert.match(on, /OFFICE FILES \(docx\/xlsx\/pptx\) — MANDATORY WORKFLOW/);
  assert.match(on, /Always fill `description` in every tool call/);
  assert.doesNotMatch(on, /a\) call render_preview on the output file/);
  const off = buildAgentRunnerPrompt({ fileNames: ['t.docx'], officeEngine: false });
  assert.doesNotMatch(off, /MANDATORY WORKFLOW/);
  assert.match(off, /a\) call render_preview on the output file/);
});

test('a sandbox without LibreOffice is reported to the turn-failure tracker', async () => {
  const office = require('../src/services/agent-runner/tools.office');
  const failures = [];
  const sandbox = {
    async exec(cmd) {
      if (String(cmd).includes('sira_office.py')) {
        return { stdout: '{"ok":false,"error":"LibreOffice (soffice) no está instalado en el sandbox: no se puede renderizar"}\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async writeFile() {},
  };
  const ex = office.makeOfficeToolExecutors(sandbox, { onFailure: (f) => failures.push(f) });
  const out = await ex.verify_visual({ after: 'outputs/t.docx', checklist: ['x'] });
  assert.match(out, /^ERROR: LibreOffice/);
  assert.deepEqual(failures.map((f) => [f.tool, f.code]), [['verify_visual', 'renderer_unavailable']]);
});
