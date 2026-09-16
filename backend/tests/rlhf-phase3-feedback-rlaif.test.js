'use strict';

/**
 * RLHF lote 1 — rich reason codes, pairwise ingest, RLAIF off-by-default,
 * source tagging, export filters.
 */

process.env.SIRAGPT_RLHF_AUTO_TRAIN = '0';
process.env.SIRAGPT_RLHF_ENABLED = '1';
delete process.env.SIRAGPT_RLHF_RLAIF;

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, beforeEach } = require('node:test');

const store = require('../src/services/rlhf/preference-store');
const rlaif = require('../src/services/rlhf/rlaif');
const exporter = require('../src/services/rlhf/export');
const reasons = require('../src/services/rlhf/reason-codes');
const ledger = require('../src/services/agents/feedback-ledger');

beforeEach(() => {
  store._reset();
  ledger._reset();
  rlaif._resetRateLimits();
  delete process.env.SIRAGPT_RLHF_RLAIF;
});

describe('reason codes', () => {
  it('accepts the Spanish-friendly enum and drops unknown tokens', () => {
    assert.equal(reasons.normalizeReasonCode('invented'), 'invented');
    assert.equal(reasons.normalizeReasonCode('OFF_TOPIC'), 'off_topic');
    assert.equal(reasons.normalizeReasonCode('not-a-real-code'), null);
    assert.equal(reasons.normalizeReasonCode(''), null);
    assert.ok(reasons.REASON_CODES.includes('harmful'));
    assert.ok(reasons.REASON_CODES.includes('other'));
  });

  it('maps reason=enum to reasonCode and free-text reason to notes', () => {
    const coded = reasons.resolveFeedbackReasons({ reason: 'incomplete' });
    assert.equal(coded.reasonCode, 'incomplete');
    assert.equal(coded.notes, null);

    const note = reasons.resolveFeedbackReasons({ reason: 'faltó el ejemplo de DPO' });
    assert.equal(note.reasonCode, null);
    assert.equal(note.notes, 'faltó el ejemplo de DPO');

    const both = reasons.resolveFeedbackReasons({
      reasonCode: 'wrong_tone',
      notes: 'demasiado formal para este chat',
    });
    assert.equal(both.reasonCode, 'wrong_tone');
    assert.match(both.notes, /formal/);
  });

  it('caps free-text notes', () => {
    const long = 'x'.repeat(800);
    const out = reasons.normalizeNotes(long);
    assert.equal(out.length, reasons.NOTES_MAX);
  });

  it('persists reasonCode + notes on a thumb without breaking old rows', async () => {
    await store.ingestThumb({
      userId: 'u1', runId: 'old', request: 'q', response: 'a', helpful: true,
    });
    await store.ingestThumb({
      userId: 'u1', runId: 'new', request: 'q2', response: 'b', helpful: false,
      reasonCode: 'invented', notes: 'se inventó el DOI',
    });
    const dumped = store.dump('u1');
    const old = dumped.find((e) => e.runId === 'old');
    const next = dumped.find((e) => e.runId === 'new');
    assert.equal(old.reasonCode, null);
    assert.equal(old.notes, null);
    assert.equal(next.reasonCode, 'invented');
    assert.equal(next.notes, 'se inventó el DOI');
    assert.equal(next.label, 'rejected');
  });
});

