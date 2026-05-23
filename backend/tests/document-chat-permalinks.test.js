'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-chat-permalinks');
const { extractChatPermalinks, buildChatPermalinksForFiles, renderChatPermalinksBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractChatPermalinks('').total, 0);
  assert.equal(extractChatPermalinks(null).total, 0);
});

test('detects Slack message URL', () => {
  const r = extractChatPermalinks('https://myteam.slack.com/archives/C01ABCDEFGH/p1234567890123456');
  assert.ok(r.entries.some((e) => e.platform === 'slack' && e.context === 'message'));
});

test('detects Slack threaded URL', () => {
  const r = extractChatPermalinks(
    'https://myteam.slack.com/archives/C01ABCDEFGH/p1234567890123456?thread_ts=1234567890.123456'
  );
  assert.ok(r.entries.some((e) => e.platform === 'slack' && e.context === 'thread'));
});

test('detects Discord channel message', () => {
  const r = extractChatPermalinks('https://discord.com/channels/123456789012345678/234567890123456789/345678901234567890');
  assert.ok(r.entries.some((e) => e.platform === 'discord' && e.context === 'channel'));
});

test('detects Discord DM', () => {
  const r = extractChatPermalinks('https://discord.com/channels/@me/234567890123456789/345678901234567890');
  assert.ok(r.entries.some((e) => e.platform === 'discord' && e.context === 'dm'));
});

test('detects Notion page URL', () => {
  const r = extractChatPermalinks('https://www.notion.so/myworkspace/My-Page-abc123def456ghi789jkl012mno345pq');
  assert.ok(r.entries.some((e) => e.platform === 'notion'));
});

test('detects Microsoft Teams message URL', () => {
  const r = extractChatPermalinks(
    'https://teams.microsoft.com/l/message/19:abc.def@thread.skype/1234567890123'
  );
  assert.ok(r.entries.some((e) => e.platform === 'teams'));
});

test('detects Telegram channel post', () => {
  const r = extractChatPermalinks('https://t.me/mychannel/12345');
  assert.ok(r.entries.some((e) => e.platform === 'telegram'));
});

test('dedupes identical permalinks', () => {
  const link = 'https://myteam.slack.com/archives/C01ABCDEFGH/p1234567890123456';
  const r = extractChatPermalinks(`${link} and again ${link}`);
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += `https://team${i}.slack.com/archives/C01ABCDEFGH/p${(1000000000000000 + i).toString()} `;
  }
  const r = extractChatPermalinks(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by platform', () => {
  const r = extractChatPermalinks(
    'https://team.slack.com/archives/C01ABCDEFGH/p1234567890123456 and https://t.me/ch/1'
  );
  assert.ok(r.totals.slack >= 1);
  assert.ok(r.totals.telegram >= 1);
});

test('buildChatPermalinksForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'https://team.slack.com/archives/C01ABCDEFGH/p1234567890123456' },
    { name: 'b', extractedText: 'https://t.me/mychannel/12345' },
  ];
  const r = buildChatPermalinksForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderChatPermalinksBlock returns markdown when entries exist', () => {
  const files = [{ name: 'msg', extractedText: 'https://team.slack.com/archives/C01ABCDEFGH/p1234567890123456' }];
  const r = buildChatPermalinksForFiles(files);
  const md = renderChatPermalinksBlock(r);
  assert.match(md, /^## CHAT PLATFORM/);
});

test('renderChatPermalinksBlock empty when nothing surfaces', () => {
  assert.equal(renderChatPermalinksBlock({ perFile: [] }), '');
  assert.equal(renderChatPermalinksBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildChatPermalinksForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'https://team.slack.com/archives/C01ABCDEFGH/p1234567890123456' },
  ]);
  assert.equal(r.perFile.length, 1);
});
