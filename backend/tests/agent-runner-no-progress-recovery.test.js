'use strict';

// Production 2026-10-08, right after #1009 went live: «Genérame una ppt…»
// built the deck, then describe_image failed twice (it rode the loop's text
// model, DeepSeek V4 Flash, which cannot see images) and a python crop failed
// once; three failed tool calls in a row cut the turn with the finished file
// sitting in outputs/. Two fixes:
//   1. describe_image rides the vision ladder verify_visual already uses, and
//      is not offered at all when no vision model is available;
//   2. the no-progress guard speaks once (RECOVERY REQUIRED) before it cuts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  NO_PROGRESS_NUDGE_PREFIX,
  MAX_ERROR_CHARS,
  describeFailedSteps,
  noProgressNudge,
} = require('../src/services/agent-runner/no-progress-nudge');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { OUTPUTS_SNAPSHOT } = require('../src/services/agent-runner/tools.office');
const multimodal = require('../src/services/agent-runner/multimodal');
const runner = require('../src/services/agent-runner');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '../src/services/agent-runner/index.js'), 'utf8');

/** Deterministic model: one tool call (or a final text) per LLM call; records every transcript. */
function scripted(script) {
  let i = 0;
  const seen = [];
  const client = { chat: { completions: { create: async (payload) => {
    seen.push(payload.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })));
    if (i >= script.length) throw new Error('scripted client exhausted');
    const turn = script[i++];
    if (turn.tool) {
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: `c${i}`, type: 'function', function: { name: turn.tool, arguments: JSON.stringify(turn.args || {}) },
      }] } }] };
    }
    return { choices: [{ message: { role: 'assistant', content: turn.content } }] };
  } } } };
  return { client, seen };
}

const nudgesIn = (transcript) => transcript.filter((m) => m.role === 'user' && m.content.startsWith(NO_PROGRESS_NUDGE_PREFIX));

test('the nudge names each failed call (tool + error without the ERROR: prefix), bounded', () => {
  const steps = [
    { tool: 'describe_image', ok: false, resultPreview: 'ERROR: la descripción de imagen falló: 400 image_url not supported' },
    { tool: 'list_files', ok: true, resultPreview: 'outputs/deck.pptx' },
    { tool: 'execute_python', ok: false, resultPreview: `ERROR: ${'x'.repeat(400)}` },
  ];
  const lines = describeFailedSteps(steps);
  assert.equal(lines.length, 2, 'successful steps are not listed');
  assert.equal(lines[0], '1) describe_image: la descripción de imagen falló: 400 image_url not supported');
  assert.ok(lines[1].startsWith('2) execute_python: xxx'));
  assert.ok(lines[1].length <= `2) execute_python: `.length + MAX_ERROR_CHARS);
  const text = noProgressNudge(steps.filter((s) => s.ok === false));
  assert.match(text, /^RECOVERY REQUIRED: the last 2 tool calls failed in a row/);
  assert.match(text, /Do NOT repeat a failed call/);
  assert.match(text, /inspect_document and verify_visual \(after=<that file>, no before/);
  assert.match(text, /never pretend it worked/);
  assert.match(noProgressNudge([]), /the last 1 tool calls failed/);
});

test('production shape: two describe_image failures + one python failure → ONE nudge, then the turn recovers', async () => {
  const { client, seen } = scripted([
    { tool: 'describe_image', args: { path: 'previews/deck/page-07.png' } },
    { tool: 'describe_image', args: { path: 'previews/deck/page-07.png', question: 'bordes' } },
    { tool: 'execute_python', args: { code: 'crop()' } },
    { tool: 'list_files', args: { path: 'outputs' } },
    { content: 'Listo: la presentación quedó en outputs/deck.pptx.' },
  ]);
  const events = [];
  let describes = 0;
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Genérame una ppt sobre la hidratación en el embarazo' }],
    tools: [],
    executors: {
      async describe_image() { describes += 1; return `ERROR: la descripción de imagen falló: 400 image_url is not supported (intento ${describes})`; },
      async execute_python() { return 'ERROR: python failed [exit 1]\nFileNotFoundError: previews/deck/page-07.png'; },
      async list_files() { return 'outputs/deck.pptx'; },
      [OUTPUTS_SNAPSHOT]: async () => ({}),
    },
    maxIterations: 8,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(result.stoppedReason, 'final', `turn must finish, got ${result.stoppedReason} (${result.errorMessage || ''})`);
  assert.equal(seen.length, 5, 'three failed calls, the recovery call, the final answer');
  assert.equal(nudgesIn(seen[2]).length, 0, 'no nudge before the third failure');
  const fourth = seen[3];
  assert.equal(nudgesIn(fourth).length, 1, 'exactly one nudge in the transcript');
  assert.ok(fourth[fourth.length - 1].content.startsWith(NO_PROGRESS_NUDGE_PREFIX), 'the nudge is the latest user turn');
  assert.match(fourth[fourth.length - 1].content, /1\) describe_image: la descripción de imagen falló/);
  assert.match(fourth[fourth.length - 1].content, /3\) execute_python: python failed/);
  assert.equal(nudgesIn(seen[4]).length, 1, 'the nudge is never repeated');
  const recoveries = events.filter((ev) => ev && ev.type === 'no_progress_recovery');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].label, 'Tres pasos fallidos seguidos: cambiando de estrategia');
  assert.deepEqual(recoveries[0].failed, ['describe_image', 'describe_image', 'execute_python']);
  assert.equal(events.some((ev) => ev && ev.type === 'error' && ev.code === 'subtask_no_progress'), false);
  assert.equal(result.steps.length, 4);
  assert.equal(result.steps[3].ok, true);
});

