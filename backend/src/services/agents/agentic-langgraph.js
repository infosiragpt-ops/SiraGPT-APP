const GRAPH_NODES = ['plan', 'retrieve', 'execute_tools', 'generate_document', 'verify', 'repair', 'finalize'];

async function buildLangGraphLayer({ taskId, documentPolicy } = {}) {
  try {
    const mod = await import('@langchain/langgraph');
    const { Annotation, StateGraph, START, END } = mod;
    if (!Annotation || !StateGraph || !START || !END) throw new Error('LangGraph primitives unavailable');

    const State = Annotation.Root({
      stage: Annotation({
        reducer: (_left, right) => right,
        default: () => 'plan',
      }),
      checkpoints: Annotation({
        reducer: (left = [], right = []) => [...left, ...right],
        default: () => [],
      }),
    });

    const graph = new StateGraph(State)
      .addNode('plan', async (state) => ({ stage: 'retrieve', checkpoints: [...(state.checkpoints || []), 'plan'] }))
      .addNode('retrieve', async (state) => ({ stage: 'execute_tools', checkpoints: [...(state.checkpoints || []), 'retrieve'] }))
      .addNode('execute_tools', async (state) => ({ stage: documentPolicy?.autoGenerate ? 'generate_document' : 'verify', checkpoints: [...(state.checkpoints || []), 'execute_tools'] }))
      .addNode('generate_document', async (state) => ({ stage: 'verify', checkpoints: [...(state.checkpoints || []), 'generate_document'] }))
      .addNode('verify', async (state) => ({ stage: 'finalize', checkpoints: [...(state.checkpoints || []), 'verify'] }))
      .addNode('repair', async (state) => ({ stage: 'verify', checkpoints: [...(state.checkpoints || []), 'repair'] }))
      .addNode('finalize', async (state) => ({ stage: 'done', checkpoints: [...(state.checkpoints || []), 'finalize'] }))
      .addEdge(START, 'plan')
      .addEdge('plan', 'retrieve')
      .addEdge('retrieve', 'execute_tools')
      .addConditionalEdges('execute_tools', (state) => state.stage === 'generate_document' ? 'generate_document' : 'verify')
      .addEdge('generate_document', 'verify')
      .addEdge('verify', 'finalize')
      .addEdge('repair', 'verify')
      .addEdge('finalize', END)
      .compile();

    return {
      enabled: true,
      provider: '@langchain/langgraph',
      taskId,
      nodes: GRAPH_NODES,
      graph,
    };
  } catch (err) {
    return {
      enabled: false,
      provider: '@langchain/langgraph',
      taskId,
      nodes: GRAPH_NODES,
      fallback: 'deterministic-runner',
      error: err.message,
    };
  }
}

module.exports = {
  GRAPH_NODES,
  buildLangGraphLayer,
};
