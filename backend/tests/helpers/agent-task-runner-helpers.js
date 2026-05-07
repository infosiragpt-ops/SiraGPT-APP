const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Unable to extract agent-task-runner helper block: ${startMarker}`);
  }
  return source.slice(start, end);
}

function loadAgentTaskRunnerHelpers(options = {}) {
  const sourcePath = path.join(__dirname, '../../src/services/agents/agent-task-runner.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const finalizeBlock = sliceBetween(
    source,
    'function normalizeToolName',
    '\nfunction summarizeForChat',
  );
  const normalizeBlock = sliceBetween(
    source,
    'function normalizeAgentRuntimeModel',
    '\nasync function persistAssistantMessage',
  );
  const retryBlock = sliceBetween(
    source,
    'function withJitter',
    '\nmodule.exports =',
  );
  const sandbox = {
    module: { exports: {} },
    exports: {},
    process,
    Math,
    Number,
    String,
    Date,
    listManifests: () => options.manifests || [
      { name: 'web_search' },
      { name: 'create_document' },
      { name: 'verify_artifact' },
      { name: 'rag_retrieve' },
      { name: 'self_rag_answer' },
      { name: 'python_exec' },
      { name: 'run_tests' },
    ],
  };

  vm.runInNewContext(
    `${finalizeBlock}\n${normalizeBlock}\n${retryBlock}\nmodule.exports = { buildFinalizeProfile, classifyTaskError, computeRetryDelay, normalizeAgentRuntimeModel };`,
    sandbox,
    { filename: sourcePath },
  );
  return sandbox.module.exports;
}

module.exports = { loadAgentTaskRunnerHelpers };
