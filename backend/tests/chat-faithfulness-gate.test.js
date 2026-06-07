'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../src/services/chat-faithfulness-gate');

const longResponse = 'Según el análisis, el proyecto alcanzó 12345 usuarios en 2027 y la empresa AcmeCorp facturó 9876 EUR. '.repeat(4);

describe('shouldVerify', () => {
  test('true only when decision.verify.faithfulness is true', () => {
    assert.equal(gate.shouldVerify({ verify: { faithfulness: true } }), true);
    assert.equal(gate.shouldVerify({ verify: { faithfulness: false } }), false);
    assert.equal(gate.shouldVerify({}), false);
    assert.equal(gate.shouldVerify(null), false);
  });
});

describe('buildGroundingContext', () => {
  test('collects non-empty blocks with kinds, drops empties', () => {
    const ctx = gate.buildGroundingContext({
      evidenceBlock: 'RAG evidence here',
      memoryBlock: '   ',
      uploadedFileContext: 'file content',
      webSearchBlock: '',
    });
    const kinds = ctx.map((c) => c.kind);
    assert.deepEqual(kinds, ['rag_evidence', 'file']);
  });

  test('returns [] when nothing is grounded', () => {
    assert.deepEqual(gate.buildGroundingContext({}), []);
  });
});

describe('verify — gating', () => {
  const fakePass = { postprocess: () => ({ ok: true, action: 'pass', report: { grade: 'A', score: 0.95 } }) };

  test('skips when not planned', () => {
    const r = gate.verify({ response: longResponse, decision: { verify: { faithfulness: false } }, blocks: { evidenceBlock: 'x' }, deps: { postprocessor: fakePass } });
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'not_planned');
  });

  test('skips a too-short response', () => {
    const r = gate.verify({ response: 'Listo.', decision: { verify: { faithfulness: true } }, blocks: { evidenceBlock: 'x'.repeat(50) }, deps: { postprocessor: fakePass } });
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'response_too_short');
  });

  test('skips when there is no grounding context', () => {
    const r = gate.verify({ response: longResponse, decision: { verify: { faithfulness: true } }, blocks: {}, deps: { postprocessor: fakePass } });
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'no_grounding_context');
  });

  test('skips when postprocessor unavailable', () => {
    const r = gate.verify({ response: longResponse, decision: { verify: { faithfulness: true } }, blocks: { evidenceBlock: 'x'.repeat(50) }, deps: { postprocessor: null } });
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'postprocessor_unavailable');
  });

  test('passes through a clean answer', () => {
    const r = gate.verify({ response: longResponse, decision: { verify: { faithfulness: true, threshold: 0.55 } }, blocks: { evidenceBlock: 'x'.repeat(50) }, deps: { postprocessor: fakePass } });
    assert.equal(r.ran, true);
    assert.equal(r.action, 'pass');
    assert.equal(r.grade, 'A');
  });
});

describe('verify — annotate path', () => {
  const fakeFail = {
    postprocess: () => ({
      ok: false,
      action: 'annotate',
      report: { grade: 'F', score: 0.2 },
      repair: { userFooter: '---\n> ⚠️ Auto-fidelity check: F (0.2).', flaggedCounts: { numbers: 2, total: 2 } },
    }),
  };

  test('returns a footer + counts when below threshold', () => {
    const r = gate.verify({ response: longResponse, decision: { verify: { faithfulness: true, threshold: 0.6 } }, blocks: { evidenceBlock: 'x'.repeat(50) }, deps: { postprocessor: fakeFail } });
    assert.equal(r.ran, true);
    assert.equal(r.action, 'annotate');
    assert.equal(r.grade, 'F');
    assert.match(r.footer, /Auto-fidelity check/);
    assert.equal(r.flaggedCounts.numbers, 2);
  });

  test('postprocess throwing is caught (fail-open)', () => {
    const thrower = { postprocess: () => { throw new Error('boom'); } };
    const r = gate.verify({ response: longResponse, decision: { verify: { faithfulness: true } }, blocks: { evidenceBlock: 'x'.repeat(50) }, deps: { postprocessor: thrower } });
    assert.equal(r.ran, false);
    assert.match(r.reason, /postprocess_error/);
  });
});

describe('verify — integration with the real postprocessor', () => {
  test('flags ungrounded numbers/entities against thin context', () => {
    const response = 'El informe confirma que MegaCorp captó 4821931 clientes en Marte y facturó 99999 USD según el contrato secreto. '.repeat(3);
    const r = gate.verify({
      response,
      decision: { verify: { faithfulness: true, threshold: 0.6 } },
      blocks: { evidenceBlock: 'El documento solo menciona una empresa local y ventas modestas.' },
      // no deps → uses the real faithfulness-postprocessor
    });
    assert.equal(r.ran, true);
    assert.equal(r.action, 'annotate');
    assert.ok(r.footer && r.footer.length > 0);
  });

  test('a well-grounded answer passes', () => {
    const grounded = 'El sistema soporta 3 modos y usa el archivo config.json para la configuración principal del servicio.';
    const r = gate.verify({
      response: `${grounded} ${grounded} ${grounded}`,
      decision: { verify: { faithfulness: true, threshold: 0.4 } },
      blocks: { evidenceBlock: `${grounded} Documentación: el sistema soporta 3 modos y usa config.json.` },
    });
    assert.equal(r.ran, true);
    assert.ok(['pass', 'none'].includes(r.action), `expected pass, got ${r.action}`);
  });
});
