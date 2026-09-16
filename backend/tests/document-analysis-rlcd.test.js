'use strict';

/**
 * RLCD for document analysis — flags, confidence parse, defer policy,
 * calibration metrics, preference tagging, flag-off no-op.
 */

process.env.SIRAGPT_RLHF_AUTO_TRAIN = '0';
delete process.env.SIRAGPT_RLCD_DOCUMENTS;

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

const rlcd = require('../src/services/rlcd');
const { preferenceAgent, formatDocumentRlhfBlock } = require('../src/services/document-analysis-rlhf');
const ledger = require('../src/services/agents/feedback-ledger');
const store = require('../src/services/rlhf/preference-store');

const docx = {
  name: 'tesis.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extractedText: 'Objetivo: medir X. Método: encuesta. Resultados: 12%.',
};

function enable(env = {}) {
  process.env.SIRAGPT_RLCD_DOCUMENTS = '1';
  if (env.threshold != null) process.env.SIRAGPT_RLCD_DEFER_THRESHOLD = String(env.threshold);
  else delete process.env.SIRAGPT_RLCD_DEFER_THRESHOLD;
  if (env.maxRate != null) process.env.SIRAGPT_RLCD_MAX_DEFER_RATE = String(env.maxRate);
  else delete process.env.SIRAGPT_RLCD_MAX_DEFER_RATE;
  if (env.phrase != null) process.env.SIRAGPT_RLCD_PHRASE = String(env.phrase);
  else delete process.env.SIRAGPT_RLCD_PHRASE;
}

function disable() {
  delete process.env.SIRAGPT_RLCD_DOCUMENTS;
  delete process.env.SIRAGPT_RLCD_DEFER_THRESHOLD;
  delete process.env.SIRAGPT_RLCD_MAX_DEFER_RATE;
  delete process.env.SIRAGPT_RLCD_PHRASE;
}

beforeEach(() => {
  disable();
  rlcd.reset();
  store._reset();
  ledger._reset();
});

afterEach(() => {
  disable();
  rlcd.reset();
});

describe('flags', () => {
  it('defaults off', () => {
    assert.equal(rlcd.isDocumentEnabled(), false);
    const prep = rlcd.prepareDocumentTurn({ prompt: 'analiza el documento', files: [docx], agent: 'document' });
    assert.equal(prep.applied, false);
    assert.equal(prep.reason, 'disabled');
    assert.equal(prep.block, '');
  });

  it('on only for 1/true/on', () => {
    process.env.SIRAGPT_RLCD_DOCUMENTS = '0';
    assert.equal(rlcd.isDocumentEnabled(), false);
    process.env.SIRAGPT_RLCD_DOCUMENTS = '1';
    assert.equal(rlcd.isDocumentEnabled(), true);
  });

  it('ledger and document flags are independent', () => {
    delete process.env.SIRAGPT_RLCD_ENABLED;
    delete process.env.SIRAGPT_RLCD_DOCUMENTS;
    assert.equal(rlcd.isEnabled(), true);
    assert.equal(rlcd.isDocumentEnabled(), false);
    process.env.SIRAGPT_RLCD_ENABLED = '0';
    process.env.SIRAGPT_RLCD_DOCUMENTS = '1';
    assert.equal(rlcd.isEnabled(), false);
    assert.equal(rlcd.isDocumentEnabled(), true);
    const prep = rlcd.prepareDocumentTurn({ prompt: 'analiza el documento', files: [docx], agent: 'document' });
    assert.equal(prep.applied, true);
    const lane = rlcd.decideExecutionLane({
      heuristicAgentic: false,
      codeConfidence: 0.98,
      isCodeTask: true,
      env: { SIRAGPT_RLCD_ENABLED: '0', SIRAGPT_RLCD_LANE_STEERING: '1' },
    });
    assert.equal(lane.forced, false);
    delete process.env.SIRAGPT_RLCD_ENABLED;
  });
});

describe('preference tagging', () => {
  it('preferenceAgent still tags document turns', () => {
    assert.equal(preferenceAgent({ prompt: 'hola' }), 'chat');
    assert.equal(preferenceAgent({ prompt: 'analiza el documento', files: [docx] }), 'document');
  });

  it('formatDocumentRlhfBlock unchanged when flag is off', () => {
    const block = formatDocumentRlhfBlock([{
      agent: 'document',
      request: 'resume la tesis',
      response: 'El objetivo es X',
      helpful: true,
    }]);
    assert.match(block, /DOCUMENT ANALYSIS RLHF/);
    assert.doesNotMatch(block, /CALIBRACION APRENDIDA/);
  });

  it('formatDocumentRlhfBlock adds calibrated notes when flag is on', () => {
    enable();
    const block = formatDocumentRlhfBlock([{
      agent: 'document',
      request: 'resume la tesis',
      response: 'El objetivo es X',
      helpful: true,
      judgeScore: { rlcd: { confidence: 0.82, outcome: 'correct', bin: 'high' } },
    }]);
    assert.match(block, /DOCUMENT ANALYSIS RLHF/);
    assert.match(block, /CALIBRACION APRENDIDA/);
    assert.match(block, /0\.82/);
    assert.doesNotMatch(block, /deepseek|openrouter|model_id/i);
  });
});

