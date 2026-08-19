/**
 * agent-sdk-adapter — contract for the "Agentes y tool calling" layer.
 *
 * Designed to bind cleanly to:
 *   - OpenAI Agents SDK     (TypeScript / Python)
 *   - Pydantic AI           (Python, structured outputs + types)
 *   - Microsoft Semantic Kernel (Python / .NET / TS)
 *
 * The adapter is a CONTRACT, not an implementation. The platform
 * never imports any of those libraries directly — instead, the
 * caller passes a `provider` object that satisfies the interface
 * below. This keeps tests deterministic and lets us swap vendors
 * without touching the runtime.
 *
 * Public methods every provider MUST implement:
 *
 *   createAgent({ name, instructions, tools, output_schema, guardrails, handoffs })
 *     → returns an opaque agent_handle the platform can run.
 *
 *   runAgent(agent_handle, { input, session, signal })
 *     → returns { final_output, tool_calls[], handoffs[], usage, trace_id }.
 *
 *   listSessions(agent_handle?)  → returns [{ id, started_at, length }]
 *
 *   abortSession(session_id)     → cancels a running session.
 *
 * The default provider is a deterministic in-memory stub that:
 *   - records every createAgent / runAgent call
 *   - returns synthetic outputs so tests are reproducible
 *   - fires a tool_call entry per registered tool referenced in input
 *
 * Pure JS, deterministic, zero deps.
 */

const VENDORS = Object.freeze(["openai-agents-sdk", "pydantic-ai", "semantic-kernel", "stub"]);

function createAgentSdkAdapter({ provider = null, vendor = "stub" } = {}) {
  if (!VENDORS.includes(vendor)) throw new Error(`agent-sdk-adapter: unknown vendor "${vendor}"`);
  const impl = provider || createStubProvider();
  validateProvider(impl);

  return {
    vendor,
    provider: impl,

    async createAgent(spec) {
      validateSpec(spec);
      return impl.createAgent(spec);
    },

    async runAgent(agentHandle, opts = {}) {
      if (!agentHandle) throw new Error("agent-sdk-adapter.runAgent: agentHandle required");
      const out = await impl.runAgent(agentHandle, opts);
      validateRunOutput(out);
      return out;
    },

    listSessions(agentHandle) { return impl.listSessions(agentHandle); },
    abortSession(id) { return impl.abortSession(id); },

    /**
     * agentToHandoff — express an existing agent as a tool callable
     * by ANOTHER agent (the OpenAI Agents SDK "agent-as-tool" pattern).
     */
    agentToHandoff(agentHandle, { name, description }) {
      if (!agentHandle) throw new Error("agent-sdk-adapter.agentToHandoff: agentHandle required");
      return {
        name,
        description: description || `Delegates to agent ${agentHandle.id || "unknown"}`,
        is_handoff: true,
        agent_handle: agentHandle,
      };
    },

    capabilities() {
      return {
        vendor,
        supports_streaming: Boolean(impl.supports_streaming),
        supports_handoffs: Boolean(impl.supports_handoffs),
        supports_structured_outputs: Boolean(impl.supports_structured_outputs),
        supports_sessions: Boolean(impl.supports_sessions),
        supports_guardrails: Boolean(impl.supports_guardrails),
      };
    },
  };
}

function validateProvider(p) {
  for (const m of ["createAgent", "runAgent", "listSessions", "abortSession"]) {
    if (typeof p[m] !== "function") throw new Error(`agent-sdk-adapter: provider missing ${m}()`);
  }
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") throw new Error("agent-sdk-adapter.createAgent: spec required");
  if (typeof spec.name !== "string" || spec.name.length === 0) throw new Error("agent-sdk-adapter.createAgent: name required");
  if (typeof spec.instructions !== "string") throw new Error("agent-sdk-adapter.createAgent: instructions (string) required");
  if (spec.tools && !Array.isArray(spec.tools)) throw new Error("agent-sdk-adapter.createAgent: tools must be array");
  if (spec.handoffs && !Array.isArray(spec.handoffs)) throw new Error("agent-sdk-adapter.createAgent: handoffs must be array");
}

function validateRunOutput(out) {
  if (!out || typeof out !== "object") throw new Error("agent-sdk-adapter.runAgent: provider returned non-object");
  if (typeof out.final_output === "undefined") throw new Error("agent-sdk-adapter.runAgent: missing final_output");
  if (!Array.isArray(out.tool_calls)) throw new Error("agent-sdk-adapter.runAgent: tool_calls must be array");
}

function createStubProvider() {
  const agents = new Map();
  const sessions = new Map();
  let agentSeq = 0;
  let sessionSeq = 0;

  return {
    supports_streaming: false,
    supports_handoffs: true,
    supports_structured_outputs: true,
    supports_sessions: true,
    supports_guardrails: true,

    async createAgent(spec) {
      const id = `stub_agent_${++agentSeq}`;
      const handle = {
        id,
        name: spec.name,
        instructions: spec.instructions,
        tools: spec.tools || [],
        handoffs: spec.handoffs || [],
        output_schema: spec.output_schema || null,
        guardrails: spec.guardrails || [],
        created_at: new Date().toISOString(),
      };
      agents.set(id, handle);
      return handle;
    },

    async runAgent(agentHandle, opts = {}) {
      const sessionId = `stub_session_${++sessionSeq}`;
      sessions.set(sessionId, { id: sessionId, agent_id: agentHandle.id, started_at: Date.now() });
      const input = String(opts.input || "");
      const tool_calls = (agentHandle.tools || [])
        .filter(t => input.includes(t.name || t))
        .map((t, i) => ({ id: `${sessionId}.tc_${i + 1}`, tool: t.name || t, args: { stub: true } }));
      return {
        final_output: { text: `[${agentHandle.name}] processed: ${input.slice(0, 80)}`, structured: opts.structured || null },
        tool_calls,
        handoffs: [],
        usage: { input_tokens: input.length, output_tokens: Math.min(input.length, 200) },
        trace_id: sessionId,
      };
    },

    listSessions(agentHandle) {
      const all = [...sessions.values()];
      if (!agentHandle) return all.map(s => ({ id: s.id, started_at: s.started_at, length: 1 }));
      return all.filter(s => s.agent_id === agentHandle.id).map(s => ({ id: s.id, started_at: s.started_at, length: 1 }));
    },

    abortSession(id) {
      sessions.delete(id);
      return { aborted: true, id };
    },
  };
}

module.exports = {
  createAgentSdkAdapter,
  createStubProvider,
  VENDORS,
};
