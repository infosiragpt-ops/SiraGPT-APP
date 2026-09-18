'use strict';

/**
 * memory/connector-search + connector_search tool — searches the user's
 * connected Google Drive / Gmail with stored tokens, fails soft per source,
 * never leaks credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cs = require('../src/services/memory/connector-search');

function fakeGoogle({ files = [], messages = [] } = {}) {
  const calls = { drive: [], list: [], get: [] };
  return {
    calls,
    auth: { OAuth2: class { setCredentials(c) { this.credentials = c; } } },
    drive: () => ({ files: { list: async (args) => { calls.drive.push(args); return { data: { files } }; } } }),
    gmail: () => ({ users: { messages: {
      list: async (args) => { calls.list.push(args); return { data: { messages: messages.map((m) => ({ id: m.id })) } }; },
      get: async (args) => { calls.get.push(args); const m = messages.find((x) => x.id === args.id); return { data: { snippet: m.snippet, payload: { headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }, { name: 'Date', value: m.date }] } } }; },
    } } }),
  };
}

test.beforeEach(() => cs.resetForTests());

test('searchDrive: uses the stored Google Services tokens, escapes the query, bounds results', async () => {
  const google = fakeGoogle({ files: [{ id: 'f1', name: "Presupuesto O'Neil 2026", mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-09-01T00:00:00Z', webViewLink: 'https://docs.google.com/x' }] });
  cs.setDeps({ google, decrypt: (v) => v, log: { warn() {} }, prisma: { user: { findUnique: async () => ({ googleServicesTokens: JSON.stringify({ accessToken: 'at', refreshToken: 'rt' }) }) } } });
  const r = await cs.searchDrive('u1', "presupuesto o'neil", { limit: 99 });
  assert.equal(r.ok, true); assert.equal(r.results[0].title, "Presupuesto O'Neil 2026"); assert.equal(r.results[0].url, 'https://docs.google.com/x');
  assert.equal(google.calls.drive[0].pageSize, 20, 'limit clamped');
  assert.match(google.calls.drive[0].q, /name contains 'presupuesto o\\'neil'/);
  assert.doesNotMatch(JSON.stringify(r), /accessToken|refresh/);
});

test('searchDrive: not connected / invalid tokens / API failure all fail soft', async () => {
  cs.setDeps({ google: fakeGoogle(), decrypt: (v) => v, log: { warn() {} }, prisma: { user: { findUnique: async () => ({ googleServicesTokens: null }) } } });
  assert.deepEqual(await cs.searchDrive('u1', 'x'), { source: 'drive', ok: false, error: 'not_connected', results: [] });
  cs.setDeps({ decrypt: () => { throw new Error('bad'); }, prisma: { user: { findUnique: async () => ({ googleServicesTokens: 'enc' }) } } });
  assert.equal((await cs.searchDrive('u1', 'x')).error, 'tokens_invalid');
  cs.setDeps({ decrypt: (v) => v, google: { auth: { OAuth2: class { setCredentials() {} } }, drive: () => ({ files: { list: async () => { throw new Error('403'); } } }) }, prisma: { user: { findUnique: async () => ({ googleServicesTokens: JSON.stringify({ accessToken: 'a' }) }) } } });
  assert.equal((await cs.searchDrive('u1', 'x')).error, 'drive_failed');
});

test('searchGmail: lists + fetches metadata with snippets; a missing connection is reported by code', async () => {
  const google = fakeGoogle({ messages: [{ id: 'm1', subject: 'Factura septiembre', from: 'ana@x.com', date: 'Tue, 1 Sep 2026', snippet: 'Adjunto la  factura   del mes' }] });
  const gmailPath = require.resolve('../src/services/gmail-user-client');
  const real = require.cache[gmailPath];
  require.cache[gmailPath] = { exports: { loadGmailClientForUser: async ({ userId }) => { if (userId === 'nobody') { const e = new Error('no'); e.code = 'gmail_not_connected'; throw e; } return { client: { fake: true }, tokens: {} }; } } };
  try {
    cs.setDeps({ google, log: { warn() {} }, prisma: { user: { findUnique: async () => null } } });
    const r = await cs.searchGmail('u1', 'factura', { limit: 5 });
    assert.equal(r.ok, true); assert.equal(r.results[0].subject, 'Factura septiembre'); assert.equal(r.results[0].snippet, 'Adjunto la factura del mes');
    assert.equal(google.calls.list[0].q, 'factura'); assert.equal(google.calls.get[0].format, 'metadata');
    assert.equal((await cs.searchGmail('nobody', 'factura')).error, 'gmail_not_connected');
  } finally {
    if (real) require.cache[gmailPath] = real; else delete require.cache[gmailPath];
  }
});

test('searchConnectors fans out, ok when any source answers, rejects unknown sources', async () => {
  cs.setDeps({ google: fakeGoogle({ files: [{ id: 'f', name: 'Doc' }] }), decrypt: (v) => v, log: { warn() {} }, prisma: { user: { findUnique: async () => ({ googleServicesTokens: JSON.stringify({ accessToken: 'a' }), gmailTokens: null }) } } });
  const r = await cs.searchConnectors('u1', 'doc', { sources: ['drive', 'gmail', 'notion'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sources.map((s) => `${s.source}:${s.ok}`), ['drive:true', 'gmail:false']);
  assert.equal((await cs.searchConnectors('u1', 'doc', { sources: ['notion'] })).error, 'no_valid_sources');
});

test('connector_search tool is user-scoped and wired into the agentic toolset', async () => {
  const tools = require('../src/services/agents/memory-tools');
  assert.ok(tools.MEMORY_TOOL_NAMES.includes('connector_search'));
  const r0 = await tools.connectorSearch.execute({ query: 'x' }, {});
  assert.equal(r0.ok, false);
  cs.setDeps({ google: fakeGoogle({ files: [{ id: 'f', name: 'Plan Q4', webViewLink: 'u' }] }), decrypt: (v) => v, log: { warn() {} }, prisma: { user: { findUnique: async () => ({ googleServicesTokens: JSON.stringify({ accessToken: 'a' }), gmailTokens: null }) } } });
  const r = await tools.connectorSearch.execute({ query: 'plan q4', sources: ['drive'] }, { userId: 'u1' });
  assert.equal(r.ok, true); assert.equal(r.sources[0].results[0].title, 'Plan Q4');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'), 'utf8');
  assert.match(src, /'connector_search'/);
  assert.match(src, /connector_search: \(args\)/);
});
