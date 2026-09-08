'use strict';

/**
 * local-sandbox env guard — the child process must NEVER see the backend's
 * credentials. Regression for the P1 audit finding: executeLocal used to
 * pass `{ ...process.env, NODE_OPTIONS: '' }` straight to spawn, so any
 * sandbox_bash/python run could read DATABASE_URL, API tokens, etc.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const local = require('../src/services/sandbox/local-sandbox');

test('buildChildEnv drops secrets and keeps only the allowlist', () => {
  const fakeEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    PYTHONPATH: '/opt/pylibs',
    DATABASE_URL: 'postgres://user:pw@host/db',
    OPENAI_API_KEY: 'sk-leak-me',
    CODE_RUNNER_CONTROL_TOKEN: 'tok',
    AWS_SECRET_ACCESS_KEY: 'sekret',
    SIRAGPT_SESSION_COOKIE: 'sid=xyz',
  };
  const childEnv = local.buildChildEnv(fakeEnv);

  assert.equal(childEnv.PATH, '/usr/bin:/bin');
  assert.equal(childEnv.LANG, 'C.UTF-8');
  assert.equal(childEnv.PYTHONPATH, '/opt/pylibs');
  assert.equal(childEnv.DATABASE_URL, undefined);
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
  assert.equal(childEnv.CODE_RUNNER_CONTROL_TOKEN, undefined);
  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(childEnv.SIRAGPT_SESSION_COOKIE, undefined);
  assert.ok(childEnv.HOME && childEnv.HOME.includes('sira-home'));
});

test('real node child cannot observe backend secrets via process.env', async () => {
  const out = await local.executeLocal({
    code: `
      const keys = Object.keys(process.env).join(',');
      const leaked = ['DATABASE_URL','OPENAI_API_KEY','SIRA_CANARY_SECRET']
        .filter((k) => process.env[k] != null);
      process.stdout.write('KEYS=' + keys + '|LEAKED=' + leaked.join(','));
      if (leaked.length > 0) process.exit(7);
    `,
    language: 'node',
    timeoutMs: 10_000,
  }, {
    ...process.env,
    DATABASE_URL: 'postgres://canary:pw@host/db',
    OPENAI_API_KEY: 'sk-canary',
    SIRA_CANARY_SECRET: 'canary-value',
  });

  assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
  assert.ok(out.stdout.startsWith('KEYS='), `unexpected stdout: ${out.stdout}`);
  assert.match(out.stdout, /LEAKED=$/);
});
