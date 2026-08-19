'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  verifyRotation,
  validateSecret,
  parseEnvText,
  readEnvFile,
  shannonEntropyBits,
  fingerprint,
  formatReport,
  KEY_RULES,
} = require('../scripts/verify-secret-rotation.js');

function strongSecret(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64');
}

test('parseEnvText handles quoted, commented and empty lines', () => {
  const text = [
    '# comment',
    '',
    'FOO=bar',
    'BAZ="quoted value"',
    "QUX='single'",
    'NOEQ',
    'SPACED = trimmed ',
  ].join('\n');
  const env = parseEnvText(text);
  assert.equal(env.FOO, 'bar');
  assert.equal(env.BAZ, 'quoted value');
  assert.equal(env.QUX, 'single');
  assert.equal(env.SPACED, 'trimmed');
  assert.ok(!('NOEQ' in env));
});

test('readEnvFile returns {} for missing file', () => {
  assert.deepEqual(readEnvFile('/nonexistent/path/.env'), {});
  assert.deepEqual(readEnvFile(''), {});
});

test('readEnvFile reads a real file', () => {
  const tmp = path.join(os.tmpdir(), `env-${Date.now()}.env`);
  fs.writeFileSync(tmp, 'A=1\nB=2\n');
  try {
    const env = readEnvFile(tmp);
    assert.equal(env.A, '1');
    assert.equal(env.B, '2');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('shannonEntropyBits is zero for empty and high for random', () => {
  assert.equal(shannonEntropyBits(''), 0);
  assert.equal(shannonEntropyBits('aaaaaaaa'), 0);
  const bits = shannonEntropyBits(strongSecret(48));
  assert.ok(bits > 128, `expected >128 bits, got ${bits}`);
});

test('fingerprint is stable and short, null for empty', () => {
  assert.equal(fingerprint(''), null);
  assert.equal(fingerprint(null), null);
  const fp = fingerprint('hello');
  assert.equal(fp.length, 12);
  assert.equal(fp, fingerprint('hello'));
  assert.notEqual(fp, fingerprint('world'));
});

test('validateSecret flags missing, placeholder, short, bad prefix', () => {
  assert.equal(validateSecret('K', '', null)[0].code, 'missing');
  assert.equal(validateSecret('K', 'changeme', null)[0].code, 'placeholder');
  const issues = validateSecret('OPENAI_API_KEY', 'short', KEY_RULES.OPENAI_API_KEY);
  const codes = issues.map((i) => i.code).sort();
  assert.ok(codes.includes('too_short'));
  assert.ok(codes.includes('bad_prefix'));
});

test('validateSecret accepts valid OpenAI-style key', () => {
  const ok = 'sk-' + 'a'.repeat(40);
  const issues = validateSecret('OPENAI_API_KEY', ok, KEY_RULES.OPENAI_API_KEY);
  assert.equal(issues.length, 0);
});

test('validateSecret pattern rule for REDIS_URL', () => {
  assert.equal(validateSecret('REDIS_URL', 'redis://x:6379', KEY_RULES.REDIS_URL).length, 0);
  const bad = validateSecret('REDIS_URL', 'http://wrong', KEY_RULES.REDIS_URL);
  assert.ok(bad.some((i) => i.code === 'bad_pattern'));
});

test('validateSecret entropy rule warns on low-entropy JWT_SECRET', () => {
  const issues = validateSecret('JWT_SECRET', 'a'.repeat(64), KEY_RULES.JWT_SECRET);
  assert.ok(issues.some((i) => i.code === 'low_entropy'));
});

test('verifyRotation reports rotated, unchanged and missing', () => {
  const previous = {
    OPENAI_API_KEY: 'sk-' + 'a'.repeat(40),
    JWT_SECRET: strongSecret(48),
  };
  const current = {
    OPENAI_API_KEY: 'sk-' + 'b'.repeat(40),
    JWT_SECRET: previous.JWT_SECRET, // not rotated
  };
  const report = verifyRotation({ current, previous });
  assert.ok(report.rotated.includes('OPENAI_API_KEY'));
  assert.ok(report.unchanged.includes('JWT_SECRET'));
  assert.ok(report.fingerprints.OPENAI_API_KEY.current);
  assert.notEqual(
    report.fingerprints.OPENAI_API_KEY.current,
    report.fingerprints.OPENAI_API_KEY.previous,
  );
});

test('verifyRotation marks ok=false when required key missing', () => {
  const report = verifyRotation({
    current: {},
    requiredKeys: ['OPENAI_API_KEY'],
  });
  assert.equal(report.ok, false);
  assert.ok(report.missing.includes('OPENAI_API_KEY'));
});

test('verifyRotation ok=true for clean rotation', () => {
  const previous = { ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(40) };
  const current = { ANTHROPIC_API_KEY: 'sk-ant-' + 'y'.repeat(40) };
  const report = verifyRotation({ current, previous, requiredKeys: ['ANTHROPIC_API_KEY'] });
  assert.equal(report.ok, true);
  assert.deepEqual(report.rotated, ['ANTHROPIC_API_KEY']);
});

test('verifyRotation does not leak secret values in report', () => {
  const secret = 'sk-' + 'z'.repeat(40);
  const report = verifyRotation({
    current: { OPENAI_API_KEY: secret },
    previous: { OPENAI_API_KEY: 'sk-' + 'q'.repeat(40) },
  });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(secret));
});

test('formatReport produces a single-line header plus issues', () => {
  const report = verifyRotation({
    current: { JWT_SECRET: 'aaaa' },
    requiredKeys: ['JWT_SECRET'],
  });
  const text = formatReport(report);
  assert.match(text, /secret-rotation: checked=/);
  assert.match(text, /JWT_SECRET/);
});

test('CLI script exits non-zero when required keys missing', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'verify-secret-rotation.js');
  const tmp = path.join(os.tmpdir(), `cur-${Date.now()}.env`);
  fs.writeFileSync(tmp, 'IRRELEVANT=1\n');
  try {
    const res = spawnSync(process.execPath, [
      script, '--current', tmp, '--required', 'OPENAI_API_KEY', '--json',
    ], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.missing.includes('OPENAI_API_KEY'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('CLI script exits zero on healthy rotation', () => {
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'scripts', 'verify-secret-rotation.js');
  const cur = path.join(os.tmpdir(), `cur-${Date.now()}.env`);
  const prev = path.join(os.tmpdir(), `prev-${Date.now()}.env`);
  fs.writeFileSync(cur, `ANTHROPIC_API_KEY=sk-ant-${'a'.repeat(40)}\n`);
  fs.writeFileSync(prev, `ANTHROPIC_API_KEY=sk-ant-${'b'.repeat(40)}\n`);
  try {
    const res = spawnSync(process.execPath, [
      script, '--current', cur, '--previous', prev,
      '--required', 'ANTHROPIC_API_KEY', '--json',
    ], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.rotated.includes('ANTHROPIC_API_KEY'));
  } finally {
    fs.unlinkSync(cur);
    fs.unlinkSync(prev);
  }
});