describe('confidence parse', () => {
  it('reads structured trailer and strips it', () => {
    enable();
    const raw = 'El objetivo es medir X.\n<!--rlcd:{"c":0.81,"r":"aparece en metodo"}-->';
    const out = rlcd.finalizeAnswer({
      text: raw,
      prompt: 'analiza el documento',
      files: [docx],
      language: 'es',
      threshold: 0.2,
    });
    assert.equal(out.score.confidence, 0.81);
    assert.equal(out.score.source, 'structured');
    assert.doesNotMatch(out.text, /<!--rlcd/);
    assert.match(out.text, /objetivo es medir X/);
    assert.equal(out.metadata.confidence, 0.81);
    assert.equal(out.deferred, false);
    assert.equal(out.reason, 'ok');
  });

  it('parses verbalized Spanish low confidence', () => {
    const score = rlcd.confidence.scoreConfidence({
      text: 'No estoy seguro: el extracto incompleto no cubre las conclusiones.',
      files: [docx],
    });
    assert.equal(score.source, 'verbalized');
    assert.ok(score.confidence < 0.45);
    assert.equal(score.bin, 'low');
  });

  it('scrubs PII from rationale', () => {
    const parsed = rlcd.confidence.parseTrailer('<!--rlcd:{"c":0.4,"r":"dato de ada@example.com"}-->');
    assert.match(parsed.rationale, /<EMAIL>/);
    assert.doesNotMatch(parsed.rationale, /ada@example.com/);
  });

  it('flag off finalize is a no-op', () => {
    const raw = 'Respuesta. <!--rlcd:{"c":0.2,"r":"x"}-->';
    const out = rlcd.finalizeAnswer({ text: raw, files: [docx] });
    assert.equal(out.reason, 'disabled');
    assert.equal(out.metadata, null);
    assert.equal(out.text, raw);
  });
});

describe('defer policy', () => {
  it('defers below threshold', () => {
    enable({ threshold: 0.6, maxRate: 1, phrase: '0' });
    const out = rlcd.finalizeAnswer({
      text: 'Afirmo que el total es 999 sin cita. <!--rlcd:{"c":0.2,"r":"no esta"}-->',
      prompt: 'cuál es el total',
      files: [docx],
      language: 'es',
    });
    assert.equal(out.deferred, true);
    assert.equal(out.reason, 'below_threshold');
    assert.match(out.text, /suficiente evidencia|sección o página/i);
  });

  it('does not defer when already honest', () => {
    enable({ threshold: 0.9, maxRate: 1 });
    const out = rlcd.finalizeAnswer({
      text: 'No tengo suficiente evidencia en el extracto para afirmar el total. <!--rlcd:{"c":0.2,"r":"falta"}-->',
      prompt: 'cuál es el total',
      files: [docx],
    });
    assert.equal(out.deferred, false);
    assert.equal(out.reason, 'already_honest');
  });

  it('caps defer rate', () => {
    enable({ threshold: 0.9, maxRate: 0 });
    const out = rlcd.finalizeAnswer({
      text: 'El total es 12. <!--rlcd:{"c":0.1,"r":"guess"}-->',
      prompt: 'total',
      files: [docx],
    });
    assert.equal(out.deferred, false);
    assert.equal(out.reason, 'rate_capped');
  });

  it('flag off never defers', () => {
    const out = rlcd.finalizeAnswer({
      text: '<!--rlcd:{"c":0.05,"r":"x"}--> invento el anexo',
      files: [docx],
    });
    assert.equal(out.deferred, false);
    assert.equal(out.reason, 'disabled');
  });
});

