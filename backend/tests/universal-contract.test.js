/**
 * universal-contract regression suite — deterministic pass/fail
 * checks for the TaskContract v1.1 pipeline. Runs without the
 * network so CI can execute it on every push.
 *
 * Each case encodes an adversarial scenario the cognitive-agentic
 * pipeline must handle correctly:
 *   - wrong-extension substitution is blocked
 *   - pipeline categorisation is correct
 *   - ambiguity gate fires when (and only when) it should
 *   - manifest validation rejects malformed manifests
 *   - FailureReport captures the reviewer's diagnosis
 */

const { strict: assert } = require('assert');
const { validateContract, makeEmptyContract } = require('../src/services/agents/task-contract-resolver');
const { pickPipeline } = require('../src/services/agents/pipeline-registry');
const { enforceSovereignty } = require('../src/services/agents/format-sovereignty');
const { reviewArtifact } = require('../src/services/agents/artifact-reviewer');
const { validateManifest, BUILTIN_MANIFESTS } = require('../src/services/agents/tool-manifest');
const { createFailureReport, fromSovereignty } = require('../src/services/agents/failure-report');
const { shouldClarifyBeforeActing, EVENTS } = require('../src/services/agents/agent-events');

const cases = [
  // 1. Schema accepts minimal v1.0-shaped contract.
  () => {
    const c = makeEmptyContract('hola');
    const v = validateContract(c);
    assert.equal(v.ok, true, 'minimal contract should validate');
  },

  // 2. SVG contract rejects .docx substitution.
  () => {
    const contract = {
      required_extension: 'svg',
      mime_type: 'image/svg+xml',
      forbidden_outputs: ['No entregar .docx'],
      task_category: 'visual-artifact',
    };
    const sov = enforceSovereignty({
      contract,
      artifact: { filename: 'casa.docx', buffer: Buffer.from('not real') },
    });
    assert.equal(sov.ok, false, 'docx substitution must be blocked');
    const ids = sov.violations.map(v => v.id);
    assert.ok(ids.includes('required_extension_mismatch'), 'expected extension mismatch violation');
  },

  // 3. SVG contract accepts valid SVG.
  () => {
    const contract = { required_extension: 'svg', mime_type: 'image/svg+xml' };
    const svgBuf = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>');
    const sov = enforceSovereignty({ contract, artifact: { filename: 'ok.svg', buffer: svgBuf } });
    assert.equal(sov.ok, true, `valid SVG should pass sovereignty. violations: ${JSON.stringify(sov.violations)}`);
  },

  // 4. Pipeline registry routes visual-artifact category.
  () => {
    const pipe = pickPipeline({ task_category: 'visual-artifact' });
    assert.equal(pipe.id, 'visual-artifact');
    assert.ok(pipe.allowedExtensions.includes('svg'));
  },

  // 5. Pipeline registry infers from artifact_type when category missing.
  () => {
    const pipe = pickPipeline({ artifact_type: 'spreadsheet' });
    assert.equal(pipe.id, 'spreadsheet');
  },

  // 6. Ambiguity gate fires when ambiguity_level=high + questions.
  () => {
    const gate = shouldClarifyBeforeActing({ ambiguity_level: 'high', clarifying_questions: ['¿qué tamaño?'] });
    assert.equal(gate.shouldAsk, true);
    const none = shouldClarifyBeforeActing({ ambiguity_level: 'low', clarifying_questions: [] });
    assert.equal(none.shouldAsk, false);
  },

  // 7. All 8 builtin tool manifests validate.
  () => {
    for (const [name, m] of Object.entries(BUILTIN_MANIFESTS)) {
      const v = validateManifest(m);
      assert.equal(v.ok, true, `manifest ${name} should validate — errors: ${JSON.stringify(v.errors).slice(0, 300)}`);
    }
  },

  // 8. ArtifactReviewer rejects forbidden-format substitution.
  () => {
    const contract = {
      required_extension: 'svg',
      mime_type: 'image/svg+xml',
      success_tests: [
        { id: 'extension_match', type: 'deterministic', description: 'ext svg', check: 'extension_match', parameters: { value: 'svg' } },
        { id: 'no_docx', type: 'deterministic', description: 'not docx', check: 'forbidden_format_absent', parameters: { extensions: ['docx', 'pdf'] } },
      ],
    };
    const review = reviewArtifact({ contract, artifact: { filename: 'x.docx', buffer: Buffer.from('not') } });
    assert.equal(review.passed, false);
    assert.ok(review.failedTests.some(f => f.id === 'extension_match'));
    assert.ok(review.failedTests.some(f => f.id === 'no_docx'));
  },

  // 9. FailureReport built from sovereignty has actionable repair strategy.
  () => {
    const sov = enforceSovereignty({
      contract: { required_extension: 'svg', mime_type: 'image/svg+xml', task_category: 'visual-artifact' },
      artifact: { filename: 'x.docx', buffer: Buffer.from('not') },
    });
    const fr = fromSovereignty(sov);
    assert.equal(fr.failed_stage, 'format_validation');
    assert.equal(fr.release_decision, 'retry');
    assert.ok(fr.repair_strategy.length > 20, 'repair strategy should be descriptive');
  },

  // 10. createFailureReport rejects unknown stages.
  () => {
    assert.throws(() => createFailureReport({
      failed_stage: 'bogus',
      expected_output: 'x',
      actual_output: 'y',
      root_cause: 'z',
      repair_strategy: 'try again',
    }));
  },

  // 11. Event name constants are non-empty strings.
  () => {
    for (const [k, v] of Object.entries(EVENTS)) {
      assert.equal(typeof v, 'string', `${k} should be a string`);
      assert.ok(v.length > 3, `${k} should be non-trivial`);
    }
  },

  // 12. Spreadsheet pipeline requires create_document + verify_artifact.
  () => {
    const pipe = pickPipeline({ task_category: 'spreadsheet' });
    assert.ok(pipe.requiredTools.includes('create_document'));
    assert.ok(pipe.requiredTools.includes('verify_artifact'));
  },
];

let passed = 0;
let failed = 0;
const failures = [];
cases.forEach((fn, i) => {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ case: i + 1, message: err.message });
  }
});

console.log(`universal-contract regression: ${passed}/${cases.length} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL ${f.case}: ${f.message}`);
  process.exit(1);
}
process.exit(0);
