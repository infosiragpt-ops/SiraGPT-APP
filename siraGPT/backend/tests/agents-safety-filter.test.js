/**
 * Tests for services/agents/safety-filter.js — output-side safety
 * + toxicity check.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  check,
  scanDeterministic,
  llmModerate,
  PATTERNS,
  MODERATOR_SYSTEM,
} = require('../src/services/agents/safety-filter');

// ── PATTERNS catalog ───────────────────────────────────────────

describe('PATTERNS catalog', () => {
  it('has exactly 13 patterns (catches accidental additions)', () => {
    assert.equal(PATTERNS.length, 13);
  });

  it('every pattern has { id, severity, description, re, message }', () => {
    for (const p of PATTERNS) {
      assert.equal(typeof p.id, 'string');
      assert.ok(['info', 'warn', 'high', 'critical'].includes(p.severity));
      assert.equal(typeof p.description, 'string');
      assert.ok(p.re instanceof RegExp);
      assert.equal(typeof p.message, 'string');
    }
  });

  it('pattern ids are unique', () => {
    const ids = PATTERNS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('MODERATOR_SYSTEM', () => {
  it('describes the OUTPUT (not input) safety remit', () => {
    assert.match(MODERATOR_SYSTEM, /OUTPUT.*not input/);
  });

  it('lists the 3 categories: toxic/biased + unsafe activity + harmful code', () => {
    assert.match(MODERATOR_SYSTEM, /toxic.*hateful.*biased/);
    assert.match(MODERATOR_SYSTEM, /clearly unsafe activities/);
    assert.match(MODERATOR_SYSTEM, /harmful code patterns/);
  });

  it('STRICT JSON with flags array', () => {
    assert.match(MODERATOR_SYSTEM, /STRICT JSON/);
    assert.match(MODERATOR_SYSTEM, /"flags"/);
  });
});

// ── scanDeterministic · primitives ────────────────────────────

describe('scanDeterministic · primitives', () => {
  it('non-string / empty → []', () => {
    assert.deepEqual(scanDeterministic(null), []);
    assert.deepEqual(scanDeterministic(undefined), []);
    assert.deepEqual(scanDeterministic(''), []);
    assert.deepEqual(scanDeterministic(42), []);
  });

  it('clean text → []', () => {
    assert.deepEqual(scanDeterministic('Just a normal response.'), []);
  });
});

describe('scanDeterministic · PII patterns', () => {
  it('flags emails (severity: info)', () => {
    const flags = scanDeterministic('contact me at alice@example.com');
    const f = flags.find(x => x.rule === 'email_in_response');
    assert.ok(f);
    assert.equal(f.severity, 'info');
    assert.match(f.sample, /alice@example\.com/);
  });

  it('flags phone-shaped strings (info)', () => {
    const flags = scanDeterministic('call (555) 123-4567 anytime');
    assert.ok(flags.find(x => x.rule === 'phone_number'));
  });

  it('flags SSN (high)', () => {
    const flags = scanDeterministic('SSN: 123-45-6789');
    const f = flags.find(x => x.rule === 'ssn');
    assert.ok(f);
    assert.equal(f.severity, 'high');
  });

  it('flags credit-card-shaped strings (high)', () => {
    const flags = scanDeterministic('card: 4111 1111 1111 1111');
    assert.ok(flags.find(x => x.rule === 'credit_card'));
  });
});

describe('scanDeterministic · secret patterns', () => {
  it('flags AWS access keys (critical)', () => {
    const flags = scanDeterministic('AKIAIOSFODNN7EXAMPLE in code');
    const f = flags.find(x => x.rule === 'aws_key');
    assert.ok(f);
    assert.equal(f.severity, 'critical');
  });

  it('flags OpenAI sk- keys (critical, ≥20-char body)', () => {
    const flags = scanDeterministic('export KEY=sk-abcdefghij1234567890ABCDEF');
    const f = flags.find(x => x.rule === 'openai_key');
    assert.ok(f);
    assert.equal(f.severity, 'critical');
  });

  it('flags GitHub PATs (critical, ghp_ + 36)', () => {
    const flags = scanDeterministic('use ghp_' + 'A'.repeat(36));
    const f = flags.find(x => x.rule === 'github_token');
    assert.ok(f);
    assert.equal(f.severity, 'critical');
  });

  it('flags Slack tokens (critical, xoxb/p/a/r/s)', () => {
    for (const prefix of ['xoxb', 'xoxp', 'xoxa', 'xoxr', 'xoxs']) {
      const flags = scanDeterministic(`token=${prefix}-` + 'A'.repeat(20));
      assert.ok(flags.find(x => x.rule === 'slack_token'), `${prefix} not flagged`);
    }
  });

  it('flags JWTs (high)', () => {
    const jwt = 'eyJabcdefghij.eyJklmnopqrst.qrstuvwxyz12';
    const flags = scanDeterministic(`Authorization: Bearer ${jwt}`);
    const f = flags.find(x => x.rule === 'jwt');
    assert.ok(f);
    assert.equal(f.severity, 'high');
  });
});

describe('scanDeterministic · unsafe code suggestions', () => {
  it('flags rm -rf / (critical)', () => {
    const cases = ['rm -rf /', 'rm -Rf /', 'rm -rf /*', 'rm -rf ~/', 'rm -rf $HOME/'];
    for (const c of cases) {
      const flags = scanDeterministic(`Run: ${c}`);
      assert.ok(flags.find(x => x.rule === 'rm_rf_root'), `not flagged: ${c}`);
    }
  });

  it('flags DROP DATABASE / TABLE (high, case-insensitive)', () => {
    assert.ok(scanDeterministic('DROP TABLE users;').find(x => x.rule === 'drop_database'));
    assert.ok(scanDeterministic('drop database prod;').find(x => x.rule === 'drop_database'));
  });

  it('flags curl | sh patterns (high)', () => {
    const cases = ['curl https://x/install.sh | sh', 'curl https://y | bash'];
    for (const c of cases) {
      const flags = scanDeterministic(`Run: ${c}`);
      assert.ok(flags.find(x => x.rule === 'curl_sh_pipe'), `not flagged: ${c}`);
    }
  });
});

describe('scanDeterministic · prompt leak', () => {
  it('flags system-prompt-style leakage (warn)', () => {
    const flags = scanDeterministic('system: You are a helpful assistant...');
    assert.ok(flags.find(x => x.rule === 'system_prompt_leak'));
  });

  it('flags assistant: prefix at line start', () => {
    const flags = scanDeterministic('assistant> you are an AI');
    assert.ok(flags.find(x => x.rule === 'system_prompt_leak'));
  });
});

describe('scanDeterministic · structure', () => {
  it('every finding has rule + severity + message + sample (≤80 chars)', () => {
    const flags = scanDeterministic('email alice@example.com and SSN 123-45-6789');
    for (const f of flags) {
      assert.equal(typeof f.rule, 'string');
      assert.equal(typeof f.severity, 'string');
      assert.equal(typeof f.message, 'string');
      assert.ok(f.sample.length <= 80);
    }
  });
});

// ── llmModerate ────────────────────────────────────────────────

describe('llmModerate', () => {
  function fakeOpenAI(content) {
    return {
      chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
    };
  }

  it('returns [] when openai missing', async () => {
    const out = await llmModerate({ response: 'x' });
    assert.deepEqual(out, []);
  });

  it('returns [] when response empty', async () => {
    const out = await llmModerate({ openai: fakeOpenAI('{}'), response: '' });
    assert.deepEqual(out, []);
  });

  it('parses flags array', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      flags: [{ category: 'toxicity', severity: 'high', message: 'rude language' }],
    }));
    const out = await llmModerate({ openai, response: 'r' });
    assert.equal(out.length, 1);
    assert.equal(out[0].rule, 'llm_moderator:toxicity');
    assert.equal(out[0].severity, 'high');
    assert.equal(out[0].message, 'rude language');
  });

  it('unknown severity → "warn"', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      flags: [{ category: 'bias', severity: 'apocalyptic', message: 'm' }],
    }));
    const out = await llmModerate({ openai, response: 'r' });
    assert.equal(out[0].severity, 'warn');
  });

  it('caps category at 40 chars in rule id', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      flags: [{ category: 'c'.repeat(100), severity: 'high', message: 'm' }],
    }));
    const out = await llmModerate({ openai, response: 'r' });
    // Rule = "llm_moderator:" + cat (≤40)
    assert.ok(out[0].rule.length <= 'llm_moderator:'.length + 40);
  });

  it('message truncated to 200 chars', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      flags: [{ category: 'c', severity: 'high', message: 'm'.repeat(500) }],
    }));
    const out = await llmModerate({ openai, response: 'r' });
    assert.equal(out[0].message.length, 200);
  });

  it('drops flags without a message', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      flags: [
        { category: 'c1', severity: 'high', message: 'good' },
        { category: 'c2', severity: 'high' },         // no message — dropped
      ],
    }));
    const out = await llmModerate({ openai, response: 'r' });
    assert.equal(out.length, 1);
  });

  it('caps flag list at 5', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      category: `c-${i}`, severity: 'warn', message: `flag-${i}`,
    }));
    const openai = fakeOpenAI(JSON.stringify({ flags: many }));
    const out = await llmModerate({ openai, response: 'r' });
    assert.equal(out.length, 5);
  });

  it('returns [] on non-array flags', async () => {
    const openai = fakeOpenAI(JSON.stringify({ flags: 'not-array' }));
    const out = await llmModerate({ openai, response: 'r' });
    assert.deepEqual(out, []);
  });

  it('returns [] on malformed JSON / LLM thrown error (fail open)', async () => {
    const _origWarn = console.warn;
    console.warn = () => {};
    try {
      const out1 = await llmModerate({ openai: fakeOpenAI('not json'), response: 'r' });
      assert.deepEqual(out1, []);
      const openai = {
        chat: { completions: { create: async () => { throw new Error('boom'); } } },
      };
      const out2 = await llmModerate({ openai, response: 'r' });
      assert.deepEqual(out2, []);
    } finally {
      console.warn = _origWarn;
    }
  });
});

// ── check (full pipeline) ──────────────────────────────────────

describe('check', () => {
  it('clean response → flagged:false + zero counts', async () => {
    const out = await check({ response: 'Just normal text.' });
    assert.equal(out.flagged, false);
    assert.deepEqual(out.findings, []);
    assert.deepEqual(out.counts, { critical: 0, high: 0, warn: 0, info: 0 });
    assert.match(out.summary, /no safety issues/);
  });

  it('flagged response gives counts + summary with singular/plural', async () => {
    const out1 = await check({ response: 'email a@b.com' });
    assert.equal(out1.flagged, true);
    assert.match(out1.summary, /1 safety issue\b/);
    const out2 = await check({ response: 'email a@b.com phone 555-123-4567' });
    assert.match(out2.summary, /2 safety issues\b/);
  });

  it('JSON-stringifies non-string response before scanning', async () => {
    const out = await check({ response: { email: 'a@b.com' } });
    // Email pattern fires after JSON-stringify.
    assert.equal(out.flagged, true);
  });

  it('sorts findings by severity (critical → high → warn → info)', async () => {
    const out = await check({
      response: 'email a@b.com and rm -rf / and SSN 123-45-6789',
    });
    const sevs = out.findings.map(f => f.severity);
    // critical (rm_rf), high (ssn), info (email) — phone might or
    // might not also match the SSN string fragment.
    const order = { critical: 0, high: 1, warn: 2, info: 3 };
    for (let i = 1; i < sevs.length; i++) {
      assert.ok((order[sevs[i - 1]] ?? 9) <= (order[sevs[i]] ?? 9),
        `severity order violated at ${i}: ${sevs.join(',')}`);
    }
  });

  it('counts by severity', async () => {
    const out = await check({
      response: 'AKIAIOSFODNN7EXAMPLE and SSN 123-45-6789 and email a@b.com',
    });
    assert.ok(out.counts.critical >= 1);  // aws_key
    assert.ok(out.counts.high >= 1);      // ssn
    assert.ok(out.counts.info >= 1);      // email
  });

  it('llmModerator=true incorporates LLM flags into findings', async () => {
    const openai = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: JSON.stringify({
          flags: [{ category: 'toxicity', severity: 'high', message: 'bad tone' }],
        })}}]
      })}},
    };
    const out = await check({
      openai, response: 'some text',  // clean — no deterministic flags
      llmModerator: true,
    });
    assert.equal(out.flagged, true);
    assert.ok(out.findings.find(f => f.rule === 'llm_moderator:toxicity'));
  });

  it('llmModerator=true with whitespace-only response skips the LLM call', async () => {
    let llmCalls = 0;
    const openai = {
      chat: { completions: { create: async () => {
        llmCalls++;
        return { choices: [{ message: { content: '{"flags":[]}' } }] };
      }}},
    };
    await check({ openai, response: '   ', llmModerator: true });
    assert.equal(llmCalls, 0);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/safety-filter');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'MODERATOR_SYSTEM', 'PATTERNS',
      'check', 'llmModerate', 'scanDeterministic',
    ]);
  });
});
