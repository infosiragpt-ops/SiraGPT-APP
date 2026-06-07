'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const orch = require('../src/services/reasoning-orchestrator');

// A tiny deterministic fake catalog so routing tests don't depend on the real
// (aspirational) model catalog and stay stable over time.
const fakeCatalog = (() => {
  const CATALOG = {
    'cheap-mini': { id: 'cheap-mini', provider: 'openai', plans: ['FREE', 'PRO', 'ENTERPRISE'], cost_tier: 'low', latency_tier: 'fast', languages: ['es', 'en'], capabilities: { reasoning: 0.6, code: 0.6, tools: 0.7, vision: 0.7, long_context: 0.6 } },
    'mid-pro': { id: 'mid-pro', provider: 'openai', plans: ['FREE', 'PRO', 'ENTERPRISE'], cost_tier: 'medium', latency_tier: 'fast', languages: ['es', 'en'], capabilities: { reasoning: 0.84, code: 0.86, tools: 0.88, vision: 0.92, long_context: 0.78 } },
    'top-reasoner': { id: 'top-reasoner', provider: 'openrouter', plans: ['PRO', 'ENTERPRISE'], cost_tier: 'high', latency_tier: 'normal', languages: ['es', 'en'], capabilities: { reasoning: 0.97, code: 0.95, tools: 0.95, vision: 0.94, long_context: 0.92 } },
    'top-reasoner-free': { id: 'top-reasoner-free', provider: 'openrouter', plans: ['FREE', 'PRO', 'ENTERPRISE'], cost_tier: 'high', latency_tier: 'normal', languages: ['es', 'en'], capabilities: { reasoning: 0.96, code: 0.92, tools: 0.9, vision: 0.9, long_context: 0.92 } },
  };
  const PLAN_RANK = { FREE: 0, PRO: 1, PRO_MAX: 2, ENTERPRISE: 3 };
  function isPlanEligible(plans = [], plan = 'FREE') {
    const ur = PLAN_RANK[String(plan).toUpperCase()];
    if (ur == null) return false;
    const ranks = plans.map((p) => PLAN_RANK[String(p).toUpperCase()]).filter((x) => x != null);
    if (ranks.includes(ur)) return true;
    if (!ranks.length) return false;
    return ur >= Math.min(...ranks);
  }
  function getModel(id) { return CATALOG[id] ? { ...CATALOG[id] } : null; }
  function select(req = {}) {
    // Pick highest reasoning among plan-eligible; bias to cheaper for low complexity.
    const eligible = Object.values(CATALOG).filter((m) => isPlanEligible(m.plans, req.user_plan));
    if (!eligible.length) return { model: null, score: 0, alternatives: [], rationale: 'none' };
    const wantStrong = req.requires_reasoning || req.complexity === 'high';
    const scored = eligible.map((m) => ({
      model: m,
      score: (wantStrong ? m.capabilities.reasoning * 100 : (1 - m.capabilities.reasoning) * 10 + (m.cost_tier === 'low' ? 20 : 0)),
    })).sort((a, b) => b.score - a.score);
    return {
      model: scored[0].model,
      score: Math.round(scored[0].score * 10) / 10,
      alternatives: scored.slice(1, 3).map((s) => ({ id: s.model.id, score: s.score })),
      rationale: `picked ${scored[0].model.id}`,
    };
  }
  return { select, getModel, isPlanEligible };
})();

const deps = { catalogRouter: fakeCatalog };

