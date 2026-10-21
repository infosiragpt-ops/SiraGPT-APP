'use strict';

/**
 * Fixes from the professional review of the understanding work (#1050/#1051):
 *  - triage: only a BARE request may escalate on the token score (it is 0.85
 *    for any prompt under 3 tokens, so greetings and short questions were
 *    answered with a clarifying question);
 *  - learned preferences learn only from real corrections of the previous
 *    answer, quality flags activate on one report, a 👎 counts once, the write
 *    touches only its own settings key, and server-owned keys never
 *    round-trip through the client's settings.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSemanticIntentAnalysis } = require('../src/services/agents/semantic-intent-router');
const { triageIntent, _internal: triageInternal } = require('../src/services/agents/intent-triage');
const learned = require('../src/services/learned-preferences');
const { detectRepair } = require('../src/services/agents/conversation-repair');
const { INTERNAL: usersInternal } = require('../src/routes/users');

async function triage(prompt, recentTurns = []) {
  const analysis = buildSemanticIntentAnalysis({ rawUserRequest: prompt, files: [] });
  return triageIntent({ analysis, prompt, recentTurns });
}

test('greetings and short questions on a fresh chat are answered, not questioned', async () => {
  for (const prompt of ['hola Sira', 'buen día', 'good morning', 'thank you', 'de nada', 'yes',
    '¿quién eres?', 'explícame recursión', 'define entropía', '2+2', 'fotosíntesis', 'git rebase']) {
    const decision = await triage(prompt);
    assert.equal(decision.action, 'execute', `${prompt} → ${decision.reason}`);
  }
});

test('bare requests with nothing to work on still get one clarifying question', async () => {
  for (const prompt of ['excel', 'hazme uno', 'un plan', 'dame ideas', 'informe', 'prepáralo', '?', '123', 'NULL']) {
    const decision = await triage(prompt);
    assert.equal(decision.action, 'ask', `${prompt} → ${decision.reason}`);
  }
  const { isBareRequest } = triageInternal;
  assert.equal(isBareRequest('una presentación'), true);
  assert.equal(isBareRequest('una presentación sobre energía solar'), false, 'a topic makes it concrete');
  assert.equal(isBareRequest('15*3'), false, 'a computation is not empty input');
  assert.equal(isBareRequest('...'), true);
});

const previousSpanish = 'Claro, aquí tienes el resumen de la reunión con los puntos que se acordaron y las tareas pendientes para el equipo.';
const previousEnglish = 'Sure, here is the summary of the meeting with the points that were agreed and the pending tasks for the team.';
const learnable = (prompt, previousAnswer = previousSpanish) => learned.isLearnableCorrection({
  prompt,
  detection: detectRepair({ prompt, prevTurn: { text: previousAnswer } }),
  previousAnswer,
});

test('requests that merely mention a language, a length or a format do not teach the profile', () => {
  for (const prompt of [
    '¿Cómo se dice gracias en inglés?',
    'escríbeme un correo en inglés para mi jefe sobre la reunión de mañana',
    '¿Cuál es el río más largo del mundo?',
    'Which is longer, the Nile or the Amazon?',
    'how do I parse dates in JSON?',
    '¿qué lenguaje es más simple para empezar?',
    'traduce esto al inglés',
  ]) {
    assert.equal(learnable(prompt), false, prompt);
  }
});

test('short corrections of the previous answer do teach it', () => {
  for (const prompt of ['no, en inglés', 'en inglés por favor', 'más corto', 'hazlo más corto por favor', 'más formal', 'shorter please', 'mejor en PDF']) {
    assert.equal(learnable(prompt), true, prompt);
  }
  // Asking for the language the answer was already in is not a correction.
  assert.equal(learnable('en inglés por favor', previousEnglish), false);
  assert.equal(learnable('en español por favor', previousEnglish), true);
  assert.equal(learned.guessLanguage(previousSpanish), 'es');
  assert.equal(learned.guessLanguage(previousEnglish), 'en');
  assert.equal(learned.guessLanguage('ok'), null);
});

test('a quality flag from one explicit report is active for a half-life, not one millisecond', () => {
  const now = Date.parse('2026-10-21T00:00:00Z');
  const prefs = learned.applySignal(null, 'grounding:strict', { now, source: 'dislike' });
  const keys = (at) => learned.activeTraits(prefs, { now: at }).map((t) => t.key);
  assert.deepEqual(keys(now + 1000), ['grounding:strict'], 'still active a second later');
  assert.deepEqual(keys(now + 29 * 24 * 3600 * 1000), ['grounding:strict']);
  assert.deepEqual(keys(now + 31 * 24 * 3600 * 1000), [], 'fades after one half-life');
});

function fakePrisma(settings) {
  const state = { settings: settings ?? null, raw: [], updates: 0 };
  return {
    state,
    user: {
      async findUnique() { return { settings: state.settings }; },
      async update({ data }) { state.updates += 1; state.settings = data.settings; return {}; },
    },
    async $executeRaw(strings, ...values) {
      state.raw.push({ sql: strings.join('?'), values });
      const prefs = JSON.parse(values[0]);
      state.settings = { ...(state.settings && typeof state.settings === 'object' ? state.settings : {}), learnedPreferences: prefs };
      return 1;
    },
  };
}

test('a 👎 is counted once per message, even if re-submitted with another reason', async () => {
  const prisma = fakePrisma({ theme: 'dark' });
  const first = await learned.recordSignals({ prisma, userId: 'u1', traits: ['length:shorter'], source: 'dislike', dedupeKey: 'msg-1' });
  assert.equal(first.traits['length:shorter'].count, 1);
  const again = await learned.recordSignals({ prisma, userId: 'u1', traits: ['scope:complete'], source: 'dislike', dedupeKey: 'msg-1' });
  assert.equal(again.traits['scope:complete'], undefined, 'the same message never adds weight again');
  assert.equal(prisma.state.raw.length, 1);
  const other = await learned.recordSignals({ prisma, userId: 'u1', traits: ['length:shorter'], source: 'dislike', dedupeKey: 'msg-2' });
  assert.equal(other.traits['length:shorter'].count, 2);
  assert.deepEqual(other.seen, ['msg-1', 'msg-2']);
});

test('the write changes only the learnedPreferences key (atomic jsonb_set), never the rest of the settings', async () => {
  const prisma = fakePrisma({ theme: 'dark', customInstructions: 'Sé breve.' });
  await learned.recordSignals({ prisma, userId: 'u1', traits: ['tone:formal'] });
  assert.equal(prisma.state.updates, 0, 'no read-modify-write of the whole settings object');
  assert.equal(prisma.state.raw.length, 1);
  assert.match(prisma.state.raw[0].sql, /jsonb_set\(CASE WHEN jsonb_typeof\("settings"\) = 'object' THEN "settings" ELSE '\{\}'::jsonb END, '\{learnedPreferences\}', \?::jsonb, true\)/);
  assert.equal(prisma.state.raw[0].values[1], 'u1');
  // Without $executeRaw (other stores / tests) the previous path still works.
  const plain = fakePrisma({ theme: 'dark' });
  delete plain.$executeRaw;
  await learned.recordSignals({ prisma: plain, userId: 'u1', traits: ['tone:formal'] });
  assert.equal(plain.state.updates, 1);
  assert.equal(plain.state.settings.theme, 'dark');
});

test('learned preferences and the inferred profile never round-trip through the client settings', () => {
  const { withoutServerOwnedSettings, SERVER_OWNED_SETTINGS_KEYS } = usersInternal;
  assert.deepEqual([...SERVER_OWNED_SETTINGS_KEYS].sort(), ['inferred', 'learnedPreferences']);
  const fromClient = { theme: 'light', learnedPreferences: { traits: { 'language:en': { score: 9 } } }, inferred: { language: 'en' } };
  assert.deepEqual(withoutServerOwnedSettings(fromClient), { theme: 'light' });
  assert.equal(fromClient.learnedPreferences.traits['language:en'].score, 9, 'the input is not mutated');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'routes', 'users.js'), 'utf8');
  assert.match(src, /const patch = withoutServerOwnedSettings\(/);
  assert.match(src, /patch\.customInstructions = stripHtml\(patch\.customInstructions\)\.slice\(0, 4000\)/);
  assert.match(src, /const settings = withoutServerOwnedSettings\(\(u\.settings/);
});

test('the chat route teaches the store only through isLearnableCorrection and keys 👎 by message', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(ai, /if \(__traits\.length && __learned\.isLearnableCorrection\(\{\s*prompt,\s*detection: __repairDet,/);
  const chats = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chats.js'), 'utf8');
  assert.match(chats, /source: 'dislike', dedupeKey: message\.id/);
});
