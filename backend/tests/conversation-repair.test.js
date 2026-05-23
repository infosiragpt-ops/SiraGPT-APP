'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../src/services/agents/conversation-repair');

const PREV_ASSISTANT = { role: 'assistant', text: 'Aquí va el resumen del paper sobre transformers: ' + 'X'.repeat(40) };
const PREV_USER = { role: 'user', text: 'resume el paper sobre transformers' };

// ─── classifyRepair (pure) ────────────────────────────────────────────

test('classify: "no, en español" → wrong_language', () => {
  const c = R.classifyRepair('no, en español por favor');
  assert.equal(c.repairType, 'wrong_language');
});

test('classify: "in english please" → wrong_language', () => {
  const c = R.classifyRepair('in english please');
  assert.equal(c.repairType, 'wrong_language');
});

test('classify: "en inglés" → wrong_language', () => {
  const c = R.classifyRepair('en inglés mejor');
  assert.equal(c.repairType, 'wrong_language');
});

test('classify: "mejor en Excel" → wrong_format', () => {
  const c = R.classifyRepair('mejor en Excel');
  assert.equal(c.repairType, 'wrong_format');
});

test('classify: "no, en formato Word" → wrong_format', () => {
  const c = R.classifyRepair('no, en formato Word por favor');
  assert.equal(c.repairType, 'wrong_format');
});

test('classify: "in PDF instead" → wrong_format', () => {
  const c = R.classifyRepair('in PDF instead');
  assert.equal(c.repairType, 'wrong_format');
});

test('classify: "en PDF" without negation → null (avoids false positive)', () => {
  // Sin keyword de corrección, no es repair (podría ser turno inicial).
  assert.equal(R.classifyRepair('en PDF'), null);
});

test('classify: "más corto" → wrong_scope', () => {
  const c = R.classifyRepair('hazlo más corto');
  assert.equal(c.repairType, 'wrong_scope');
});

test('classify: "más detallado" → wrong_scope', () => {
  const c = R.classifyRepair('más detallado por favor');
  assert.equal(c.repairType, 'wrong_scope');
});

test('classify: "shorter please" → wrong_scope', () => {
  const c = R.classifyRepair('shorter please');
  assert.equal(c.repairType, 'wrong_scope');
});

test('classify: "no es eso" → wrong_intent', () => {
  const c = R.classifyRepair('no es eso lo que quería');
  assert.equal(c.repairType, 'wrong_intent');
});

test('classify: "eso no era" → wrong_intent', () => {
  const c = R.classifyRepair('eso no era lo que pedí');
  assert.equal(c.repairType, 'wrong_intent');
});

test('classify: "me refería a otra cosa" → wrong_intent', () => {
  const c = R.classifyRepair('me refería a la versión inicial');
  assert.equal(c.repairType, 'wrong_intent');
});

test('classify: clean follow-up → null', () => {
  assert.equal(R.classifyRepair('puedes ampliar el segundo punto?'), null);
});

test('classify: greeting → null', () => {
  assert.equal(R.classifyRepair('hola'), null);
});

test('classify: empty → null', () => {
  assert.equal(R.classifyRepair(''), null);
  assert.equal(R.classifyRepair(null), null);
});

// ─── detectRepair (with context) ──────────────────────────────────────

test('detect: positive with prev assistant context', () => {
  const d = R.detectRepair({
    prompt: 'no, en español',
    prevTurn: PREV_ASSISTANT,
    prevUserPrompt: PREV_USER.text,
  });
  assert.equal(d.isRepair, true);
  assert.equal(d.repairType, 'wrong_language');
});

test('detect: no prev turn → not repair', () => {
  const d = R.detectRepair({
    prompt: 'no, en español',
    prevTurn: null,
  });
  assert.equal(d.isRepair, false);
  assert.equal(d.reason, 'no_significant_prev_turn');
});

test('detect: prev turn too short → not repair', () => {
  const d = R.detectRepair({
    prompt: 'no, en español',
    prevTurn: { role: 'assistant', text: 'OK' },
  });
  assert.equal(d.isRepair, false);
});

