const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { createSemanticKernelAdapter } = require('./semantic-kernel-adapter');

const BACKEND_PACKAGES = Object.freeze({
  langgraph: '@langchain/langgraph',
  langchain: 'langchain',
  langchainOpenai: '@langchain/openai',
  langsmith: 'langsmith',
  llamaindexOpenai: '@llamaindex/openai',
  llamaindexWorkflowCore: '@llamaindex/workflow-core',
  llamaindexWorkflow: '@llamaindex/workflow',
  llamaindex: 'llamaindex',
});

const FRONTEND_PACKAGES = Object.freeze({
  vercelAi: 'ai',
  vercelAiOpenai: '@ai-sdk/openai',
  vercelAiLangchain: '@ai-sdk/langchain',
  vercelAiReact: '@ai-sdk/react',
});

let cachedImports = null;

async function buildAgenticFrameworkStatus({
  tools = [],
  langGraphLayer = null,
  ragProvider = process.env.AGENTIC_RAG_PROVIDER || 'internal',
  agentEngine = process.env.AGENTIC_AGENT_ENGINE || 'react',
} = {}) {
  const imports = await inspectFrameworkImports();
  const langChainTools = await buildLangChainToolRegistry(tools);
  const semanticKernel = buildSemanticKernelSummary(tools);
  const langSmith = buildLangSmithSummary();
  const vercelAi = inspectFrontendPackages();

  return {
    version: 'siragpt-agentic-framework-stack-2026-04',
    active: {
      agentEngine: ['react', 'langchain'].includes(agentEngine) ? agentEngine : 'react',
      ragProvider: ['internal', 'llamaindex'].includes(ragProvider) ? ragProvider : 'internal',
      orchestration: langGraphLayer?.enabled ? 'langgraph' : 'deterministic-runner',
      tracing: langSmith.enabled ? 'langsmith' : 'local',
      uiStreamBridge: vercelAi.ready ? 'vercel-ai-sdk' : 'sse',
    },
    frameworks: {
      langgraph: {
        package: BACKEND_PACKAGES.langgraph,
        installed: imports.langgraph.installed,
        enabled: Boolean(langGraphLayer?.enabled),
        fallback: langGraphLayer?.fallback || null,
        nodes: langGraphLayer?.nodes || [],
        checkpointer: langGraphLayer?.checkpointer || null,
        humanInTheLoop: Boolean(langGraphLayer?.humanInTheLoop),
        error: langGraphLayer?.error || imports.langgraph.error || null,
      },
      langchain: {
        package: BACKEND_PACKAGES.langchain,
        installed: imports.langchain.installed,
        enabled: langChainTools.enabled,
        registeredTools: langChainTools.registeredTools,
        error: langChainTools.error || imports.langchain.error || null,
      },
      langsmith: langSmith,
      llamaindex: {
        package: BACKEND_PACKAGES.llamaindex,
        installed: imports.llamaindex.installed,
        enabled: ragProvider === 'llamaindex' && imports.llamaindex.installed,
        provider: ragProvider === 'llamaindex' && imports.llamaindex.installed ? 'llamaindex' : 'internal',
        fallback: ragProvider === 'llamaindex' && !process.env.OPENAI_API_KEY ? 'internal-token-overlap-no-openai-key' : null,
        workflowInstalled: imports.llamaindexWorkflow.installed && imports.llamaindexWorkflowCore.installed,
        error: imports.llamaindex.error || null,
      },
      semanticKernel: semanticKernel,
      vercelAi,
    },
    observability: {
      langsmithProject: process.env.LANGSMITH_PROJECT || null,
      langsmithTracing: langSmith.enabled,
      traceExport: langSmith.enabled ? 'langsmith' : 'local-events',
    },
  };
}

async function inspectFrameworkImports({ force = false } = {}) {
  if (cachedImports && !force) return cachedImports;
  const entries = Object.entries(BACKEND_PACKAGES);
  const results = {};
  for (const [id, pkg] of entries) {
    results[id] = await tryImport(pkg);
  }
  cachedImports = results;
  return results;
}

