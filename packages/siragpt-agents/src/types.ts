export interface AgentInfo {
  id: string
  name: string
  description: string
  version: string
  model: string
  tools: string[]
}

export interface AgentRunRequest {
  agent: string
  prompt: string
  model?: string
  mode?: "auto" | "plan" | "build"
  webhook_url?: string
}

export interface AgentEvent {
  type: "agent_start" | "token" | "tool_call" | "tool_result" | "subagent_spawn" | "subagent_result" | "checkpoint" | "plan" | "usage" | "error" | "done" | "heartbeat"
  data: Record<string, unknown>
}

export interface AgentRunResult {
  content?: string
  plan?: string
  turns: number
  cost: number
  error?: string
}

export interface AgentStreamController {
  on(event: string, handler: (data: any) => void): AgentStreamController
  abort(): void
}