test('detect: prompt without repair pattern → not repair', () => {
  const d = R.detectRepair({
    prompt: 'cuéntame más',
    prevTurn: PREV_ASSISTANT,
  });
  assert.equal(d.isRepair, false);
});

test('detect: handles malformed prev turn gracefully', () => {
  const d = R.detectRepair({
    prompt: 'no, en español',
    prevTurn: { text: 12345 },
  });
  assert.equal(d.isRepair, false);
});

test('detect: evidence captured and truncated', () => {
  const d = R.detectRepair({
    prompt: 'no, en español por favor',
    prevTurn: PREV_ASSISTANT,
  });
  assert.ok(typeof d.evidence === 'string');
  assert.ok(d.evidence.length <= 80);
});

// ─── buildRepairContext ──────────────────────────────────────────────

test('build: null detection → empty context', () => {
  const r = R.buildRepairContext({ isRepair: false });
  assert.equal(r.systemAddendum, null);
  assert.equal(r.contractOverride, null);
});

test('build: wrong_language → addendum mentions language change', () => {
  const det = R.detectRepair({
    prompt: 'no, en español',
    prevTurn: PREV_ASSISTANT,
    prevUserPrompt: PREV_USER.text,
  });
  const r = R.buildRepairContext(det);
  assert.match(r.systemAddendum, /CONVERSATION_REPAIR/);
  assert.match(r.systemAddendum, /idioma/i);
  assert.match(r.systemAddendum, /no\s+repitas/i);
});

test('build: wrong_format → contractOverride has required_extension', () => {
  const det = R.detectRepair({
    prompt: 'mejor en Excel',
    prevTurn: PREV_ASSISTANT,
  });
  const r = R.buildRepairContext(det);
  assert.ok(r.contractOverride);
  assert.equal(r.contractOverride.required_extension, '.xlsx');
});

test('build: wrong_format Word → .docx override', () => {
  const det = R.detectRepair({
    prompt: 'no, en formato Word por favor',
    prevTurn: PREV_ASSISTANT,
  });
  const r = R.buildRepairContext(det);
  assert.equal(r.contractOverride.required_extension, '.docx');
});

test('build: wrong_format PDF → .pdf override', () => {
  const det = R.detectRepair({
    prompt: 'mejor en PDF',
    prevTurn: PREV_ASSISTANT,
  });
  const r = R.buildRepairContext(det);
  assert.equal(r.contractOverride.required_extension, '.pdf');
});

test('build: wrong_scope → no contractOverride', () => {
  const det = R.detectRepair({
    prompt: 'más corto',
    prevTurn: PREV_ASSISTANT,
  });
  const r = R.buildRepairContext(det);
  assert.equal(r.contractOverride, null);
  assert.match(r.systemAddendum, /scope/i);
});

test('build: wrong_intent → addendum suggests alternatives', () => {
  const det = R.detectRepair({
    prompt: 'no, eso no era',
    prevTurn: PREV_ASSISTANT,
    prevUserPrompt: 'hazme un gráfico',
  });
  const r = R.buildRepairContext(det);
  assert.match(r.systemAddendum, /alternativas|reinterpreta/i);
});

test('build: prev user prompt snippet included', () => {
  const det = R.detectRepair({
    prompt: 'no, en español',
    prevTurn: PREV_ASSISTANT,
    prevUserPrompt: 'summarize this paper',
  });
  const r = R.buildRepairContext(det);
  assert.match(r.systemAddendum, /summarize this paper/);
});

// ─── extractExtensionFromEvidence ─────────────────────────────────────

test('ext: word → .docx', () => {
  assert.equal(R.extractExtensionFromEvidence('en formato Word'), '.docx');
});

test('ext: excel → .xlsx', () => {
  assert.equal(R.extractExtensionFromEvidence('mejor en Excel'), '.xlsx');
});

test('ext: powerpoint → .pptx', () => {
  assert.equal(R.extractExtensionFromEvidence('en PowerPoint'), '.pptx');
});

test('ext: unknown → null', () => {
  assert.equal(R.extractExtensionFromEvidence('en algo random'), null);
});

test('ext: empty → null', () => {
  assert.equal(R.extractExtensionFromEvidence(''), null);
  assert.equal(R.extractExtensionFromEvidence(null), null);
});