async function tryImport(pkg) {
  try {
    const mod = await import(pkg);
    return {
      package: pkg,
      installed: true,
      exportCount: Object.keys(mod || {}).length,
    };
  } catch (err) {
    return {
      package: pkg,
      installed: false,
      error: err?.message || String(err),
    };
  }
}

async function buildLangChainToolRegistry(tools = []) {
  try {
    const mod = await import('langchain');
    const toolFactory = mod.tool;
    if (typeof toolFactory !== 'function') throw new Error('langchain.tool export unavailable');
    const schema = z.object({}).passthrough();
    const registered = tools.map((tool) => toolFactory(
      async (args) => ({ tool: tool.name, args, delegated: true }),
      {
        name: normalizeToolName(tool.name),
        description: tool.description || tool.name,
        schema,
      }
    ));
    return {
      enabled: true,
      registeredTools: registered.map((tool) => tool.name).filter(Boolean),
    };
  } catch (err) {
    return {
      enabled: false,
      registeredTools: tools.map((tool) => normalizeToolName(tool.name)),
      error: err?.message || String(err),
    };
  }
}

function buildSemanticKernelSummary(tools = []) {
  const kernel = createSemanticKernelAdapter();
  const functions = {};
  for (const tool of tools) {
    functions[normalizeToolName(tool.name)] = {
      description: tool.description || tool.name,
      schema: tool.parameters || null,
      invoke: async (args) => ({ tool: tool.name, args, delegated: true }),
    };
  }
  if (Object.keys(functions).length > 0) {
    kernel.registerPlugin('siragpt_tools', functions);
  }
  const capabilities = kernel.capabilities();
  return {
    package: 'official-compatible-adapter',
    installed: true,
    enabled: true,
    officialJavascriptSdk: false,
    officialSupportedLanguages: capabilities.official_supported_languages,
    plugins: kernel.listPlugins(),
  };
}

function buildLangSmithSummary() {
  const tracing = /^(1|true|yes)$/i.test(String(process.env.LANGSMITH_TRACING || process.env.LANGCHAIN_TRACING_V2 || ''));
  const hasKey = Boolean(process.env.LANGSMITH_API_KEY);
  return {
    package: BACKEND_PACKAGES.langsmith,
    installed: hasPackageInBackendLock(BACKEND_PACKAGES.langsmith),
    enabled: tracing && hasKey,
    configured: { tracing, apiKey: hasKey, project: process.env.LANGSMITH_PROJECT || null },
    fallback: tracing && !hasKey ? 'local-events-no-langsmith-api-key' : null,
  };
}

function inspectFrontendPackages() {
  const packages = {};
  let ready = true;
  for (const [id, pkg] of Object.entries(FRONTEND_PACKAGES)) {
    const installed = hasPackageInRootLock(pkg);
    packages[id] = { package: pkg, installed };
    ready = ready && installed;
  }
  return {
    package: 'ai-sdk',
    installed: ready,
    ready,
    bridge: ready ? 'agent-task-state-to-ui-message' : 'sse-only',
    packages,
  };
}

function hasPackageInBackendLock(pkg) {
  return hasPackageInLock(path.join(process.cwd(), 'package-lock.json'), pkg)
    || hasPackageInLock(path.join(process.cwd(), 'backend', 'package-lock.json'), pkg);
}

function hasPackageInRootLock(pkg) {
  return hasPackageInLock(path.join(process.cwd(), '..', 'package-lock.json'), pkg)
    || hasPackageInLock(path.join(process.cwd(), 'package-lock.json'), pkg);
}

function hasPackageInLock(lockPath, pkg) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Boolean(lock.packages?.[`node_modules/${pkg}`] || lock.dependencies?.[pkg]);
  } catch {
    return false;
  }
}

function normalizeToolName(value) {
  return String(value || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

module.exports = {
  BACKEND_PACKAGES,
  FRONTEND_PACKAGES,
  buildAgenticFrameworkStatus,
  buildLangChainToolRegistry,
  createSemanticKernelAdapter,
  inspectFrameworkImports,
};