describe('pairwise ingest', () => {
  it('records chosen vs rejected with a shared pairId', async () => {
    const pair = await store.recordPair({
      userId: 'u1',
      prompt: 'how does DPO work?',
      chosen: 'good answer',
      rejected: 'bad answer',
      reasonCode: 'incomplete',
    });
    assert.equal(pair.stored, true);
    assert.ok(pair.pairId);
    assert.equal(pair.chosen.pairId, pair.rejected.pairId);
    const pairs = store.pairsFor('u1');
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].chosen.responseText, 'good answer');
    assert.equal(pairs[0].rejected.responseText, 'bad answer');
    assert.equal(pairs[0].chosen.reasonCode, 'incomplete');
  });

  it('accepts message ids as run keys for the pair', async () => {
    const pair = await store.recordPair({
      userId: 'u1',
      prompt: 'same prompt',
      chosen: 'win',
      rejected: 'lose',
      chosenMessageId: 'msg-a',
      rejectedMessageId: 'msg-b',
    });
    assert.equal(pair.chosen.messageId, 'msg-a');
    assert.equal(pair.rejected.messageId, 'msg-b');
  });

  it('fail-open on incomplete pair', async () => {
    const pair = await store.recordPair({
      userId: 'u1', prompt: 'solo prompt', chosen: 'sí',
    });
    assert.equal(pair.stored, false);
    assert.equal(pair.reason, 'incomplete_pair');
    assert.equal(store.stats('u1').total, 0);
  });

  it('DPO export uses the durable pair and skips RLAIF by default', async () => {
    await store.recordPair({
      userId: 'u1', prompt: 'p', chosen: 'win', rejected: 'lose',
    });
    await store.recordEvent({
      userId: 'u1', runId: 'syn', source: 'rlaif', label: 'chosen',
      promptText: 'p', responseText: 'synthetic-win',
    });
    await store.recordEvent({
      userId: 'u1', runId: 'syn2', source: 'rlaif', label: 'rejected',
      promptText: 'p', responseText: 'synthetic-lose',
    });
    const dpo = await exporter.exportData({ userId: 'u1', format: 'dpo', scrubPii: false });
    assert.equal(dpo.count, 1);
    assert.match(dpo.ndjson, /win/);
    assert.doesNotMatch(dpo.ndjson, /synthetic-win/);

    const withAi = await exporter.exportData({
      userId: 'u1', format: 'dpo', scrubPii: false, includeRlaif: true,
    });
    assert.ok(withAi.count >= 1);
  });
});

describe('regenerate reasons', () => {
  it('attaches reasonCode to the prior rejected row', async () => {
    const prompt = 'escribe un haiku';
    await store.recordEvent({
      userId: 'u1', runId: 'old', messageId: 'old',
      promptText: prompt, responseText: 'mal haiku', label: 'unlabeled',
    });
    const out = await store.ingestRegenerate({
      userId: 'u1', messageId: 'new', prompt, response: 'mejor haiku',
      reasonCode: 'wrong_tone', notes: 'el primero sonaba a plantilla',
    });
    assert.equal(out.priorRejected, true);
    const prior = store.dump('u1').find((e) => e.messageId === 'old');
    assert.equal(prior.label, 'rejected');
    assert.equal(prior.reasonCode, 'wrong_tone');
    assert.match(prior.notes, /plantilla/);
  });
});

