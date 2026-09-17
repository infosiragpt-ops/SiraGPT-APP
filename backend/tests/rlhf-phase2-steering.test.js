'use strict';

/**
 * RLHF phase 2 — steering injection, fail-open, stats, routing bridge,
 * and generate-path source contracts (no console.*).
 */

process.env.SIRAGPT_RLHF_AUTO_TRAIN = '0';
process.env.SIRAGPT_RLHF_ENABLED = '1';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, beforeEach } = require('node:test');

const steering = require('../src/services/rlhf/steering');
const metrics = require('../src/services/rlhf/metrics');
const store = require('../src/services/rlhf/preference-store');
const policy = require('../src/services/rlhf/policy');
const routingBridge = require('../src/services/rlhf/routing-bridge');
const routingFeedback = require('../src/services/routing-feedback');
const ledger = require('../src/services/agents/feedback-ledger');
const rlhf = require('../src/services/rlhf');

function vec(arr) {
  return new Float32Array(arr);
}

function fakeEmbedder(table) {
  return async (texts) => texts.map((t) => {
    if (table[t]) return table[t];
    const out = new Float32Array(4);
    for (let i = 0; i < t.length; i++) out[i % 4] += (t.charCodeAt(i) % 13) / 13;
    return out;
  });
}

beforeEach(() => {
  store._reset();
  ledger._reset();
  metrics.reset();
  routingFeedback.reset();
});

describe('steering flags', () => {
  it('few-shot steering is ON by default', () => {
    const orig = process.env.SIRAGPT_RLHF_STEERING;
    try {
      delete process.env.SIRAGPT_RLHF_STEERING;
      assert.equal(steering.isSteeringEnabled(), true);
      process.env.SIRAGPT_RLHF_STEERING = '0';
      assert.equal(steering.isSteeringEnabled(), false);
    } finally {
      if (orig == null) delete process.env.SIRAGPT_RLHF_STEERING;
      else process.env.SIRAGPT_RLHF_STEERING = orig;
    }
  });

  it('best-of-N stays OFF unless SIRAGPT_RLHF_BEST_OF_N is explicitly on', () => {
    const orig = process.env.SIRAGPT_RLHF_BEST_OF_N;
    try {
      delete process.env.SIRAGPT_RLHF_BEST_OF_N;
      assert.equal(steering.isBestOfNEnabled(), false);
      assert.equal(policy.isBestOfNEnabled(), false);
      process.env.SIRAGPT_RLHF_BEST_OF_N = '0';
      assert.equal(steering.isBestOfNEnabled(), false);
      process.env.SIRAGPT_RLHF_BEST_OF_N = '1';
      assert.equal(steering.isBestOfNEnabled(), true);
    } finally {
      if (orig == null) delete process.env.SIRAGPT_RLHF_BEST_OF_N;
      else process.env.SIRAGPT_RLHF_BEST_OF_N = orig;
    }
  });

  it('maybeRankSamples is a no-op when best-of-N is off', async () => {
    const orig = process.env.SIRAGPT_RLHF_BEST_OF_N;
    try {
      delete process.env.SIRAGPT_RLHF_BEST_OF_N;
      const ranked = await steering.maybeRankSamples({
        prompt: 'hola',
        samples: ['a', 'b'],
        embedder: fakeEmbedder({}),
      });
      assert.equal(ranked, null);
    } finally {
      if (orig == null) delete process.env.SIRAGPT_RLHF_BEST_OF_N;
      else process.env.SIRAGPT_RLHF_BEST_OF_N = orig;
    }
  });
});

describe('formatSteeringBlock', () => {
  it('builds a Spanish-safe chat block and caps size', () => {
    const block = steering.formatChatPreferenceBlock([{
      agent: 'chat',
      request: 'explica DPO',
      response: 'DPO compara respuestas preferidas y rechazadas.',
      notes: 'más corto',
    }], { maxChars: 1800 });
    assert.match(block, /PREFERENCIAS DEL USUARIO/);
    assert.match(block, /explica DPO/);
    assert.match(block, /DPO compara/);
    assert.doesNotMatch(block, /deepseek|openrouter|model_id/i);
    assert.ok(block.length < 1800);
  });

  it('uses the document heading when agent=document', () => {
    const block = steering.formatSteeringBlock([{
      agent: 'document',
      request: 'resume la tesis',
      response: 'El objetivo es X',
    }], { agent: 'document' });
    assert.match(block, /DOCUMENT ANALYSIS RLHF/);
    assert.match(block, /resume la tesis/);
  });

  it('returns empty without exemplars', () => {
    assert.equal(steering.formatSteeringBlock([]), '');
    assert.equal(steering.formatSteeringBlock(null), '');
  });

  it('truncates oversized blocks', () => {
    const long = 'palabra '.repeat(400);
    const block = steering.formatChatPreferenceBlock([{
      request: long,
      response: long,
    }], { maxChars: 400 });
    assert.ok(block.length <= 400);
    assert.match(block, /…$/);
  });
});

