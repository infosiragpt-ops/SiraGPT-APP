'use strict';

/**
 * Edición milimétrica — Fase F.2: office metrics on the shared Prometheus
 * registry + the per-turn `[office-edit]` line; step latency from the loop;
 * the verify hook carries checks-vs-vision and pagination facts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../src/services/agents/metrics');
const { recordVerify, recordOfficeTurn } = require('../src/services/agent-runner/office-metrics');
const { makeOfficeToolExecutors } = require('../src/services/agent-runner/tools.office');
const { runAgentLoop } = require('../src/services/agent-runner/loop');
const { TOOL_DEFINITIONS } = require('../src/services/agent-runner/tools');

function metricValue(text, pattern) {
  const line = text.split('\n').find((l) => pattern.test(l));
  return line ? Number(line.trim().split(/\s+/).pop()) : 0;
}

test('recordVerify: pass / fail, pagination changes and vision disagreements', () => {
  const before = metrics.renderText();
  recordVerify({ passed: true, checksOk: true, visionOk: true });
  recordVerify({ passed: false, checksOk: true, visionOk: false, paginationChanged: true });
  recordVerify({ passed: false, checksOk: false, visionOk: true });
  const after = metrics.renderText();
  const delta = (re) => metricValue(after, re) - metricValue(before, re);
  assert.equal(delta(/^office_verify_total\{result="pass"\}/), 1);
  assert.equal(delta(/^office_verify_total\{result="fail"\}/), 2);
  assert.equal(delta(/^office_pagination_changed_total/), 1);
  assert.equal(delta(/^office_vision_disagreement_total\{direction="vision_veto"\}/), 1);
  assert.equal(delta(/^office_vision_disagreement_total\{direction="checks_fail_vision_ok"\}/), 1);
});

test('recordOfficeTurn: one [office-edit] line per document turn; latency and attempts observed', () => {
  const lines = [];
  const before = metrics.renderText();
  const record = recordOfficeTurn({
    steps: [
      { tool: 'inspect_document', ok: true, durationMs: 600 },
      { tool: 'office_edit', ok: true, durationMs: 800 },
      { tool: 'verify_visual', ok: false, durationMs: 5000 },
      { tool: 'office_edit', ok: true, durationMs: 700 },
      { tool: 'verify_visual', ok: true, durationMs: 4800 },
    ],
    stoppedReason: 'final',
    verifies: [
      { passed: false, checksOk: true, visionOk: false, paginationChanged: false },
      { passed: true, checksOk: true, visionOk: true, paginationChanged: false },
    ],
    chatId: 'chat-1',
    log: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[office-edit\] \{/);
  assert.equal(record.edits, 2);
  assert.equal(record.verifyAttempts, 2);
  assert.equal(record.verified, true);
  assert.equal(record.visionReviewed, true);
  assert.equal(record.visionDisagreements, 1);
  const after = metrics.renderText();
  assert.equal(
    metricValue(after, /^office_verify_attempts_per_turn_count/) - metricValue(before, /^office_verify_attempts_per_turn_count/),
    1,
  );
  assert.equal(
    metricValue(after, /^office_tool_latency_ms_count\{tool="verify_visual"\}/) - metricValue(before, /^office_tool_latency_ms_count\{tool="verify_visual"\}/),
    2,
  );
  assert.equal(recordOfficeTurn({ steps: [{ tool: 'execute_python', ok: true }], log: () => lines.push('x') }), null, 'non-office turns log nothing');
  assert.equal(lines.length, 1);
  const unavailable = recordOfficeTurn({ steps: [{ tool: 'office_edit', ok: true }, { tool: 'verify_visual', ok: false, renderUnavailable: true }], log: () => {} });
  assert.equal(unavailable.renderUnavailable, 1);
  assert.equal(unavailable.verified, false);
});

test('verify_visual hands checks-vs-vision and pagination facts to onVerify', async () => {
  const report = {
    ok: true,
    summary: 'Verificación: a.docx vs b.docx\n• Resultado: OK',
    composites: ['previews/v/compare-p1.png'],
    visual: { pagination_changed: true },
  };
  const sandbox = {
    async writeFile() {},
    async readFile() { return Buffer.from([0xff, 0xd8, 0xff]); },
    async exec(cmd) {
      if (/sira_office\.py verify/.test(cmd)) return { exitCode: 0, stdout: JSON.stringify(report) };
      return { exitCode: 0, stdout: '' };
    },
  };
  const seen = [];
  const ex = makeOfficeToolExecutors(sandbox, {
    visionVerifier: async () => ({ ok: false, text: '✗ el título no cambió' }),
    onVerify: (v) => seen.push(v),
  });
  const out = await ex.verify_visual({ before: 'uploads/a.docx', after: 'outputs/a.docx', checklist: ['título en azul'] });
  assert.match(String(out), /NO VERIFICADO/);
  assert.equal(seen.length, 1);
  assert.deepEqual(
    { passed: seen[0].passed, checksOk: seen[0].checksOk, visionOk: seen[0].visionOk, paginationChanged: seen[0].paginationChanged },
    { passed: false, checksOk: true, visionOk: false, paginationChanged: true },
  );
});

test('loop steps carry durationMs (per-tool latency)', async () => {
  let i = 0;
  const script = [
    { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'inspect_document', arguments: JSON.stringify({ path: 'uploads/a.docx' }) } }] },
    { content: 'Listo.' },
  ];
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: script[i++] }] }) } } };
  const result = await runAgentLoop({
    client,
    model: 'test/model',
    messages: [{ role: 'user', content: 'lee el documento' }],
    tools: TOOL_DEFINITIONS,
    executors: { async inspect_document() { await new Promise((r) => setTimeout(r, 15)); return '{"paragraphs":[]}'; } },
    maxIterations: 4,
  });
  const step = result.steps.find((s) => s.tool === 'inspect_document');
  assert.ok(Number.isFinite(step.durationMs) && step.durationMs >= 10, `durationMs=${step.durationMs}`);
});