describe('calibration metrics', () => {
  it('updates Brier and ECE from thumbs', () => {
    enable();
    const a = rlcd.recordFromThumb({
      agent: 'document',
      helpful: true,
      response: 'Hallazgo A <!--rlcd:{"c":0.8,"r":"cita"}-->',
    });
    const b = rlcd.recordFromThumb({
      agent: 'document',
      helpful: false,
      response: 'Hallazgo B <!--rlcd:{"c":0.9,"r":"invento"}-->',
    });
    assert.equal(a.recorded, true);
    assert.equal(b.recorded, true);
    assert.equal(a.outcome, 'correct');
    assert.equal(b.outcome, 'incorrect');
    const snap = rlcd.documentStats();
    assert.equal(snap.enabled, true);
    assert.equal(snap.n, 2);
    assert.ok(typeof snap.brier === 'number');
    assert.ok(snap.brier > 0);
    assert.ok(typeof snap.ece === 'number');
    assert.equal(snap.meaning, 'calibrated_decisions');
  });

  it('regenerate marks the prior as incorrect', () => {
    enable();
    const out = rlcd.recordFromRegenerate({
      agent: 'document',
      priorResponse: 'Dato falso <!--rlcd:{"c":0.95,"r":"seguro"}-->',
    });
    assert.equal(out.recorded, true);
    assert.equal(out.outcome, 'incorrect');
    assert.equal(rlcd.documentStats().n, 1);
  });

  it('flag off thumb is a no-op', () => {
    const out = rlcd.recordFromThumb({
      agent: 'document',
      helpful: true,
      response: '<!--rlcd:{"c":0.9,"r":"x"}--> ok',
    });
    assert.equal(out.recorded, false);
    assert.equal(out.reason, 'disabled');
    assert.equal(rlcd.documentStats().n, 0);
  });

  it('ignores non-document agents', () => {
    enable();
    const out = rlcd.recordFromThumb({
      agent: 'chat',
      helpful: true,
      response: 'hola <!--rlcd:{"c":0.9,"r":"x"}-->',
    });
    assert.equal(out.recorded, false);
    assert.equal(out.reason, 'not_document');
  });
});

describe('preference ledger wiring', () => {
  it('thumbs on document answers persist judgeScore.rlcd when enabled', async () => {
    enable();
    await ledger.record({
      userId: 'u-rlcd',
      runId: 'm-rlcd-1',
      agent: 'document',
      request: 'resume la tesis',
      response: 'El objetivo es X <!--rlcd:{"c":0.77,"r":"titulo"}-->',
      helpful: true,
      metadata: { rlcd: { confidence: 0.77, bin: 'high', source: 'structured' } },
    });
    const dumped = store.dump('u-rlcd');
    assert.equal(dumped.length, 1);
    assert.equal(dumped[0].agent, 'document');
    assert.ok(dumped[0].judgeScore);
    assert.equal(dumped[0].judgeScore.rlcd.confidence, 0.77);
    assert.equal(dumped[0].judgeScore.rlcd.outcome, 'correct');
    assert.equal(rlcd.documentStats().n, 1);
  });

  it('does not tag judgeScore.rlcd when flag is off', async () => {
    await ledger.record({
      userId: 'u-off',
      runId: 'm-off-1',
      agent: 'document',
      request: 'resume',
      response: '<!--rlcd:{"c":0.2,"r":"x"}--> no',
      helpful: false,
    });
    const dumped = store.dump('u-off');
    assert.equal(dumped.length, 1);
    assert.equal(dumped[0].judgeScore, null);
    assert.equal(rlcd.documentStats().n, 0);
  });
});

describe('mergeJudgeScore', () => {
  it('keeps RLAIF scores when adding rlcd', () => {
    const merged = store.mergeJudgeScore(
      { rlcd: { confidence: 0.4, outcome: 'incorrect' } },
      { overall: 0.91, helpful: true },
    );
    assert.equal(merged.overall, 0.91);
    assert.equal(merged.rlcd.confidence, 0.4);
    assert.equal(merged.rlcd.outcome, 'incorrect');
  });
});

describe('source contracts', () => {
  it('catalogues rlcd generate events and does not use console in ai.js hooks', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const catalog = fs.readFileSync(
      path.join(__dirname, '../src/services/ai/generate-request-observability.js'),
      'utf8',
    );
    const ai = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
    for (const event of ['rlcd.prompt_applied', 'rlcd.confidence_scored', 'rlcd.deferred', 'rlcd.skipped']) {
      assert.match(catalog, new RegExp(`'${event.replace('.', '\\.')}'`));
      assert.match(ai, new RegExp(`generateLog\\.info\\('${event.replace('.', '\\.')}'`));
    }
    assert.doesNotMatch(ai, /console\.(?:log|info|warn|error)\s*\(\s*['`][^'`]*rlcd/i);
    for (const event of ['rlcd.decisions_recorded', 'rlcd.lane_decided']) {
      assert.match(catalog, new RegExp(`'${event.replace('.', '\\.')}'`));
    }
    assert.match(ai, /rlcd\.isDocumentEnabled\(\)/);
    assert.match(ai, /rlcd: \{ decisions: req\._rlcdDecisionIds\.slice\(0, 8\)/);
  });
});

describe('fail-open', () => {
  it('garbage input never throws', () => {
    enable();
    assert.doesNotThrow(() => rlcd.prepareDocumentTurn(null));
    assert.doesNotThrow(() => rlcd.finalizeAnswer(null));
    assert.doesNotThrow(() => rlcd.recordFromThumb(null));
    assert.doesNotThrow(() => rlcd.recordFromRegenerate({}));
    assert.doesNotThrow(() => rlcd.stats());
  });
});
