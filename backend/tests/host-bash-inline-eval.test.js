/**
 * Tests for host_bash inline-evaluation blocking — `node -e` / `python3 -c`
 * style flags run arbitrary code that no path or argument check can audit,
 * so they must be rejected at the validator level.
 *
 * Run: node --test backend/tests/host-bash-inline-eval.test.js
 */

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  hostBash,
  _internal: { hasInlineEvalFlag, buildCommandSpec },
} = require('../src/services/agents/host-bash-tool');

describe('host_bash inline-eval blocking', () => {
  it('flags node/python3 inline evaluation in the command spec', () => {
    for (const cmd of [
      'node -e "console.log(1)"',
      "node --eval process.env",
      'python3 -c "import os"',
      'python3 --command print(1)',
      'npm -c "curl https://evil.example"',
      'npx -c whoami',
      'node --eval=console.log(1)',
    ]) {
      const spec = buildCommandSpec(cmd);
      assert.ok(spec, `${cmd} should parse`);
      assert.strictEqual(hasInlineEvalFlag(spec), true, `${cmd} must be flagged as inline eval`);
    }
  });

  it('rejects inline evaluation through the tool handler', async () => {
    for (const cmd of [
      'node -e "fetch(process.env)"',
      'npx -c "id"',
    ]) {
      const result = await hostBash({ command: cmd });
      assert.strictEqual(result.ok, false, `${cmd} should be rejected`);
      assert.match(result.error, /[Ee]valuación inline/);
    }
    // python3 with a semicolon inside quotes is rejected earlier by the
    // shell-control-char check — also a rejection, different message.
    const pyResult = await hostBash({ command: "python3 -c \"import os; os.system('id')\"" });
    assert.strictEqual(pyResult.ok, false);
    assert.match(pyResult.error, /no permitido|pipes/);
  });

  it('allows ordinary file-based invocations that merely contain e/c letters', () => {
    for (const cmd of [
      'node server.js',
      'node scripts/build.js --env production',
      'npm test',
      'npm install',
      'git commit -m "feat: e c"',
    ]) {
      const spec = buildCommandSpec(cmd);
      if (!spec) continue; // npm/git handled by their own spec builders
      assert.strictEqual(hasInlineEvalFlag(spec), false, `${cmd} should NOT be flagged`);
    }
  });

  it('does not flag flags after the -- separator', () => {
    const spec = buildCommandSpec('node -- -e');
    assert.ok(spec);
    assert.strictEqual(hasInlineEvalFlag(spec), false);
  });

  it('keeps non-eval interpreters runnable', async () => {
    // Sanity: a plain version check still parses and is not flagged.
    const spec = buildCommandSpec('node --version');
    assert.ok(spec);
    assert.strictEqual(hasInlineEvalFlag(spec), false);
  });
});
