'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const sel = require('../src/services/agents/tool-selector');

// A representative tool list (names mirror the real registry categories).
const BASE = [
  'web_search', 'read_url', 'web_extract', 'deep_search', 'github_search', 'scientific_search', 'x_search', 'sunat_peru',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_scroll',
  'rag_retrieve', 'search_docs', 'read_file', 'list_files', 'search_code', 'get_symbol', 'docintel_analyze', 'deep_analyze',
  'python_exec', 'host_bash', 'host_file', 'list_dir', 'glob_files', 'code_grep', 'clone_project', 'run_tests', 'propose_patch', 'static_checks', 'check_ci', 'monitor_ci',
  'create_document', 'verify_artifact', 'memory_recall', 'session_search', 'session_list',
].map((name) => ({ name, schema: {}, handler: () => {} }));

const MEDIA = [
  'generate_image', 'create_chart', 'create_organigram', 'create_mermaid_diagram', 'create_infographic_svg',
  'create_dashboard_html', 'generate_video', 'create_comparison_table', 'create_process_flow', 'create_timeline',
  'create_kanban_board', 'create_swot_analysis', 'create_radar_chart', 'create_pyramid_diagram', 'generate_audio',
].map((name) => ({ name, schema: {}, handler: () => {} }));

const ALL = [...BASE, ...MEDIA];
const deps = { skillAdapter: null }; // deterministic: don't depend on the live skill registry
const names = (r) => r.selectedNames;

describe('selectTools — narrows by intent', () => {
  test('research intent keeps web/research/rag, drops media + host-code, capped', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: 'busca artículos científicos sobre IA y compáralos', intent: 'research_question', signals: { needsResearch: true } }, deps);
    assert.equal(r.applied, true);
    assert.ok(r.keptCount <= sel.DEFAULT_MAX_TOOLS);
    assert.ok(names(r).includes('web_search'));
    assert.ok(names(r).includes('scientific_search'));
    assert.ok(!names(r).includes('create_swot_analysis'));
    assert.ok(!names(r).includes('host_bash'));
  });

  test('code intent keeps code/rag, drops media + research', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: 'arregla el bug en este repo y corre los tests', intent: 'code_generation', signals: { hasCode: true } }, deps);
    assert.equal(r.applied, true);
    assert.ok(names(r).includes('run_tests') || names(r).includes('python_exec'));
    assert.ok(!names(r).includes('generate_video'));
    assert.ok(!names(r).includes('scientific_search'));
  });

  test('media intent keeps media + generation core', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: 'hazme un gráfico de barras y una imagen', intent: 'data_analysis', signals: { hasMedia: true } }, deps);
    assert.equal(r.applied, true);
    assert.ok(names(r).includes('create_chart') || names(r).includes('generate_image'));
  });

  test('core tools are always present', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: 'resume esto', intent: 'summarization', signals: { hasFiles: true } }, deps);
    for (const core of sel.CORE_TOOLS) {
      if (ALL.some((t) => t.name === core)) assert.ok(names(r).includes(core), `missing core ${core}`);
    }
    // hasFiles → rag tools retained
    assert.ok(names(r).includes('rag_retrieve') || names(r).includes('docintel_analyze'));
  });
});

describe('selectTools — safe fallbacks (never strand the agent)', () => {
  test('broad agent_task intent → keep ALL', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: 'haz todo lo necesario', intent: 'agent_task' }, deps);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'broad_intent');
    assert.equal(r.keptCount, ALL.length);
  });

  test('unknown intent → keep ALL', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: 'algo', intent: null }, deps);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'unknown_intent');
  });

  test('already-small tool set → no change', () => {
    const small = BASE.slice(0, 10);
    const r = sel.selectTools({ tools: small, userQuery: 'x', intent: 'research_question' }, deps);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'already_small');
  });

  test('respects maxTools', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: 'investiga', intent: 'research_question', maxTools: 10 }, deps);
    assert.ok(r.keptCount <= 10);
  });

  test('guarantees a minimum floor even with flat scores', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: '', intent: 'text_answer' }, deps);
    // text_answer has no category weights, but the floor keeps >= MIN
    assert.ok(r.keptCount >= 8 || !r.applied);
  });

  test('decision object provides the intent', () => {
    const r = sel.selectTools({ tools: ALL, userQuery: 'busca', decision: { intent: 'web_search' }, signals: { needsResearch: true } }, deps);
    assert.equal(r.applied, true);
    assert.ok(names(r).includes('web_search'));
  });

  test('garbage input never throws', () => {
    assert.doesNotThrow(() => sel.selectTools(null, deps));
    assert.doesNotThrow(() => sel.selectTools({ tools: 'nope' }, deps));
  });
});

describe('scoreTool / categoriesFor', () => {
  test('categoriesFor classifies tool names', () => {
    assert.deepEqual(sel.categoriesFor('scientific_search'), ['research']);
    assert.ok(sel.categoriesFor('rag_retrieve').includes('rag'));
    assert.ok(sel.categoriesFor('create_chart').includes('media'));
  });
});
