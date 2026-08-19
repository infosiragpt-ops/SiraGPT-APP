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
