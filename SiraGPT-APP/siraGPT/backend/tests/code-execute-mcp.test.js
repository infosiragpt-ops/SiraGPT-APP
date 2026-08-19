/**
 * code.execute MCP tool — pins the triple opt-in gate (E2B_API_KEY +
 * MCP_CODE_EXECUTE_ENABLED + MCP_CONNECTOR_ALLOWLIST) and the error
 * code mapping that the registry handler performs. The wrapper in
 * `e2b-sandbox.js` is already covered by its own tests; here we
 * verify the GLUE between the two.
 *
 * Real E2B SDK calls are not exercised — they require an account.
 * We inject a fake e2bSandbox into the registry's deps to drive the
 * happy + error paths deterministically.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createMcpToolRegistry,
} = require("../src/services/connectors/mcp-tool-registry");

function makeContext({ env = {}, allowlist = ['code.execute'] } = {}) {
  return {
    user: { id: 'u-1' },
    tenantScope: { userId: 'u-1', tenantId: 'tenant-1' },
    allowlist,
  };
}

function makeFakeSandbox(executeResult) {
  const calls = [];
  return {
    async executeCode(args, env) {
      calls.push({ args, env });
      return typeof executeResult === 'function' ? executeResult(args, env) : executeResult;
    },
    _calls: () => calls,
  };
}

describe('code.execute — triple opt-in gate', () => {
  test('not in allowlist → mcp_tool_not_allowed (assertAuthorized)', async () => {
    const registry = createMcpToolRegistry({
      env: { MCP_CONNECTOR_ALLOWLIST: 'rag.retrieve' },
      e2bSandbox: makeFakeSandbox({ ok: true, stdout: 'ignored' }),
    });
    await assert.rejects(
      () => registry.callTool('code.execute', { code: 'print(1)' }, makeContext({ allowlist: ['rag.retrieve'] })),
      (err) => err.code === 'mcp_tool_not_allowed' || err.code === 'mcp_unknown_tool',
    );
  });

  test('allowlisted but MCP_CODE_EXECUTE_ENABLED unset → code_execute_disabled', async () => {
    const registry = createMcpToolRegistry({
      env: { /* no MCP_CODE_EXECUTE_ENABLED */ },
      e2bSandbox: makeFakeSandbox({ ok: true, stdout: 'should not run' }),
    });
    await assert.rejects(
      () => registry.callTool('code.execute', { code: 'print(1)' }, makeContext()),
      (err) => err.code === 'code_execute_disabled' && err.status === 403,
    );
  });

  test('MCP_CODE_EXECUTE_ENABLED=false explicitly → code_execute_disabled', async () => {
    const registry = createMcpToolRegistry({
      env: { MCP_CODE_EXECUTE_ENABLED: 'false' },
      e2bSandbox: makeFakeSandbox({ ok: true }),
    });
    await assert.rejects(
      () => registry.callTool('code.execute', { code: 'x=1' }, makeContext()),
      (err) => err.code === 'code_execute_disabled',
    );
  });
});

describe('code.execute — error code mapping (handler → McpToolRegistryError)', () => {
  const enabledEnv = { MCP_CODE_EXECUTE_ENABLED: 'true' };

  test('wrapper returns sandbox_disabled → MCP error with status 503', async () => {
    const registry = createMcpToolRegistry({
      env: enabledEnv,
      e2bSandbox: makeFakeSandbox({ ok: false, code: 'sandbox_disabled', message: 'no key' }),
    });
    await assert.rejects(
      () => registry.callTool('code.execute', { code: 'x' }, makeContext()),
      (err) => err.code === 'sandbox_disabled' && err.status === 503,
    );
  });

  test('wrapper returns sandbox_timeout → MCP error with status 504', async () => {
    const registry = createMcpToolRegistry({
      env: enabledEnv,
      e2bSandbox: makeFakeSandbox({ ok: false, code: 'sandbox_timeout', message: 'too slow' }),
    });
    await assert.rejects(
      () => registry.callTool('code.execute', { code: 'while True: pass' }, makeContext()),
      (err) => err.code === 'sandbox_timeout' && err.status === 504,
    );
  });

  test('wrapper returns sandbox_language_not_allowed → MCP error with status 400', async () => {
    const registry = createMcpToolRegistry({
      env: enabledEnv,
      e2bSandbox: makeFakeSandbox({ ok: false, code: 'sandbox_language_not_allowed', message: 'fortran no' }),
    });
    await assert.rejects(
      () => registry.callTool('code.execute', { code: 'PROGRAM HELLO' }, makeContext()),
      (err) => err.code === 'sandbox_language_not_allowed' && err.status === 400,
    );
  });

  test('wrapper returns sandbox_runtime_error → MCP error with status 502', async () => {
    const registry = createMcpToolRegistry({
      env: enabledEnv,
      e2bSandbox: makeFakeSandbox({ ok: false, code: 'sandbox_runtime_error', message: 'connection lost' }),
    });
    await assert.rejects(
      () => registry.callTool('code.execute', { code: 'print(1)' }, makeContext()),
      (err) => err.code === 'sandbox_runtime_error' && err.status === 502,
    );
  });
});

describe('code.execute — happy path', () => {
  test('forwards stdout/stderr/exitCode/durationMs into structured MCP content', async () => {
    const fakeSandbox = makeFakeSandbox({
      ok: true,
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
      durationMs: 42,
      error: null,
    });
    const registry = createMcpToolRegistry({
      env: { MCP_CODE_EXECUTE_ENABLED: 'true' },
      e2bSandbox: fakeSandbox,
    });
    const result = await registry.callTool(
      'code.execute',
      { code: 'print("hello")', language: 'python' },
      makeContext(),
    );
    // The structured content nests under "executed" so the agent
    // can introspect a single named field rather than guessing.
    assert.equal(result.structuredContent.executed.ok, true);
    assert.equal(result.structuredContent.executed.stdout, 'hello\n');
    assert.equal(result.structuredContent.executed.exitCode, 0);
    assert.equal(result.structuredContent.executed.durationMs, 42);

    const [call] = fakeSandbox._calls();
    assert.equal(call.args.code, 'print("hello")');
    assert.equal(call.args.language, 'python');
  });
});
