'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const slack = require('../src/services/slack-integration');

describe('slack-integration · buildBlocks', () => {
  test('produces a Block-kit body with header + context + section', () => {
    const body = slack.buildBlocks({ event: 'chat.created', userId: 'u1', payload: { chatId: 'c1' } });
    assert.equal(body.text, 'SiraGPT: chat.created');
    assert.equal(body.blocks[0].type, 'header');
    assert.equal(body.blocks[1].type, 'context');
    assert.equal(body.blocks[2].type, 'section');
    assert.match(body.blocks[2].text.text, /chatId/);
  });

  test('truncates long payloads to 240 chars', () => {
    const huge = { data: 'x'.repeat(1000) };
    const body = slack.buildBlocks({ event: 'big.event', userId: 'u1', payload: huge });
    assert.ok(body.blocks[2].text.text.length < 260);
  });
});

describe('slack-integration · encrypt/decrypt round trip', () => {
  test('decrypt(encrypt(x)) === x', () => {
    const plain = 'https://hooks.slack.com/services/AAA/BBB/CCC';
    const cipher = slack.encryptToken(plain);
    assert.notEqual(cipher, plain);
    const decrypted = slack.decryptToken(cipher);
    assert.equal(decrypted, plain);
  });

  test('decrypt(invalid) returns null', () => {
    assert.equal(slack.decryptToken('not-base64-cipher'), null);
    assert.equal(slack.decryptToken(''), null);
  });
});

describe('slack-integration · sendEventNotification', () => {
  test('posts JSON to webhook URL with correct headers', async () => {
    let captured = null;
    const fakeFetch = async (url, opts) => {
      captured = { url, opts };
      return { ok: true, status: 200 };
    };
    const out = await slack.sendEventNotification({
      webhookUrl: 'https://hooks.slack.com/services/X/Y/Z',
      event: 'chat.created',
      userId: 'u1',
      payload: { chatId: 'c1' },
      fetch: fakeFetch,
    });
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.equal(captured.url, 'https://hooks.slack.com/services/X/Y/Z');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers['Content-Type'], 'application/json');
    const parsed = JSON.parse(captured.opts.body);
    assert.ok(Array.isArray(parsed.blocks));
  });
});

// Prod 2026-09-28: with no SLACK_/SIRAGPT_ENCRYPTION_KEY the key was random
// per process, so every deploy made the saved webhooks undecryptable.
describe('slack-integration · key source survives restarts', () => {
  const KEY_ENV = ['SLACK_ENCRYPTION_KEY', 'SIRAGPT_ENCRYPTION_KEY', 'ENCRYPTION_KEY', 'NODE_ENV'];
  const modulePath = require.resolve('../src/services/slack-integration');
  const PLAIN = 'https://hooks.slack.com/services/T1/B2/restart';

  function withEnv(overrides, fn) {
    const saved = {};
    for (const name of KEY_ENV) saved[name] = process.env[name];
    for (const name of KEY_ENV) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
    try {
      return fn();
    } finally {
      for (const name of KEY_ENV) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      delete require.cache[modulePath];
    }
  }

  // A "restart": a fresh module instance with an empty key cache.
  function freshModule() {
    delete require.cache[modulePath];
    return require(modulePath);
  }

  test('with only ENCRYPTION_KEY, ciphertext decrypts after a restart', () => {
    withEnv({ ENCRYPTION_KEY: 'a'.repeat(64), NODE_ENV: 'production' }, () => {
      const cipher = freshModule().encryptToken(PLAIN);
      assert.equal(freshModule().decryptToken(cipher), PLAIN);
    });
  });

  test('the ENCRYPTION_KEY subkey is not the raw master key (HKDF, no key reuse)', () => {
    withEnv({ ENCRYPTION_KEY: 'b'.repeat(64) }, () => {
      const cipher = freshModule().encryptToken(PLAIN);
      withEnv({ SLACK_ENCRYPTION_KEY: 'b'.repeat(64) }, () => {
        assert.equal(freshModule().decryptToken(cipher), null);
      });
    });
  });

  test('SLACK_ENCRYPTION_KEY wins over SIRAGPT_ENCRYPTION_KEY, which wins over ENCRYPTION_KEY', () => {
    let slackCipher;
    withEnv({ SLACK_ENCRYPTION_KEY: 'c'.repeat(64), SIRAGPT_ENCRYPTION_KEY: 'd'.repeat(64), ENCRYPTION_KEY: 'e'.repeat(64) }, () => {
      slackCipher = freshModule().encryptToken(PLAIN);
    });
    withEnv({ SLACK_ENCRYPTION_KEY: 'c'.repeat(64) }, () => {
      assert.equal(freshModule().decryptToken(slackCipher), PLAIN);
    });

    let siragptCipher;
    withEnv({ SIRAGPT_ENCRYPTION_KEY: 'd'.repeat(64), ENCRYPTION_KEY: 'e'.repeat(64) }, () => {
      siragptCipher = freshModule().encryptToken(PLAIN);
    });
    withEnv({ SIRAGPT_ENCRYPTION_KEY: 'd'.repeat(64) }, () => {
      assert.equal(freshModule().decryptToken(siragptCipher), PLAIN);
    });
  });

  test('production with no key throws slack_encryption_unconfigured (never a per-process key)', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      const slackModule = freshModule();
      assert.throws(() => slackModule.encryptToken(PLAIN), (err) => {
        assert.equal(err.code, 'slack_encryption_unconfigured');
        assert.equal(err.status, 503);
        assert.match(err.message, /clave de cifrado/);
        return true;
      });
      const failure = slackModule.webhookDecryptFailure();
      assert.equal(failure.status, 503);
      assert.equal(failure.body.code, 'slack_encryption_unconfigured');
    });
  });

  test('outside production with no key a per-process key still round-trips', () => {
    withEnv({ NODE_ENV: 'test' }, () => {
      const slackModule = freshModule();
      assert.equal(slackModule.decryptToken(slackModule.encryptToken(PLAIN)), PLAIN);
      const failure = slackModule.webhookDecryptFailure();
      assert.equal(failure.status, 409);
      assert.equal(failure.body.code, 'slack_reconnect_required');
      assert.match(failure.body.message, /vuelve a pegar el webhook/);
    });
  });
});