describe('assessDifficulty', () => {
  test('trivial greeting → trivial bucket', () => {
    const d = orch.assessDifficulty({ prompt: 'hola' });
    assert.equal(d.bucket, 'trivial');
    assert.ok(d.score <= 0.15);
  });

  test('long analytical prompt → moderate/complex', () => {
    const prompt = 'Analiza detalladamente y compara paso a paso las arquitecturas de microservicios frente a monolitos, '.repeat(20);
    const d = orch.assessDifficulty({ prompt, contextSize: 40000 });
    assert.ok(['moderate', 'complex'].includes(d.bucket), `got ${d.bucket}`);
    assert.ok(d.score > 0.35);
  });

  test('code prompt sets hasCode', () => {
    const d = orch.assessDifficulty({ prompt: 'refactor this:\n```js\nfunction f(){ return 1 }\n```' });
    assert.equal(d.hasCode, true);
  });

  test('SEMANTIC FLOOR: short "tesis de 30 páginas" prompt is complex, not trivial', () => {
    const d = orch.assessDifficulty({ prompt: 'escribe una tesis de 30 páginas sobre IA en educación' });
    assert.equal(d.bucket, 'complex');
    assert.equal(d.lengthBucket, 'trivial'); // length said trivial; semantics overrode
    assert.ok(d.score >= 0.7);
  });

  test('SEMANTIC FLOOR: intent_primary lifts difficulty even for short prompts', () => {
    const d = orch.assessDifficulty({
      prompt: 'hazlo',
      semanticIntent: { structured_intent: { intent_primary: 'web_app_build' } },
    });
    assert.equal(d.bucket, 'complex');
  });

  test('SEMANTIC FLOOR: math phrasing reaches at least moderate', () => {
    const d = orch.assessDifficulty({ prompt: 'demuestra que √2 es irracional' });
    assert.ok(['moderate', 'complex'].includes(d.bucket));
  });

  test('SEMANTIC FLOOR: does not lift genuine small talk', () => {
    const d = orch.assessDifficulty({ prompt: 'hola, ¿qué tal tu día?' });
    assert.equal(d.bucket, 'trivial');
  });
});

describe('assessRisk', () => {
  test('detects legal as high risk', () => {
    const r = orch.assessRisk('revisa esta cláusula de un contrato y la responsabilidad legal');
    assert.ok(r.domains.includes('legal'));
    assert.equal(r.level, 'high');
  });

  test('detects medical as high risk', () => {
    const r = orch.assessRisk('what is the right dosage of this drug for a patient with these symptoms');
    assert.ok(r.domains.includes('medical'));
    assert.equal(r.level, 'high');
  });

  test('academic is medium risk', () => {
    const r = orch.assessRisk('escribe la metodología y la hipótesis de mi tesis con bibliografía');
    assert.ok(r.domains.includes('academic'));
    assert.equal(r.level, 'medium');
  });

  test('plain chit-chat is low risk', () => {
    const r = orch.assessRisk('cuéntame un chiste corto');
    assert.equal(r.level, 'low');
    assert.deepEqual(r.domains, []);
  });

  test('intent can raise low to medium', () => {
    const r = orch.assessRisk('hazme el documento', 'complex_academic_document_generation');
    assert.equal(r.level, 'medium');
  });
});

