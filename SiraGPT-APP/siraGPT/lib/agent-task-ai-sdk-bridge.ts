import type { AgentTaskState } from "./agent-task-service"

export interface AgentTaskUiMessage {
  id: string
  role: "assistant"
  parts: Array<
    | { type: "text"; text: string }
    | { type: "data-agent-task"; data: AgentTaskState }
  >
}

export async function loadVercelAiSdkBridge() {
  const [ai, langchain, openai, react] = await Promise.all([
    import("ai"),
    import("@ai-sdk/langchain"),
    import("@ai-sdk/openai"),
    import("@ai-sdk/react"),
  ])
  return {
    ready: true,
    exports: {
      ai: Object.keys(ai).sort(),
      langchain: Object.keys(langchain).sort(),
      openai: Object.keys(openai).sort(),
      react: Object.keys(react).sort(),
    },
  }
}

export function agentTaskStateToUiMessage(state: AgentTaskState, id = state.meta?.taskId || "agent-task"): AgentTaskUiMessage {
  const text = state.finalText || state.error || state.steps[state.steps.length - 1]?.label || "Agent task running"
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text },
      { type: "data-agent-task", data: state },
    ],
  }
}
