'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-bot-tokens');
const { extractBotTokens, buildBotTokensForFiles, renderBotTokensBlock, _internal } = engine;
const { maskToken } = _internal;

// Build synthetic tokens at runtime to avoid GitHub Push Protection false positives
const TG_TOKEN = '123456789:' + 'A'.repeat(35);
const SLACK_BOT = ['x', 'o', 'x', 'b'].join('') + '-1234567890-9876543210-' + 'A'.repeat(24);
const SLACK_USER = ['x', 'o', 'x', 'p'].join('') + '-1234567890-9876543210-1357924680-' + 'A'.repeat(24);
const SLACK_APP = ['x', 'a', 'p', 'p'].join('') + '-1-A1B2C3D4E5F6-1234567890-' + 'A'.repeat(60);

test('empty / non-string tolerated', () => {
  assert.equal(extractBotTokens('').total, 0);
  assert.equal(extractBotTokens(null).total, 0);
});

test('maskToken returns first-4 last-4', () => {
  assert.match(maskToken('abcdefghijklmnopqrst'), /^abcd…qrst/);
});

test('detects Telegram bot token', () => {
  const r = extractBotTokens(`TELEGRAM_TOKEN=${TG_TOKEN}`);
  assert.ok(r.entries.some((e) => e.platform === 'telegram'));
});

test('Telegram token is masked', () => {
  const r = extractBotTokens(TG_TOKEN);
  for (const e of r.entries) {
    assert.ok(!new RegExp('A{30}').test(e.masked));
  }
});

test('detects Slack bot token (xoxb)', () => {
  const r = extractBotTokens(`SLACK_BOT_TOKEN=${SLACK_BOT}`);
  assert.ok(r.entries.some((e) => e.platform === 'slackBot'));
});

test('detects Slack user token (xoxp)', () => {
  const r = extractBotTokens(SLACK_USER);
  assert.ok(r.entries.some((e) => e.platform === 'slackUser'));
});

test('detects Slack app-level token (xapp)', () => {
  const r = extractBotTokens(SLACK_APP);
  assert.ok(r.entries.some((e) => e.platform === 'slackApp'));
});

test('detects Discord token (labeled)', () => {
  const tok = 'A'.repeat(60);
  const r = extractBotTokens(`DISCORD_TOKEN: ${tok}`);
  assert.ok(r.entries.some((e) => e.platform === 'discord'));
});

test('dedupes identical tokens', () => {
  const r = extractBotTokens(`${TG_TOKEN} and ${TG_TOKEN}`);
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 15; i++) {
    text += `${1000000 + i}:${'A'.repeat(35)} `;
  }
  const r = extractBotTokens(text);
  assert.ok(r.entries.length <= 12);
});

test('counts totals by platform', () => {
  const r = extractBotTokens(`${TG_TOKEN} and ${SLACK_BOT}`);
  assert.ok(r.totals.telegram >= 1);
  assert.ok(r.totals.slackBot >= 1);
});

test('buildBotTokensForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: TG_TOKEN },
    { name: 'b', extractedText: SLACK_BOT },
  ];
  const r = buildBotTokensForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBotTokensBlock NEVER contains full token', () => {
  const files = [{ name: 'env', extractedText: TG_TOKEN }];
  const r = buildBotTokensForFiles(files);
  const md = renderBotTokensBlock(r);
  assert.ok(!new RegExp('A{30}').test(md));
});

test('renderBotTokensBlock empty when nothing surfaces', () => {
  assert.equal(renderBotTokensBlock({ perFile: [] }), '');
  assert.equal(renderBotTokensBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBotTokensForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: TG_TOKEN },
  ]);
  assert.equal(r.perFile.length, 1);
});
