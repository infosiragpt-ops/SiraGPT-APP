const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BACKEND_PACKAGES,
  buildAgenticFrameworkStatus,
  buildLangChainToolRegistry,
  createSemanticKernelAdapter,
  inspectFrameworkImports,
} = require('../src/services/agents/agentic-frameworks');
const {
  createConfiguredRagAdapter,
} = require('../src/services/ai-product-os/adapters/rag-adapter');

test('agentic framework SDK imports are available', async () => {
  const imports = await inspectFrameworkImports({ force: true });
  for (const [id, pkg] of Object.entries(BACKEND_PACKAGES)) {
    assert.equal(imports[id].installed, true, `${pkg} should import`);
  }

  for (const pkg of ['ai', '@ai-sdk/openai', '@ai-sdk/langchain', '@ai-sdk/react']) {
    const mod = await import(pkg);
    assert.ok(Object.keys(mod).length > 0, `${pkg} should expose exports`);
  }
});

test('LangChain registry wraps siraGPT tools as tool descriptors', async () => {
  const registry = await buildLangChainToolRegistry([
    { name: 'web_search', description: 'Search the web' },
    { name: 'create_document', description: 'Create a file' },
  ]);

  assert.equal(registry.enabled, true);
  assert.deepEqual(registry.registeredTools, ['web_search', 'create_document']);
});

test('agentic framework status reports fallbacks without credentials', async () => {
  const previousProvider = process.env.AGENTIC_RAG_PROVIDER;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  process.env.AGENTIC_RAG_PROVIDER = 'llamaindex';
  delete process.env.OPENAI_API_KEY;

  const status = await buildAgenticFrameworkStatus({
    tools: [{ name: 'rag_retrieve', description: 'Retrieve context' }],
    langGraphLayer: { enabled: true, provider: '@langchain/langgraph', nodes: ['plan'], checkpointer: 'MemorySaver', humanInTheLoop: true },
  });

  assert.equal(status.active.ragProvider, 'llamaindex');
  assert.equal(status.frameworks.llamaindex.enabled, true);
  assert.equal(status.frameworks.llamaindex.fallback, 'internal-token-overlap-no-openai-key');
  assert.equal(status.frameworks.semanticKernel.officialJavascriptSdk, false);
  assert.equal(status.frameworks.vercelAi.ready, true);

  if (previousProvider === undefined) delete process.env.AGENTIC_RAG_PROVIDER;
  else process.env.AGENTIC_RAG_PROVIDER = previousProvider;
  if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAi;
});

test('Semantic Kernel-compatible adapter supports plugins, memory and agents', async () => {
  const kernel = createSemanticKernelAdapter();
  kernel.registerPlugin('Research', {
    summarize: {
      description: 'Summarize input',
      invoke: async ({ text }) => String(text).toUpperCase(),
    },
  });
  await kernel.memory.save('profile', 'tone', { value: 'formal' });

  const agent = kernel.createAgent({
    name: 'research_agent',
    instructions: 'Use registered research plugins.',
    plugins: ['research'],
  });
  const result = await kernel.runAgent(agent, {
    input: 'hola',
    tool: 'research.summarize',
    args: { text: 'hola' },
  });

  assert.equal(result.output, 'HOLA');
  assert.equal((await kernel.memory.get('profile', 'tone')).value, 'formal');
  assert.equal(kernel.capabilities().official_javascript_sdk, false);
});

test('configured RAG adapter can use LlamaIndex document objects with local fallback ranking', async () => {
  const previous = process.env.AGENTIC_RAG_PROVIDER;
  process.env.AGENTIC_RAG_PROVIDER = 'llamaindex';
  const rag = createConfiguredRagAdapter();
  await rag.ingest({
    collection: 'kb',
    documents: [
      { id: 'a', text: 'LangGraph supports durable execution and checkpoints.' },
      { id: 'b', text: 'A spreadsheet stores rows and formulas.' },
    ],
  });
  const hits = await rag.query({ collection: 'kb', query: 'durable checkpoints', mode: 'sparse', topK: 1 });
  const info = rag.collectionInfo('kb');

  assert.equal(rag.vendor, 'llamaindex');
  assert.equal(hits[0].id, 'a');
  assert.equal(info.provider, 'llamaindex');
  assert.equal(info.llamaDocumentCount, 2);

  if (previous === undefined) delete process.env.AGENTIC_RAG_PROVIDER;
  else process.env.AGENTIC_RAG_PROVIDER = previous;
});