describe('buildSteeringBlock', () => {
  it('injects helpful chat exemplars for a similar prompt', async () => {
    const prompt = 'explica DPO con un ejemplo';
    const embedder = fakeEmbedder({
      [prompt]: vec([1, 0, 0, 0]),
      'explica DPO': vec([1, 0, 0, 0]),
    });
    await store.ingestThumb({
      userId: 'u1',
      runId: 'm1',
      agent: 'chat',
      request: 'explica DPO',
      response: 'DPO evita entrenar un RM explícito.',
      helpful: true,
      embedder,
    });
    const out = await steering.buildSteeringBlock({
      userId: 'u1',
      prompt,
      embedder,
      agent: 'chat',
    });
    assert.equal(out.applied, true);
    assert.equal(out.hit, true);
    assert.equal(out.agent, 'chat');
    assert.match(out.block, /PREFERENCIAS DEL USUARIO/);
    assert.match(out.block, /DPO evita/);
    assert.equal(metrics.snapshot().steering.applied, 1);
    assert.equal(metrics.snapshot().exemplars.hits, 1);
  });

  it('tags document turns and keeps the document block', async () => {
    const prompt = 'analiza el documento';
    const files = [{
      name: 'tesis.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }];
    const embedder = fakeEmbedder({
      [prompt]: vec([0, 1, 0, 0]),
      'resume la tesis': vec([0, 1, 0, 0]),
    });
    await store.ingestThumb({
      userId: 'u1',
      runId: 'd1',
      agent: 'document',
      request: 'resume la tesis',
      response: 'Hallazgos A y B',
      helpful: true,
      embedder,
    });
    const out = await steering.buildSteeringBlock({
      userId: 'u1',
      prompt,
      files,
      embedder,
    });
    assert.equal(out.agent, 'document');
    assert.equal(out.applied, true);
    assert.match(out.block, /DOCUMENT ANALYSIS RLHF/);
  });

  it('fail-open when embedder throws', async () => {
    await store.ingestThumb({
      userId: 'u1', runId: 'm1', agent: 'chat',
      request: 'q', response: 'a', helpful: true,
    });
    const out = await steering.buildSteeringBlock({
      userId: 'u1',
      prompt: 'q similar',
      embedder: async () => { throw new Error('embed down'); },
    });
    assert.equal(out.applied, false);
    assert.equal(out.block, '');
    assert.ok(out.reason === 'no_exemplars' || out.reason === 'fail_open');
  });

  it('fail-open when ledger.findExemplars throws', async () => {
    const out = await steering.buildSteeringBlock({
      userId: 'u1',
      prompt: 'hola larga suficiente para no ser trivial',
      embedder: fakeEmbedder({}),
      ledger: {
        findExemplars: async () => { throw new Error('prisma down'); },
      },
    });
    assert.equal(out.applied, false);
    assert.equal(out.block, '');
    assert.equal(out.reason, 'fail_open');
    assert.equal(metrics.snapshot().steering.failOpen, 1);
  });

  it('skips when SIRAGPT_RLHF_STEERING=0', async () => {
    const orig = process.env.SIRAGPT_RLHF_STEERING;
    process.env.SIRAGPT_RLHF_STEERING = '0';
    try {
      const out = await steering.buildSteeringBlock({
        userId: 'u1',
        prompt: 'explica DPO',
        embedder: fakeEmbedder({}),
      });
      assert.equal(out.applied, false);
      assert.equal(out.reason, 'disabled');
    } finally {
      if (orig == null) delete process.env.SIRAGPT_RLHF_STEERING;
      else process.env.SIRAGPT_RLHF_STEERING = orig;
    }
  });

  it('skips without userId or prompt', async () => {
    const a = await steering.buildSteeringBlock({ prompt: 'hola', embedder: fakeEmbedder({}) });
    const b = await steering.buildSteeringBlock({ userId: 'u1', prompt: '', embedder: fakeEmbedder({}) });
    assert.equal(a.reason, 'missing_input');
    assert.equal(b.reason, 'missing_input');
    assert.equal(a.applied, false);
    assert.equal(b.applied, false);
  });
});

describe('phase-2 metrics + stats', () => {
  it('records ingest, export sizes, and RM scores', async () => {
    await store.ingestThumb({
      userId: 'u1', runId: 'm1', request: 'q', response: 'a', helpful: true,
    });
    const exported = await rlhf.exportData({ userId: 'u1', format: 'sft', scrubPii: false });
    metrics.recordRmScore({ score: 0.42, used: true, version: 'test' });
    const snap = metrics.snapshot();
    assert.ok(snap.ingest.total >= 1);
    assert.equal(snap.exports.total, 1);
    assert.equal(snap.exports.lastCount, exported.count);
    assert.ok(snap.exports.lastBytes > 0);
    assert.equal(snap.rm.used, 1);
    assert.equal(snap.rm.lastScore, 0.42);

    const prom = metrics.toPrometheusText();
    assert.match(prom, /sira_rlhf_ingest_total/);
    assert.match(prom, /sira_rlhf_export_last_bytes/);
    assert.match(prom, /sira_rlhf_steering_applied_total/);
    assert.ok(prom.endsWith('\n'));
  });

  it('phase2Stats matches snapshot and facade exports it', () => {
    metrics.recordSteering({ applied: true, exemplarCount: 2, chars: 120 });
    const a = metrics.phase2Stats();
    const b = rlhf.phase2Stats();
    assert.equal(a.steering.applied, 1);
    assert.equal(b.steering.applied, 1);
    assert.equal(typeof rlhf.isSteeringEnabled, 'function');
  });

  it('hit rate is 0 before lookups and 1 after a hit', async () => {
    assert.equal(metrics.snapshot().exemplars.hitRate, 0);
    const prompt = 'tema similar';
    const embedder = fakeEmbedder({
      [prompt]: vec([1, 0, 0, 0]),
      tema: vec([1, 0, 0, 0]),
    });
    await store.ingestThumb({
      userId: 'u1', runId: 'm1', agent: 'chat',
      request: 'tema', response: 'ok', helpful: true, embedder,
    });
    await steering.buildSteeringBlock({ userId: 'u1', prompt, embedder, agent: 'chat' });
    assert.equal(metrics.snapshot().exemplars.hitRate, 1);
  });
});

describe('routing-feedback bridge', () => {
  it('maps liked → success and disliked → disliked when a model is present', () => {
    const liked = routingBridge.recordFromThumb({
      feedback: 'liked',
      metadata: { model: 'sira-rapido', intent: 'chat', difficulty: 'simple' },
    });
    assert.equal(liked.recorded, true);
    assert.equal(liked.outcome, 'success');
    const down = routingBridge.recordFromThumb({
      feedback: 'disliked',
      metadata: { model: 'sira-rapido', intent: 'chat', difficulty: 'simple' },
    });
    assert.equal(down.recorded, true);
    assert.equal(down.outcome, 'disliked');
    const stats = routingFeedback.getStats('chat', 'simple', 'sira-rapido');
    assert.equal(stats.attempts, 2);
    assert.equal(stats.positives, 1);
    assert.equal(stats.negatives, 1);
  });

  it('fail-open without model or on garbage', () => {
    assert.deepEqual(
      routingBridge.recordFromThumb({ feedback: 'liked', metadata: {} }),
      { recorded: false, reason: 'no_model' },
    );
    assert.doesNotThrow(() => routingBridge.recordFromThumb(null));
    assert.equal(routingBridge.recordFromRegenerate({ model: 'sira-pro' }).outcome, 'regenerated');
  });

  it('disliked is a first-class negative in routing-feedback', () => {
    for (let i = 0; i < 10; i += 1) {
      routingFeedback.recordOutcome({
        intent: 'chat', difficulty: 'simple', model: 'weak', outcome: 'disliked',
      });
    }
    assert.ok(routingFeedback.penaltyFor({ intent: 'chat', difficulty: 'simple', model: 'weak' }) > 0);
  });
});

describe('source contracts', () => {
  const aiSrc = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  const generateStart = aiSrc.indexOf("router.post(\n  '/generate'");
  const generateEnd = aiSrc.indexOf('router.post(', generateStart + 20);
  const generateRoute = aiSrc.slice(generateStart, generateEnd);

  it('generate path uses buildSteeringBlock and structured logger events', () => {
    assert.match(aiSrc, /rlhf\/steering/);
    assert.match(aiSrc, /buildSteeringBlock/);
    assert.match(generateRoute, /rlhf\.steering_applied/);
    assert.match(generateRoute, /rlhf\.steering_skipped/);
    assert.doesNotMatch(
      generateRoute,
      /console\.(?:log|info|warn|error)\s*\(/,
      'all /generate operational logs must cross the privacy boundary',
    );
  });

  it('generate path does not enable best-of-N by default', () => {
    assert.doesNotMatch(aiSrc, /SIRAGPT_RLHF_BEST_OF_N\s*=\s*['"]1['"]/);
    assert.doesNotMatch(aiSrc, /AGENTES_CODING_V2\s*=\s*['"]1['"]/);
  });

  it('agentic loop accepts preferenceBlock', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
    assert.match(src, /preferenceBlock/);
    assert.match(aiSrc, /preferenceBlock:\s*feedbackBlock/);
  });

  it('stats route exposes phase2 and keeps auth', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/rlhf.js'), 'utf8');
    assert.match(src, /phase2/);
    assert.match(src, /isSteeringEnabled/);
    assert.match(src, /authenticateToken/);
    assert.match(src, /requireAdmin/);
  });

  it('chats feedback records liked and disliked through the bridge', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/chats.js'), 'utf8');
    assert.match(src, /recordFromThumb/);
    assert.match(src, /feedback/);
  });
});