describe('routeModel — modes', () => {
  test('off mode never changes the model but still recommends', () => {
    const r = orch.routeModel({
      prompt: 'analiza profundamente y demuestra el teorema',
      userModel: 'cheap-mini', userProvider: 'OpenAI', plan: 'PRO', routingMode: 'off',
    }, deps);
    assert.equal(r.mode, 'off');
    assert.equal(r.changed, false);
    assert.equal(r.shouldApply, false);
    assert.equal(r.selectedModel, 'cheap-mini');
    assert.ok(r.recommendedModel, 'still computes a recommendation for telemetry');
  });

  test('escalate mode bumps a weak model on a hard task', () => {
    const hard = 'Analiza detalladamente, compara paso a paso y demuestra formalmente '.repeat(20);
    const r = orch.routeModel({
      prompt: hard, contextSize: 50000,
      userModel: 'cheap-mini', userProvider: 'OpenAI', plan: 'PRO', routingMode: 'escalate',
    }, deps);
    assert.equal(r.action, 'escalate');
    assert.equal(r.changed, true);
    assert.equal(r.shouldApply, true);
    assert.equal(r.selectedModel, 'top-reasoner');
  });

  test('escalate mode keeps the model on trivial small talk', () => {
    const r = orch.routeModel({
      prompt: 'hola, ¿qué tal?',
      userModel: 'cheap-mini', userProvider: 'OpenAI', plan: 'PRO', routingMode: 'escalate',
    }, deps);
    assert.equal(r.action, 'keep');
    assert.equal(r.changed, false);
    assert.equal(r.shouldApply, false);
  });

  test('escalate never downgrades a strong model', () => {
    const r = orch.routeModel({
      prompt: 'hola',
      userModel: 'top-reasoner', userProvider: 'OpenRouter', plan: 'PRO', routingMode: 'escalate',
    }, deps);
    assert.equal(r.selectedModel, 'top-reasoner');
    assert.equal(r.changed, false);
  });

  test('escalate respects plan eligibility (FREE cannot reach PRO-only model)', () => {
    const hard = 'Analiza detalladamente, compara paso a paso y demuestra formalmente '.repeat(20);
    const r = orch.routeModel({
      prompt: hard, contextSize: 50000,
      userModel: 'cheap-mini', userProvider: 'OpenAI', plan: 'FREE', routingMode: 'escalate',
    }, deps);
    // top-reasoner is PRO-only; the FREE-eligible strong model should win instead.
    assert.notEqual(r.selectedModel, 'top-reasoner');
    if (r.changed) assert.equal(r.selectedModel, 'top-reasoner-free');
  });

  test('auto sentinel forces full auto selection', () => {
    const r = orch.routeModel({
      prompt: 'analiza y demuestra el teorema con todo detalle',
      userModel: 'auto', userProvider: null, plan: 'PRO',
    }, deps);
    assert.equal(r.mode, 'auto');
    assert.ok(['auto_select', 'keep'].includes(r.action));
    assert.ok(r.selectedModel);
    assert.notEqual(r.selectedModel, 'auto');
  });

  test('escalates an unknown mini model on a high-risk task', () => {
    const r = orch.routeModel({
      prompt: 'dame el dosage correcto del fármaco para este paciente con estos síntomas',
      userModel: 'some-mini-model', userProvider: 'OpenAI', plan: 'PRO', routingMode: 'escalate',
    }, deps);
    // unknown user model + high risk → should escalate to a capable catalog model
    assert.equal(r.action, 'escalate');
    assert.equal(r.changed, true);
  });

  test('catalog unavailable → safe keep', () => {
    const r = orch.routeModel({ prompt: 'hola', userModel: 'x', plan: 'PRO', routingMode: 'escalate' }, { catalogRouter: null });
    assert.equal(r.selectedModel, 'x');
    assert.equal(r.shouldApply, false);
    assert.equal(r.reason, 'catalog_unavailable');
  });
});

describe('planCompute', () => {
  test('trivial → direct single pass', () => {
    const c = orch.planCompute({ difficulty: { bucket: 'trivial' }, risk: { level: 'low' }, prompt: 'hola' });
    assert.equal(c.mode, 'direct');
    assert.equal(c.samples, 1);
    assert.equal(c.reflection, false);
  });

  test('complex → extended + reflection', () => {
    const c = orch.planCompute({ difficulty: { bucket: 'complex', hasComplexity: true }, risk: { level: 'low' }, prompt: 'diseña una arquitectura distribuida' });
    assert.ok(['extended', 'best_of_n', 'self_consistency'].includes(c.mode));
    assert.equal(c.reflection, true);
    assert.equal(c.reasoningEffort, 'high');
  });

  test('math at difficulty → self_consistency with samples', () => {
    const c = orch.planCompute({ difficulty: { bucket: 'complex' }, risk: { level: 'low' }, intent: 'math', prompt: 'resuelve y demuestra la ecuación' });
    assert.equal(c.mode, 'self_consistency');
    assert.ok(c.samples >= 3);
  });

  test('high-risk complex document → best_of_n', () => {
    const c = orch.planCompute({ difficulty: { bucket: 'complex' }, risk: { level: 'high' }, intent: 'complex_academic_document_generation', prompt: 'redacta el informe legal' });
    assert.equal(c.mode, 'best_of_n');
    assert.ok(c.samples >= 2);
  });
});