describe('RLAIF', () => {
  it('is off by default and maybeIngest is a no-op', async () => {
    delete process.env.SIRAGPT_RLHF_RLAIF;
    assert.equal(rlaif.isRlaifEnabled(), false);
    const out = await rlaif.maybeIngest({
      userId: 'u1', userRequest: 'q', response: 'a',
      openai: { chat: { completions: { create: async () => { throw new Error('should not call'); } } } },
    });
    assert.equal(out.stored, false);
    assert.equal(out.reason, 'disabled');
    assert.equal(store.stats('u1').total, 0);
  });

  it('tags committed rows source=rlaif', async () => {
    process.env.SIRAGPT_RLHF_RLAIF = '1';
    const recorded = await store.recordEvent({
      userId: 'u1', runId: 'ai1', source: 'rlaif', label: 'chosen',
      promptText: 'q', responseText: 'synthetic',
    });
    assert.equal(recorded.event.source, 'rlaif');
    const sft = await exporter.exportData({ userId: 'u1', format: 'sft', scrubPii: false });
    assert.equal(sft.count, 0);
    const opted = await exporter.exportData({
      userId: 'u1', format: 'sft', scrubPii: false, includeRlaif: true,
    });
    assert.equal(opted.count, 1);
    assert.match(opted.ndjson, /synthetic/);
  });

  it('rate-limits synthetic labels per user', async () => {
    process.env.SIRAGPT_RLHF_RLAIF = '1';
    process.env.SIRAGPT_RLHF_RLAIF_MAX_PER_USER = '1';
    const fakeOpenAi = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify({
              helpful: 9, honest: 9, harmless: 9, overall: 9, issues: [], reasoning: 'ok',
            }) } }],
          }),
        },
      },
    };
    const first = await rlaif.maybeIngest({
      userId: 'u1', runId: 'm1', userRequest: 'q', response: 'great',
      openai: fakeOpenAi,
    });
    assert.equal(first.stored, true);
    assert.equal(first.source, 'rlaif');
    const second = await rlaif.maybeIngest({
      userId: 'u1', runId: 'm2', userRequest: 'q2', response: 'also great',
      openai: fakeOpenAi,
    });
    assert.equal(second.stored, false);
    assert.equal(second.reason, 'rate_limited');
    delete process.env.SIRAGPT_RLHF_RLAIF_MAX_PER_USER;
  });

  it('does not overwrite a human label on the same runId', async () => {
    process.env.SIRAGPT_RLHF_RLAIF = '1';
    await store.ingestThumb({
      userId: 'u1', runId: 'm1', request: 'q', response: 'human pick', helpful: true,
    });
    const out = await rlaif.maybeIngest({
      userId: 'u1', runId: 'm1', userRequest: 'q', response: 'human pick',
      openai: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: JSON.stringify({
                helpful: 9, honest: 9, harmless: 9, overall: 9, issues: [], reasoning: 'ok',
              }) } }],
            }),
          },
        },
      },
    });
    assert.equal(out.stored, false);
    assert.equal(out.reason, 'human_exists');
    assert.equal(store.dump('u1')[0].source, 'explicit');
  });

  it('proposeFromRecent is a no-op when the flag is off', async () => {
    const out = await rlaif.proposeFromRecent({
      userId: 'u1',
      turns: [
        { prompt: 'p', response: 'a' },
        { prompt: 'p', response: 'b' },
      ],
    });
    assert.equal(out.reason, 'disabled');
    assert.equal(out.proposed, 0);
  });

  it('proposePair fail-opens without a judge client', async () => {
    process.env.SIRAGPT_RLHF_RLAIF = '1';
    const out = await rlaif.proposePair({
      userId: 'u1', prompt: 'p', a: 'good', b: 'bad',
      openai: null,
    });
    assert.equal(out.stored, false);
    assert.ok(['abstain', 'no_score', 'fail_open'].includes(out.reason));
  });
});

describe('source contracts', () => {
  it('feedback and pair routes accept reasonCode and share pairId via recordPair', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/rlhf.js'), 'utf8');
    assert.match(src, /reasonCode/);
    assert.match(src, /recordPair/);
    assert.match(src, /chosenMessageId/);
    assert.match(src, /rlaif\/propose/);
    assert.match(src, /authenticateToken/);
  });

  it('generate regenerate path forwards rich reasons and never console.*', () => {
    const aiSrc = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
    const generateStart = aiSrc.indexOf("router.post(\n  '/generate'");
    const generateEnd = aiSrc.indexOf('router.post(', generateStart + 20);
    const generateRoute = aiSrc.slice(generateStart, generateEnd);
    assert.match(aiSrc, /rlhfFeedback/);
    assert.match(aiSrc, /reasonCode: rlhfFeedback/);
    assert.match(aiSrc, /rlhf\.rlaif_skipped/);
    assert.match(aiSrc, /proposeFromRecent/);
    assert.doesNotMatch(
      generateRoute,
      /console\.(?:log|info|warn|error)\s*\(/,
      'all /generate operational logs must cross the privacy boundary',
    );
    assert.doesNotMatch(aiSrc, /SIRAGPT_RLHF_BEST_OF_N\s*=\s*['"]1['"]/);
    assert.doesNotMatch(aiSrc, /AGENTES_CODING_V2\s*=\s*['"]1['"]/);
  });

  it('chats thumbs accept reasonCode + notes without new chrome', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/chats.js'), 'utf8');
    assert.match(src, /reasonCode/);
    assert.match(src, /resolveFeedbackReasons/);
  });

  it('GDPR scrub selects preference notes', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/jobs/scrub-deleted-user-content.js'),
      'utf8',
    );
    assert.match(src, /preferenceEvent/);
    assert.match(src, /notes/);
  });
});
