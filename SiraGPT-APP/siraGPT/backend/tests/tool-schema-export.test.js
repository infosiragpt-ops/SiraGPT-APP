const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { ToolSchema } = require('@modelcontextprotocol/sdk/types.js');

const {
  CONTRACT_REGISTRY_VERSION,
  ROUTE_CONTRACTS,
  buildJsonSchemaRegistry,
  createMcpToolRegistry,
  getMcpToolJsonSchema,
  listMcpToolContractNames,
} = (() => {
  const contracts = require('../src/services/contracts/schema-registry');
  const mcp = require('../src/services/connectors/mcp-tool-registry');
  return { ...contracts, createMcpToolRegistry: mcp.createMcpToolRegistry };
})();

function fakeContext() {
  return {
    user: { id: 'u1', tenantId: 'tenant-1' },
    tenantScope: { userId: 'u1', tenantId: 'tenant-1' },
    allowlist: listMcpToolContractNames(),
  };
}

describe('tool schema export registry', () => {
  test('exports MCP tool schemas from the contract registry without drift', () => {
    const registry = buildJsonSchemaRegistry();
    assert.equal(registry.version, CONTRACT_REGISTRY_VERSION);
    assert.equal(registry.protocol.jsonSchemaGenerator, 'zod-to-json-schema');
    assert.match(registry.protocol.zodToOpenApiSkipped, /zod@\^4/);

    const mcpRegistry = createMcpToolRegistry({
      env: {},
      prisma: {
        project: { findFirst: async () => ({ id: 'p1' }) },
        projectDocument: { findFirst: async () => null },
      },
      createGitHubConnector: () => ({ getStatus: () => ({ configured: false }) }),
      rag: { retrieve: async () => [] },
      projectMemory: { listMemory: async () => [] },
    });
    const listed = mcpRegistry.listTools(fakeContext()).tools;

    assert.deepEqual(listed.map((tool) => tool.name), listMcpToolContractNames());
    for (const tool of listed) {
      assert.equal(ToolSchema.safeParse(tool).success, true);
      assert.deepEqual(tool.inputSchema, registry.tools[tool.name].inputSchema);
      assert.deepEqual(tool.outputSchema, registry.tools[tool.name].outputSchema);
      assert.deepEqual(tool.inputSchema, getMcpToolJsonSchema(tool.name, 'input'));
      assert.equal(tool._meta['siragpt.io/approvedInternalTool'], true);
    }
  });

  test('keeps high-value route contracts aligned with express-validator bounds', () => {
    const byId = Object.fromEntries(ROUTE_CONTRACTS.map((contract) => [contract.id, contract]));

    assert.equal(byId['github.codex.repo'].query.safeParse({ repo: 'SiraGPT-ORg/siraGPT', limit: '20' }).success, true);
    assert.equal(byId['github.codex.repo'].query.safeParse({ repo: '', limit: 21 }).success, false);

    assert.equal(byId['github.codex.files'].query.safeParse({
      repo: 'SiraGPT-ORg/siraGPT',
      limit: '120',
      maxBytes: '120000',
    }).success, true);
    assert.equal(byId['github.codex.files'].query.safeParse({
      repo: 'SiraGPT-ORg/siraGPT',
      maxBytes: 999,
    }).success, false);

    assert.equal(byId['agent.task.create'].body.safeParse({
      goal: 'Build a verified task',
      files: ['file-1'],
      maxSteps: 120,
      maxRuntimeMs: 7200000,
    }).success, true);
    assert.equal(byId['agent.task.create'].body.safeParse({ goal: 'no' }).success, false);

    assert.equal(byId['rag.retrieve'].body.safeParse({ query: 'semantic search', k: 20 }).success, true);
    assert.equal(byId['rag.retrieve'].body.safeParse({ query: 'q', k: 21 }).success, false);
  });
});