test('three MORE consecutive failures after the nudge still cut the turn (subtask_no_progress), with no second nudge', async () => {
  const { client, seen } = scripted([
    { tool: 'glob', args: { pattern: '*.pptx' } },
    { tool: 'grep', args: { pattern: 'título' } },
    { tool: 'read_file', args: { path: 'a.md' } },
    { tool: 'list_files', args: { path: 'outputs' } },
    { tool: 'describe_image', args: { path: 'x.png' } },
    { tool: 'execute_bash', args: { command: 'ls' } },
    { content: 'should-not-run' },
  ]);
  const events = [];
  let n = 0;
  const fail = (name) => async () => { n += 1; return `ERROR: ${name} falló (${n})`; };
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'lista' }],
    tools: [],
    executors: {
      glob: fail('glob'), grep: fail('grep'), read_file: fail('read_file'),
      list_files: fail('list_files'), describe_image: fail('describe_image'), execute_bash: fail('bash'),
      [OUTPUTS_SNAPSHOT]: async () => ({}),
    },
    maxIterations: 10,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(result.stoppedReason, 'subtask_no_progress');
  assert.equal(result.errorCode, 'subtask_no_progress');
  assert.notEqual(result.finalText, 'should-not-run');
  assert.equal(seen.length, 6, 'the cut happens right after the sixth failure; the model is not called again');
  assert.equal(result.steps.length, 6);
  assert.equal(events.filter((ev) => ev && ev.type === 'no_progress_recovery').length, 1);
  assert.equal(nudgesIn(seen[5]).length, 1, 'one nudge only, even though failures continued');
  assert.equal(events.filter((ev) => ev && ev.type === 'error' && ev.code === 'subtask_no_progress').length, 1);
});

test('describe_image is offered and wired only when a vision-capable client exists', () => {
  const env = { NODE_ENV: 'test', SIRAGPT_AGENT_VISION: '1' };
  const sandbox = { readFile: async () => Buffer.alloc(0) };
  const without = multimodal.prepareF7Extras({ env, sandbox });
  assert.deepEqual(without.toolDefinitions.map((d) => d.function.name), []);
  assert.equal('describe_image' in without.executors, false);

  const fake = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }] }) } } };
  const withClient = multimodal.prepareF7Extras({ env, sandbox, client: fake });
  assert.deepEqual(withClient.toolDefinitions.map((d) => d.function.name), ['describe_image']);
  assert.equal(typeof withClient.executors.describe_image, 'function');
  assert.match(withClient.toolDefinitions[0].function.description, /verify_visual/);

  assert.equal(multimodal.hasVisionClient(fake), true);
  assert.equal(multimodal.hasVisionClient({ chat: {} }), false);
  assert.equal(multimodal.hasVisionClient(null), false);
  assert.deepEqual(multimodal.extraToolDefinitions({ env, vision: false }), []);
  assert.equal(multimodal.extraToolDefinitions({ env }).length, 1, 'standalone contract: flags decide by default');
});

test('the vision ladder client is built from providers that SEE images, never from the picked text model', () => {
  const prod = { NODE_ENV: 'production', DEEPSEEK_API_KEY: 'sk-live-deepseek-abcdef' };
  const ladder = runner.buildVisionLadderClient({ pickedModel: 'DeepSeek:deepseek-v4-flash', env: prod });
  assert.ok(ladder && typeof ladder.chat.completions.create === 'function');
  const candidates = ladder.candidates();
  assert.ok(candidates.some((c) => c.provider === 'DeepSeek' && c.model === 'deepseek-flash'), JSON.stringify(candidates));
  assert.equal(candidates.some((c) => c.model === 'deepseek-v4-flash'), false, 'the text model never joins the ladder');
  assert.equal(runner.buildVisionLadderClient({ pickedModel: 'DeepSeek:deepseek-v4-flash', env: { NODE_ENV: 'production' } }), null, 'no key, no vision');
  assert.equal(runner.buildVisionLadderClient({ env: { NODE_ENV: 'test', DEEPSEEK_API_KEY: 'sk-live-deepseek-abcdef' } }), null, 'no network in tests');
  assert.equal(runner.buildVisionVerifier({ env: { NODE_ENV: 'test', DEEPSEEK_API_KEY: 'sk-live-deepseek-abcdef' } }), null);
});

test('source contract: the runner hands describe_image and verify_visual the SAME vision ladder, never the loop client', () => {
  const f7 = /prepareF7Extras\(\{[\s\S]*?\}\);/.exec(INDEX_SRC);
  assert.ok(f7, 'prepareF7Extras call present');
  assert.match(f7[0], /client: visionLadder,/);
  assert.match(f7[0], /model: null,/);
  assert.equal(/client: llm,/.test(f7[0]), false, 'the loop text model must never receive image_url content');
  assert.match(INDEX_SRC, /const visionLadder = visionClient \|\| buildVisionLadderClient\(\{ pickedModel: model, onFailover: visionFailover \}\);/);
  assert.match(INDEX_SRC, /visionVerifier: buildVisionVerifier\(\{\s*pickedModel: model,\s*client: visionLadder,/);
});
