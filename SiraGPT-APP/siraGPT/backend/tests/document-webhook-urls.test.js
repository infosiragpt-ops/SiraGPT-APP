'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-webhook-urls');
const { extractWebhookUrls, buildWebhookUrlsForFiles, renderWebhookUrlsBlock, _internal } = engine;
const { maskToken } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractWebhookUrls('').total, 0);
  assert.equal(extractWebhookUrls(null).total, 0);
});

test('maskToken: first-4 last-4', () => {
  assert.equal(maskToken('abcdef1234567890'), 'abcd…7890');
  assert.equal(maskToken('xx'), '****');
});

test('detects Slack incoming webhook', () => {
  const r = extractWebhookUrls('https://hooks.slack.com/services/T01ABC23DE/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwXy');
  assert.ok(r.entries.some((e) => e.provider === 'slack'));
});

test('Slack token is masked', () => {
  const r = extractWebhookUrls('https://hooks.slack.com/services/T01ABC23DE/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwXy');
  for (const e of r.entries) {
    assert.ok(!/aBcDeFgHiJkLmNoPqRsTuVwXy/.test(e.masked));
  }
});

test('detects Discord webhook', () => {
  const r = extractWebhookUrls(
    'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZ012'
  );
  assert.ok(r.entries.some((e) => e.provider === 'discord'));
});

test('Discord token is masked', () => {
  const r = extractWebhookUrls(
    'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZ012'
  );
  for (const e of r.entries) {
    assert.ok(!/aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZ012/.test(e.masked));
  }
});

test('detects Teams webhook', () => {
  const r = extractWebhookUrls(
    'https://outlook.office.com/webhook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/IncomingWebhook/1234567890abcdef1234567890abcdef/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  );
  assert.ok(r.entries.some((e) => e.provider === 'teams'));
});

test('detects GitHub hooks listing URL', () => {
  const r = extractWebhookUrls('https://api.github.com/repos/myorg/myrepo/hooks');
  assert.ok(r.entries.some((e) => e.provider === 'github' && e.context === 'list'));
});

test('detects GitHub specific hook URL', () => {
  const r = extractWebhookUrls('https://api.github.com/repos/myorg/myrepo/hooks/12345678');
  assert.ok(r.entries.some((e) => e.provider === 'github' && e.context === 'specific'));
});

test('detects generic webhook URL', () => {
  const r = extractWebhookUrls('https://api.example.com/webhook/abcdef1234567890abcdef1234567890');
  assert.ok(r.entries.some((e) => e.provider === 'generic'));
});

test('dedupes identical masked URLs', () => {
  const r = extractWebhookUrls(
    'https://hooks.slack.com/services/T01ABC23DE/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwXy and again ' +
    'https://hooks.slack.com/services/T01ABC23DE/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwXy'
  );
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += `https://hooks.slack.com/services/T${i.toString().padStart(8, '0')}/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwX${i} `;
  }
  const r = extractWebhookUrls(text);
  assert.ok(r.entries.length <= 12);
});

test('counts totals by provider', () => {
  const r = extractWebhookUrls(
    'https://hooks.slack.com/services/T01ABC23DE/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwXy and ' +
    'https://api.github.com/repos/o/r/hooks'
  );
  assert.ok(r.totals.slack >= 1);
  assert.ok(r.totals.github >= 1);
});

test('buildWebhookUrlsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'https://hooks.slack.com/services/T01ABC23DE/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwXy' },
    { name: 'b', extractedText: 'https://api.github.com/repos/o/r/hooks' },
  ];
  const r = buildWebhookUrlsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWebhookUrlsBlock NEVER contains the full token', () => {
  const files = [{
    name: 'env',
    extractedText: 'https://hooks.slack.com/services/T01ABC23DE/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwXy',
  }];
  const r = buildWebhookUrlsForFiles(files);
  const md = renderWebhookUrlsBlock(r);
  assert.ok(!/aBcDeFgHiJkLmNoPqRsTuVwXy/.test(md));
});

test('renderWebhookUrlsBlock empty when nothing surfaces', () => {
  assert.equal(renderWebhookUrlsBlock({ perFile: [] }), '');
  assert.equal(renderWebhookUrlsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWebhookUrlsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'https://hooks.slack.com/services/T01ABC23DE/B01ABC23DE/aBcDeFgHiJkLmNoPqRsTuVwXy' },
  ]);
  assert.equal(r.perFile.length, 1);
});
