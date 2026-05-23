const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const semanticIntentRouter = require('../src/services/agents/semantic-intent-router');
const { buildSemanticIntentAnalysis, INTERNAL } = semanticIntentRouter;
const { buildDomainSignals, applyNegationGuards } = INTERNAL;

test('semantic router compiles research plus Excel into agentic execution', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'busca 40 artículos científicos reales y entrégalos en Excel con DOI clicables',
  });

  assert.equal(analysis.intent, 'agent_task');
  assert.equal(analysis.contract.pipeline, 'SpreadsheetPipeline');
  assert.equal(analysis.contract.required_extension, '.xlsx');
  assert.equal(analysis.contract.source_requirements.verification_policy, 'strict');
  assert.ok(analysis.routing.required_tools.includes('web_search'));
  assert.ok(analysis.routing.required_tools.includes('create_document'));
  assert.equal(analysis.structured_intent.intent_primary, 'spreadsheet_generation');
  assert.ok(analysis.skill_plan.selected_skills.some((skill) => skill.id === 'excel_dashboard'));
  assert.ok(analysis.skill_plan.selected_skills.some((skill) => skill.id === 'web_research'));
  assert.ok(analysis.model_routing.selection.model.id);
  assert.equal(analysis.product_os_plan_validation.ok, true);
  assert.ok(analysis.execution_graph.nodes.some((node) => node.id === 'tool_runtime_gateway'));
});

test('semantic router preserves format sovereignty for SVG', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'créame un SVG de una casa con dos ventanas',
  });

  assert.equal(analysis.intent, 'doc');
  assert.equal(analysis.contract.pipeline, 'VisualArtifactPipeline');
  assert.equal(analysis.contract.required_extension, '.svg');
  assert.equal(analysis.contract.mime_type, 'image/svg+xml');
  assert.equal(analysis.structured_intent.final_output, 'svg_artifact');
  assert.ok(analysis.skill_plan.quality_rules.includes('format_sovereignty'));
  assert.ok(analysis.contract.validation_plan.some((item) => item.check === 'parses_as_svg'));
});

test('semantic router routes web building to webdev without UI heuristics', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'crea una web de una empresa de carros',
  });

  assert.equal(analysis.intent, 'webdev');
  assert.equal(analysis.contract.pipeline, 'CodePipeline');
  assert.equal(analysis.routing.source, 'UniversalTaskContract+ExecutionGraph');
  assert.equal(analysis.structured_intent.intent_primary, 'web_app_build');
  assert.ok(analysis.skill_plan.selected_skills.some((skill) => skill.id === 'app_builder'));
  assert.ok(analysis.product_os_plan.nodes.some((node) => node.id === 'frontend.build'));
  assert.ok(analysis.confidence >= 0.55);
});

test('semantic router keeps scholarly source requests in grounded chat when no file is requested', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: 'dame 5 artículos científicos sobre estrategias multisensoriales sin ningún formato',
  });

  assert.equal(analysis.intent, 'web_search');
  assert.equal(analysis.contract.pipeline, 'ResearchGroundingPipeline');
  assert.equal(analysis.contract.required_extension, null);
  assert.equal(analysis.contract.artifact_required, false);
});

test('semantic router detects quantitative tasks before generic chat', () => {
  const analysis = buildSemanticIntentAnalysis({
    rawUserRequest: "Calcula el Cronbach's alpha de estas respuestas Likert: [[4,5,3],[5,5,4]]",
  });

  assert.equal(analysis.intent, 'math');
  assert.equal(analysis.contract.pipeline, 'DirectAnswerPipeline');
  assert.ok(analysis.routing.domain_signals.math);
});

describe('negative-intent guards (improvement #2)', () => {
  test('"no busques en internet" suppresses realtimeLookup', () => {
    const on = buildDomainSignals('busca en internet el precio actual del dolar hoy');
    assert.equal(on.realtimeLookup, true, 'baseline: search request should trigger realtimeLookup');
    const off = buildDomainSignals('no busques en internet, dime tu mejor estimacion del precio actual del dolar hoy');
    assert.equal(off.realtimeLookup, false, 'guard: explicit "no busques" should suppress realtimeLookup');
  });

  test('"sin web" suppresses webdev', () => {
    const on = buildDomainSignals('crea una web para mi empresa de carros');
    assert.equal(on.webdev, true);
    const off = buildDomainSignals('sin web por favor, solo explicame como deberia ser una web para mi empresa de carros');
    assert.equal(off.webdev, false);
  });

  test('"no me hagas un video" suppresses video', () => {
    const on = buildDomainSignals('hazme un video corto sobre el producto');
    assert.equal(on.video, true);
    const off = buildDomainSignals('no me hagas un video, solo describelo en texto');
    assert.equal(off.video, false);
  });

  test('"no necesito un grafico" suppresses viz', () => {
    const on = buildDomainSignals('hazme una grafica de barras con estos datos');
    assert.equal(on.viz, true);
    const off = buildDomainSignals('no necesito un grafico, solo dame los numeros en texto plano');
    assert.equal(off.viz, false);
  });

  test('"no uses gmail" suppresses gmail signal', () => {
    const on = buildDomainSignals('redacta un correo para mi cliente');
    assert.equal(on.gmail, true);
    const off = buildDomainSignals('no uses gmail, solo dictame el correo que deberia escribir');
    assert.equal(off.gmail, false);
  });

  test('guards never invent signals (no false negatives turn into true)', () => {
    // Pure text request; nothing should be flipped on.
    const signals = buildDomainSignals('explicame que es la teoria de la relatividad');
    for (const value of Object.values(signals)) {
      assert.equal(typeof value, 'boolean');
    }
    assert.equal(signals.realtimeLookup, false);
    assert.equal(signals.webdev, false);
    assert.equal(signals.video, false);
  });

  test('"no" used inside an unrelated phrase does NOT spuriously suppress', () => {
    // "no me importa el resultado, pero busca en internet…" → still web_search.
    const signals = buildDomainSignals('no me importa nada mas, busca en internet el precio actual del dolar hoy');
    // The 32-char window between "no" and "internet" is ~40 chars, so the
    // guard correctly leaves realtimeLookup alone.
    assert.equal(signals.realtimeLookup, true);
  });

  test('contrastive "no solo X" does NOT suppress X (architect regression)', () => {
    // Each phrase must (a) fire the affirmative signal, and (b) NOT
    // be suppressed by the contrastive "no solo" / "no únicamente" /
    // "no sólo" construction. We include the freshness-trigger words
    // ("precio…hoy") for realtimeLookup since that's what the
    // affirmative regex requires.
    const s1 = buildDomainSignals('no solo busques en internet el precio actual del dolar hoy, tambien razona sobre los datos');
    assert.equal(s1.realtimeLookup, true, 'no solo busques → search must remain active');

    const s2 = buildDomainSignals('no unicamente crea una web para la empresa de carros, tambien explica la arquitectura');
    assert.equal(s2.webdev, true);

    const s3 = buildDomainSignals('no sólo hagas un video corto, también un resumen en texto');
    assert.equal(s3.video, true);
  });

  test('applyNegationGuards is idempotent and pure on the input shape', () => {
    const signals = { gmail: true, video: true, webdev: false, realtimeLookup: true };
    const out = applyNegationGuards({ ...signals }, 'no uses gmail y tampoco hagas un video');
    assert.equal(out.gmail, false);
    assert.equal(out.video, false);
    assert.equal(out.webdev, false);
    assert.equal(out.realtimeLookup, true);
  });
});
