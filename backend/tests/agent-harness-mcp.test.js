'use strict';

/**
 * agent-harness MCP client — namespacing, result normalization, third-party
 * schema sanitization, server registration validation and header crypto.
 * (Live transport behavior is exercised manually against a public MCP
 * server; these tests pin the pure logic that must never regress.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugifyServerName,
  normalizeCallResult,
  sanitizeInputSchema,
  validateServerInput,
  encryptHeaders,
  decryptHeaders,
  loadUserMcpTools,
} = require('../src/services/agent-harness/mcp-client');

test('mcp: server names slugify into stable namespaces', () => {
  assert.equal(slugifyServerName('DeepWiki Docs!'), 'deepwiki_docs');
  assert.equal(slugifyServerName('  Mi Servidor (β) '), 'mi_servidor');
  assert.equal(slugifyServerName(''), 'server');
});

test('mcp: call results normalize to compact text + structured payloads', () => {
  const ok = normalizeCallResult({
    content: [
      { type: 'text', text: 'línea 1' },
      { type: 'text', text: 'línea 2' },
      { type: 'image', data: 'x' },
    ],
    structuredContent: { a: 1 },
  });
  assert.equal(ok.text, 'línea 1\nlínea 2');
  assert.deepEqual(ok.structured, { a: 1 });
  assert.deepEqual(ok.nonTextParts, [{ type: 'image' }]);

  const errored = normalizeCallResult({ isError: true, content: [{ type: 'text', text: 'boom' }] });
  assert.equal(errored.error, 'boom');

  const huge = normalizeCallResult({ content: [{ type: 'text', text: 'z'.repeat(120_000) }] });
  assert.ok(huge.text.length < 31_000);
  assert.match(huge.text, /truncated/);
});

test('mcp: third-party input schemas are coerced into AJV/OpenAI-safe objects', () => {
  assert.deepEqual(
    sanitizeInputSchema(null),
    { type: 'object', properties: {}, additionalProperties: true },
  );
  const coerced = sanitizeInputSchema({ type: 'string' });
  assert.equal(coerced.type, 'object');
  const cleaned = sanitizeInputSchema({ $schema: 'http://x', type: 'object', properties: { q: { type: 'string' } } });
  assert.equal(cleaned.type, 'object');
  assert.ok(cleaned.properties.q);
});

test('mcp: registration validation — schemes, private hosts and shape', () => {
  assert.equal(validateServerInput({ name: 'docs', url: 'https://mcp.example.com/mcp' }).ok, true);
  assert.equal(validateServerInput({ name: 'docs', url: 'ftp://mcp.example.com' }).ok, false);
  assert.equal(validateServerInput({ name: '', url: 'https://x.com' }).ok, false);
  assert.equal(validateServerInput({ name: 'docs', url: 'not-a-url' }).ok, false);
  const priv = validateServerInput({ name: 'lan', url: 'http://192.168.1.50:8080/mcp' });
  assert.equal(priv.ok, false);
  assert.match(priv.error, /private|localhost/i);
  const localhost = validateServerInput({ name: 'dev', url: 'http://localhost:3845/mcp' });
  assert.equal(localhost.ok, false);
  const transport = validateServerInput({ name: 'docs', url: 'https://x.com/mcp', transport: 'sse' });
  assert.equal(transport.ok, true);
  assert.equal(transport.data.transport, 'sse');
});

test('mcp: auth headers roundtrip through AES encryption and never store plaintext', (t) => {
  const prev = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  t.after(() => { if (prev === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = prev; });

  assert.equal(encryptHeaders(null), null);
  assert.equal(encryptHeaders({}), null);
  const sealed = encryptHeaders({ authorization: 'Bearer secreto-123' });
  assert.ok(sealed && !sealed.includes('secreto-123'), 'ciphertext must not contain the secret');
  assert.deepEqual(decryptHeaders(sealed), { authorization: 'Bearer secreto-123' });
  assert.deepEqual(decryptHeaders('garbage'), {}, 'corrupt ciphertext degrades to no headers');
});

test('mcp: discovery degrades to zero tools without prisma or rows — never throws', async () => {
  assert.deepEqual(await loadUserMcpTools({ userId: null, prisma: null }), { tools: [], errors: [] });
  assert.deepEqual(await loadUserMcpTools({ userId: 'u1', prisma: {} }), { tools: [], errors: [] });
  const failing = { mcpServer: { findMany: async () => { throw new Error('db down'); } } };
  const out = await loadUserMcpTools({ userId: 'u1', prisma: failing });
  assert.equal(out.tools.length, 0);
  assert.equal(out.errors.length, 1);
});

test('mcp: unreachable servers are skipped with an error entry, chat keeps its tools', async () => {
  const prisma = {
    mcpServer: {
      findMany: async () => [{
        id: 's1',
        name: 'down server',
        url: 'https://127.0.0.1:1/mcp', // connection refused instantly
        transport: 'streamable-http',
        headersEncrypted: null,
        updatedAt: new Date(),
      }],
    },
  };
  const out = await loadUserMcpTools({ userId: 'u1', prisma });
  assert.equal(out.tools.length, 0);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].server, 'down server');
});