describe('planVerification', () => {
  test('grounded non-trivial → faithfulness on', () => {
    const v = orch.planVerification({ difficulty: { bucket: 'moderate' }, risk: { level: 'low' }, hasGrounding: true });
    assert.equal(v.faithfulness, true);
  });

  test('ungrounded trivial → no checks', () => {
    const v = orch.planVerification({ difficulty: { bucket: 'trivial' }, risk: { level: 'low' }, hasGrounding: false });
    assert.equal(v.faithfulness, false);
    assert.equal(v.reflection, false);
  });

  test('high-risk forces faithfulness even without grounding + stricter threshold', () => {
    const v = orch.planVerification({ difficulty: { bucket: 'simple' }, risk: { level: 'high' }, hasGrounding: false });
    assert.equal(v.faithfulness, true);
    assert.ok(v.threshold >= 0.6);
  });
});

describe('decide — orchestration', () => {
  test('end-to-end complex legal turn produces a coherent decision', () => {
    const hard = 'Analiza en detalle las cláusulas de responsabilidad legal de este contrato y compáralas paso a paso. '.repeat(15);
    const d = orch.decide({
      prompt: hard, userModel: 'cheap-mini', userProvider: 'OpenAI', plan: 'PRO',
      contextSize: 40000, hasGrounding: true, routingMode: 'escalate',
    }, deps);
    assert.equal(d.ok, true);
    assert.equal(d.risk.level, 'high');
    assert.ok(['moderate', 'complex'].includes(d.difficulty.bucket));
    assert.equal(d.verify.faithfulness, true);
    assert.ok(d.routing.recommendedModel);
    assert.equal(typeof d.telemetry.diff, 'string');
  });

  test('trivial turn keeps everything cheap and direct', () => {
    const d = orch.decide({ prompt: 'gracias!', userModel: 'cheap-mini', plan: 'FREE', routingMode: 'escalate' }, deps);
    assert.equal(d.difficulty.bucket, 'trivial');
    assert.equal(d.routing.changed, false);
    assert.equal(d.compute.mode, 'direct');
    assert.equal(d.verify.faithfulness, false);
  });

  test('summarizeForLog returns a single line', () => {
    const d = orch.decide({ prompt: 'hola', userModel: 'cheap-mini', plan: 'FREE' }, deps);
    const line = orch.summarizeForLog(d);
    assert.match(line, /^\[reasoning-orchestrator\]/);
    assert.ok(!line.includes('\n'));
  });

  test('decide never throws on garbage input (fail-open)', () => {
    const d = orch.decide({ prompt: null, userModel: undefined, attachments: 'not-an-array' }, deps);
    assert.equal(typeof d.ok, 'boolean');
    assert.ok(d.routing);
    assert.equal(d.routing.shouldApply, false);
  });

  test('reads SIRAGPT_AUTO_ROUTING from env when no explicit mode', () => {
    const prev = process.env.SIRAGPT_AUTO_ROUTING;
    process.env.SIRAGPT_AUTO_ROUTING = 'escalate';
    try {
      const hard = 'Analiza detalladamente, compara paso a paso y demuestra formalmente '.repeat(20);
      const d = orch.decide({ prompt: hard, contextSize: 50000, userModel: 'cheap-mini', plan: 'PRO' }, deps);
      assert.equal(d.routing.mode, 'escalate');
    } finally {
      if (prev === undefined) delete process.env.SIRAGPT_AUTO_ROUTING;
      else process.env.SIRAGPT_AUTO_ROUTING = prev;
    }
  });
});
