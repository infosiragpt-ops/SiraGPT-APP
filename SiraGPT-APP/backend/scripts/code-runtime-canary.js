'use strict';

const { createSandboxClient } = require('../src/services/codex/sandbox-provider');
const {
  RuntimeCanaryError,
  runRuntimeCanary,
} = require('../src/services/codex/runtime-canary');

async function main() {
  const result = await runRuntimeCanary({
    runner: createSandboxClient(),
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: error instanceof RuntimeCanaryError ? 'code_runtime_canary_failed' : 'code_runtime_canary_error',
    phase: error?.phase || null,
    message: String(error?.message || error).slice(0, 2_000),
    evidence: error?.evidence || null,
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
