'use strict';

/**
 * learned-preferences — the platform learns each user's preferences from
 * their own corrections and applies them on later turns.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lp = require('../src/services/learned-preferences');
const { detectRepair } = require('../src/services/agents/conversation-repair');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const prevTurn = { role: 'assistant', text: 'Aquí tienes un análisis extenso de cuatro páginas sobre el tema solicitado…' };

test('repairs map to concrete traits; vague rejections teach nothing', () => {
  const t = (prompt) => lp.traitsFromRepair(detectRepair({ prompt, prevTurn }));
  assert.deepEqual(t('más corto por favor'), ['length:shorter']);
  assert.deepEqual(t('hazlo más detallado'), ['detail:more']);
  assert.deepEqual(t('más formal'), ['tone:formal']);
  assert.deepEqual(t('más simple'), ['register:simple']);
  assert.deepEqual(t('en inglés'), ['language:en']);
  assert.deepEqual(t('no, mejor en excel'), ['format:xlsx']);
  assert.deepEqual(t('eso no es lo que quería'), []);
  assert.deepEqual(lp.traitsFromRepair({ isRepair: false }), []);
  assert.deepEqual(lp.traitsFromRepair(null), []);
});

test('👎 reason codes map to traits; directionless codes are ignored', () => {
  assert.equal(lp.traitFromReason('too_long'), 'length:shorter');
  assert.equal(lp.traitFromReason('too_short'), 'length:longer');
  assert.equal(lp.traitFromReason('invented'), 'grounding:strict');
  assert.equal(lp.traitFromReason('bad_math'), 'math:verify');
  assert.equal(lp.traitFromReason('incomplete'), 'scope:complete');
  assert.equal(lp.traitFromReason('off_topic'), 'scope:focused');
  assert.equal(lp.traitFromReason('wrong_tone'), null);
  assert.equal(lp.traitFromReason('other'), null);
  assert.equal(lp.traitFromReason(undefined), null);
});

test('one correction fixes that answer only; repeated corrections become a preference', () => {
  let prefs = lp.applySignal(null, 'length:shorter', { now: T0 });
  assert.equal(lp.buildLearnedPreferencesBlock(prefs, { now: T0 }), '', 'a single «más corto» is not a profile');
  prefs = lp.applySignal(prefs, 'length:shorter', { now: T0 + DAY });
  const block = lp.buildLearnedPreferencesBlock(prefs, { now: T0 + DAY });
  assert.match(block, /^## PREFERENCIAS APRENDIDAS DE ESTE USUARIO/);
  assert.match(block, /más cortas y directas/);
  assert.match(block, /si el pedido actual pide otra cosa, manda el pedido actual/);
});

test('quality flags activate on the first explicit report', () => {
  const prefs = lp.applySignal(null, 'grounding:strict', { now: T0, source: 'dislike' });
  assert.match(lp.buildLearnedPreferencesBlock(prefs, { now: T0 }), /datos inventados/);
});

test('opposite directions cancel and a new language replaces the old one', () => {
  let prefs = lp.applySignal(null, 'length:shorter', { now: T0 });
  prefs = lp.applySignal(prefs, 'length:shorter', { now: T0 });
  prefs = lp.applySignal(prefs, 'length:longer', { now: T0 + DAY });
  const keys = lp.activeTraits(prefs, { now: T0 + DAY }).map((t) => t.key);
  assert.ok(!keys.includes('length:shorter'), 'the later «más largo» weakened «más corto»');

  let lang = lp.applySignal(null, 'language:en', { now: T0 });
  lang = lp.applySignal(lang, 'language:en', { now: T0 });
  lang = lp.applySignal(lang, 'language:fr', { now: T0 + DAY });
  lang = lp.applySignal(lang, 'language:fr', { now: T0 + DAY });
  const active = lp.activeTraits(lang, { now: T0 + DAY }).map((t) => t.key);
  assert.deepEqual(active, ['language:fr']);
});

test('preferences decay: months-old corrections stop steering', () => {
  let prefs = lp.applySignal(null, 'tone:formal', { now: T0 });
  prefs = lp.applySignal(prefs, 'tone:formal', { now: T0 });
  assert.equal(lp.activeTraits(prefs, { now: T0 }).length, 1);
  assert.equal(lp.activeTraits(prefs, { now: T0 + 90 * DAY }).length, 0);
});

test('applySignal is pure, ignores unknown traits and caps the store', () => {
  const before = lp.applySignal(null, 'detail:more', { now: T0 });
  const frozen = JSON.stringify(before);
  lp.applySignal(before, 'detail:more', { now: T0 });
  assert.equal(JSON.stringify(before), frozen);
  assert.equal(lp.applySignal(before, 'nonsense:x', { now: T0 }), before);
  let many = null;
  for (const code of ['es', 'en', 'pt', 'fr', 'de', 'it', 'zh', 'ja']) many = lp.applySignal(many, `language:${code}`, { now: T0 });
  assert.equal(Object.keys(many.traits).filter((k) => k.startsWith('language:')).length, 1);
});

test('recordSignals persists into User.settings without clobbering other settings; never throws', async () => {
  const store = { settings: { inferred: { domain: 'software' }, theme: 'dark' } };
  const prisma = {
    user: {
      findUnique: async () => ({ settings: store.settings }),
      update: async ({ data }) => { store.settings = data.settings; return {}; },
    },
  };
  await lp.recordSignals({ prisma, userId: 'u1', traits: ['length:shorter'], now: T0 });
  const saved = await lp.recordSignals({ prisma, userId: 'u1', traits: ['length:shorter'], now: T0 + DAY });
  assert.equal(store.settings.theme, 'dark');
  assert.deepEqual(store.settings.inferred, { domain: 'software' });
  assert.equal(store.settings.learnedPreferences.traits['length:shorter'].count, 2);
  assert.ok(saved);
  assert.match(lp.buildLearnedPreferencesBlock(lp.loadLearnedPreferences(store), { now: T0 + DAY }), /más cortas/);

  const broken = { user: { findUnique: async () => { throw new Error('db down'); } } };
  assert.equal(await lp.recordSignals({ prisma: broken, userId: 'u1', traits: ['length:shorter'] }), null);
  assert.equal(await lp.recordSignals({ prisma, userId: 'u1', traits: ['nonsense:x'] }), null);
  assert.equal(lp.loadLearnedPreferences({ settings: null }), null);
});

test('wiring: /generate injects and records, 👎 reasons record, the agentic loop receives the user context', () => {
  const root = path.join(__dirname, '..', 'src');
  const ai = fs.readFileSync(path.join(root, 'routes/ai.js'), 'utf8');
  assert.match(ai, /buildLearnedPreferencesBlock\(__learned\.loadLearnedPreferences\(_userPrefetch\)\)/);
  assert.match(ai, /__learned\.traitsFromRepair\(__repairDet\)/);
  assert.match(ai, /userContextBlock: \(Array\.isArray\(promptBundle\?\.systemBlocks\)/);
  const chats = fs.readFileSync(path.join(root, 'routes/chats.js'), 'utf8');
  assert.match(chats, /learned\.traitFromReason\(reasons\.reasonCode\)/);
  const stream = fs.readFileSync(path.join(root, 'services/agentic-chat-stream.js'), 'utf8');
  assert.match(stream, /userContextBlock = '',/);
  assert.match(stream, /=== CONTEXTO DEL USUARIO/);
  assert.doesNotMatch(stream, /Responde SIEMPRE en español, con tono profesional y cercano\. No uses emojis\./);
});
