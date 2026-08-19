/**
 * Tests for github-actions-tool.
 *
 * Run: node --test backend/tests/github-actions-tool.test.js
 */

const assert = require('node:assert');
const { describe, it } = require('node:test');

const actionsTool = require('../src/services/agents/github-actions-tool');
const internal = actionsTool._internal;

describe('github-actions-tool', () => {
  it('parseRepository accepts owner/repo and github URLs only', () => {
    assert.deepStrictEqual(internal.parseRepository('SiraGPT-ORg/siraGPT'), {
      owner: 'SiraGPT-ORg',
      repo: 'siraGPT',
      fullName: 'SiraGPT-ORg/siraGPT',
    });
    assert.deepStrictEqual(internal.parseRepository('https://github.com/SiraGPT-ORg/siraGPT.git'), {
      owner: 'SiraGPT-ORg',
      repo: 'siraGPT',
      fullName: 'SiraGPT-ORg/siraGPT',
    });
    assert.strictEqual(internal.parseRepository('https://gitlab.com/a/b'), null);
    assert.strictEqual(internal.parseRepository('../bad/repo'), null);
  });

  it('normalizes branch and SHA inputs safely', () => {
    assert.strictEqual(internal.normalizeBranch('main'), 'main');
    assert.strictEqual(internal.normalizeBranch('feature/repo-tools'), 'feature/repo-tools');
    assert.strictEqual(internal.normalizeBranch('feature..escape'), null);
    assert.strictEqual(internal.normalizeSha('abcdef1'), 'abcdef1');
    assert.strictEqual(internal.normalizeSha('not-a-sha'), null);
  });

  it('checkGithubActions summarizes green run for branch and commit', async () => {
    const result = await actionsTool.checkGithubActions({
      repository: 'SiraGPT-ORg/siraGPT',
      branch: 'main',
      commitSha: 'abc1234',
    }, {
      fetchJson: async () => ({
        workflow_runs: [
          { id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_sha: 'abc1234', html_url: 'https://example.com/run/1' },
        ],
      }),
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.green, true);
    assert.strictEqual(result.runId, 1);
    assert.match(result.message, /CI verde/);
  });

  it('checkGithubActions reports failed run without pretending green', async () => {
    const result = await actionsTool.checkGithubActions({
      repository: 'SiraGPT-ORg/siraGPT',
      branch: 'main',
    }, {
      fetchJson: async () => ({
        workflow_runs: [
          { id: 2, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: 'def5678' },
        ],
      }),
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.green, false);
    assert.strictEqual(result.failed, true);
    assert.strictEqual(result.conclusion, 'failure');
  });

  it('monitorGithubActions polls until green', async () => {
    let calls = 0;
    const result = await actionsTool.monitorGithubActions({
      repository: 'SiraGPT-ORg/siraGPT',
      branch: 'main',
      timeoutSeconds: 10,
      intervalSeconds: 1,
    }, {
      sleep: async () => {},
      fetchJson: async () => {
        calls += 1;
        return {
          workflow_runs: [
            calls === 1
              ? { id: 3, name: 'CI', status: 'in_progress', conclusion: null, head_sha: 'fff1111' }
              : { id: 3, name: 'CI', status: 'completed', conclusion: 'success', head_sha: 'fff1111' },
          ],
        };
      },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.green, true);
    assert.strictEqual(result.attempts, 2);
  });

  it('tool definitions expose expected names', () => {
    assert.strictEqual(actionsTool.checkCiStatusTool.name, 'check_ci_status');
    assert.strictEqual(actionsTool.monitorCiTool.name, 'monitor_ci');
    assert.ok(actionsTool.checkCiStatusTool.parameters.required.includes('repository'));
    assert.ok(actionsTool.monitorCiTool.parameters.required.includes('repository'));
  });
});
