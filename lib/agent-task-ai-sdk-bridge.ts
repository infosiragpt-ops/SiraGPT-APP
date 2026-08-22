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
  // Do not instantiate OpenAI/OpenRouter clients in the browser.
  // Agent-task generate goes through SiraGPT's own /api/agent/task (DeepSeek).
  return {
    ready: false,
    reason: "native_deepseek_only",
    exports: {
      ai: [] as string[],
      langchain: [] as string[],
      openai: [] as string[],
      react: [] as string[],
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
