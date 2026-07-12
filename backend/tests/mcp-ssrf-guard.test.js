'use strict';

// Connect-time SSRF guard for user-registered MCP servers. Verifies that
// assertMcpHostSafe re-resolves the host and blocks private/reserved IPs
// (DNS-rebinding defence). Legacy bypass flags must remain inert.
//
// NOTE: requires mcp-client (which pulls zod), so this runs under CI /
// the built image, not the bare worktree. Behaviour is also verified
// directly inside the production image at deploy time.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../src/services/agent-harness/mcp-client');

// dns.lookup(host, {all:true}) → [{ address, family }]
const lookupTo = (...ips) => async () => ips.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));

beforeEach(() => {
  delete process.env.SIRAGPT_MCP_ALLOW_PRIVATE;
  delete process.env.SIRAGPT_MCP_SSRF_GUARD;
});

test('allows a host that resolves to a public IP', async () => {
  await assert.doesNotReject(() => mcp.assertMcpHostSafe('example.com', { lookup: lookupTo('93.184.216.34') }));
});

test('blocks hosts that resolve to private / reserved IPs (DNS rebinding)', async () => {
  await assert.rejects(() => mcp.assertMcpHostSafe('rebind.example', { lookup: lookupTo('169.254.169.254') }));
  await assert.rejects(() => mcp.assertMcpHostSafe('rebind.example', { lookup: lookupTo('10.0.0.5') }));
  await assert.rejects(() => mcp.assertMcpHostSafe('rebind.example', { lookup: lookupTo('127.0.0.1') }));
  await assert.rejects(() => mcp.assertMcpHostSafe('rebind.example', { lookup: lookupTo('192.168.1.10') }));
});

test('SIRAGPT_MCP_ALLOW_PRIVATE cannot bypass the private-address guard', async () => {
  process.env.SIRAGPT_MCP_ALLOW_PRIVATE = '1';
  await assert.rejects(
    () => mcp.assertMcpHostSafe('lan.internal', { lookup: lookupTo('10.0.0.5') }),
    /private|reserved/i,
  );
});

test('SIRAGPT_MCP_SSRF_GUARD=0 cannot disable the rebinding guard', async () => {
  process.env.SIRAGPT_MCP_SSRF_GUARD = '0';
  await assert.rejects(
    () => mcp.assertMcpHostSafe('rebind.example', { lookup: lookupTo('169.254.169.254') }),
    /private|metadata|reserved/i,
  );
});

test('mcpAllowPrivate remains disabled even when the legacy flag is set', () => {
  assert.equal(mcp.mcpAllowPrivate(), false);
  process.env.SIRAGPT_MCP_ALLOW_PRIVATE = 'true';
  assert.equal(mcp.mcpAllowPrivate(), false);
});
