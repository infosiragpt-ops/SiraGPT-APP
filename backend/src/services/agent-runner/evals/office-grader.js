'use strict';

/**
 * Grade a delivered office file against its SPEC scenario (Fase F) inside a
 * sandbox session (doc-agent/sandbox.js): the engine and the grader run
 * where python3 + lxml + LibreOffice live, never in the Node process.
 */

const path = require('path');

const { installOfficeEngine, ENGINE_REL } = require('../tools.office');
const { GRADER_PY, scenarioById } = require('./office-scenarios');

const GRADER_REL = 'tmp/office_eval_grader.py';

/**
 * @param {object} opts
 * @param {object} opts.sandbox     doc-agent sandbox session
 * @param {string} opts.scenarioId  one of SCENARIOS[].id
 * @param {Buffer} opts.before      the original fixture
 * @param {Buffer} opts.after       the file the agent delivered
 * @param {boolean} [opts.render]   page-level checks (needs soffice + pdftoppm)
 * @returns {Promise<{ ok: boolean, checks: Array<{ name, ok, detail }> }>}
 */
async function gradeOfficeOutput({ sandbox, scenarioId, before, after, render = true, timeoutMs = 300_000 } = {}) {
  const scenario = scenarioById(scenarioId);
  if (!scenario) throw new Error(`escenario desconocido: ${scenarioId}`);
  if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after)) {
    return { ok: false, checks: [{ name: 'hay archivo entregado', ok: false, detail: 'sin archivo' }] };
  }
  const ext = path.extname(scenario.fixture);
  await sandbox.exec('mkdir -p /workspace/tmp /workspace/eval', { timeoutMs: 10_000 });
  if (!(await installOfficeEngine(sandbox))) {
    return { ok: false, checks: [{ name: 'motor instalado', ok: false, detail: 'sira_office.py no disponible' }] };
  }
  const beforeRel = `eval/before${ext}`;
  const afterRel = `eval/after${ext}`;
  await sandbox.writeFile(GRADER_REL, GRADER_PY);
  await sandbox.writeFile(beforeRel, before);
  await sandbox.writeFile(afterRel, after);
  await sandbox.writeFile('tmp/office_eval_args.json', JSON.stringify({
    scenario: scenario.id, before: beforeRel, after: afterRel, outdir: 'eval/verify', render: Boolean(render),
  }));
  const r = await sandbox.exec(`cd /workspace && python3 ${GRADER_REL} ${ENGINE_REL} tmp/office_eval_args.json`, { timeoutMs });
  const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  try {
    const parsed = JSON.parse(last);
    return { ok: Boolean(parsed.ok), checks: Array.isArray(parsed.checks) ? parsed.checks : [] };
  } catch (_) {
    return {
      ok: false,
      checks: [{ name: 'el calificador respondió', ok: false, detail: String(r.stderr || r.stdout || '').slice(0, 300) }],
    };
  }
}

module.exports = {
  gradeOfficeOutput,
};
