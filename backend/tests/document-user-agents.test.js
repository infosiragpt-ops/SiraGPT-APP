'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-user-agents');
const { extractUserAgents, buildUserAgentsForFiles, renderUserAgentsBlock, _internal } = engine;
const { classify, nameOf } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractUserAgents('').total, 0);
  assert.equal(extractUserAgents(null).total, 0);
});

test('classify: browser vs mobile vs bot', () => {
  assert.equal(classify('Mozilla/5.0 (X11) Chrome/120.0.0.0'), 'browser');
  assert.equal(classify('Mozilla/5.0 (iPhone) Safari/600'), 'mobile');
  assert.equal(classify('Googlebot/2.1'), 'bot');
});

test('nameOf: Chrome / Firefox / Safari', () => {
  assert.equal(nameOf('Mozilla/5.0 (X11) Chrome/120.0.0.0 Safari/537.36'), 'Chrome');
  assert.equal(nameOf('Mozilla/5.0 (X11) Firefox/121.0'), 'Firefox');
  assert.equal(nameOf('curl/7.81.0'), 'curl');
});

test('detects Mozilla UA string', () => {
  const r = extractUserAgents('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0');
  assert.ok(r.entries.some((e) => e.kind === 'browser'));
});

test('detects curl/N.N.N library UA', () => {
  const r = extractUserAgents('Got request from curl/7.81.0 today');
  assert.ok(r.entries.some((e) => e.kind === 'library' && e.name === 'curl'));
});

test('detects python-requests library UA', () => {
  const r = extractUserAgents('UA: python-requests/2.31.0');
  assert.ok(r.entries.some((e) => e.kind === 'library'));
});

test('detects Googlebot', () => {
  const r = extractUserAgents('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
  assert.ok(r.entries.some((e) => e.kind === 'bot'));
});

test('detects mobile Safari', () => {
  const r = extractUserAgents('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Safari/602');
  assert.ok(r.entries.some((e) => e.kind === 'mobile'));
});

test('detects GPTBot / ClaudeBot / PerplexityBot AI crawlers', () => {
  const r = extractUserAgents('UA seen: GPTBot/1.0 and ClaudeBot');
  assert.ok(r.entries.filter((e) => e.kind === 'bot').length >= 2);
});

test('dedupes identical UAs', () => {
  const r = extractUserAgents('curl/7.81.0 and curl/7.81.0 again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `curl/7.81.${i} `;
  const r = extractUserAgents(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by kind', () => {
  const r = extractUserAgents(
    'Mozilla/5.0 (X11) Chrome/120 then curl/7.81.0 then Googlebot/2.1'
  );
  assert.ok(r.totals.bot >= 1);
  assert.ok(r.totals.library >= 1);
});

test('buildUserAgentsForFiles aggregates across batch', () => {
  const files = [
    { name: 'log1', extractedText: 'curl/7.81.0' },
    { name: 'log2', extractedText: 'Mozilla/5.0 Chrome/120' },
  ];
  const r = buildUserAgentsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderUserAgentsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'log', extractedText: 'curl/7.81.0' }];
  const r = buildUserAgentsForFiles(files);
  const md = renderUserAgentsBlock(r);
  assert.match(md, /^## USER-AGENT/);
});

test('renderUserAgentsBlock empty when nothing surfaces', () => {
  assert.equal(renderUserAgentsBlock({ perFile: [] }), '');
  assert.equal(renderUserAgentsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildUserAgentsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'curl/7.81.0' },
  ]);
  assert.equal(r.perFile.length, 1);
});
