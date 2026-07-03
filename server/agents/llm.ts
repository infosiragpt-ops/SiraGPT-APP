const API_BASE = process.env.SIRAGPT_API_BASE || "http://backend:5000"

export interface LlmMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LlmToolDef {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface LlmToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface LlmResponse {
  id: string
  model: string
  choices: { index: number; message: { role: "assistant"; content: string | null; tool_calls?: LlmToolCall[] }; finish_reason: string }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface LlmStreamEvent {
  choices: { index: number; delta: { role?: string; content?: string; tool_calls?: { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

const TOOL_DEFS: LlmToolDef[] = [
  { type: "function", function: { name: "read", description: "Read a file from the local filesystem", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } } },
  { type: "function", function: { name: "write", description: "Write content to a file", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } } },
  { type: "function", function: { name: "edit", description: "Replace text in a file", parameters: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } } },
  { type: "function", function: { name: "bash", description: "Execute a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "glob", description: "Find files matching a pattern", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep", description: "Search for a pattern in files", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_fetch", description: "Fetch content from a URL", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
]

export function getToolDefsForAgent(enabledTools: Record<string, boolean>): LlmToolDef[] {
  return TOOL_DEFS.filter((td) => (enabledTools as Record<string, boolean>)[td.function.name] === true)
}

export async function llmApiCall(params: {
  model: string; messages: LlmMessage[]; tools?: LlmToolDef[]; temperature?: number; max_tokens?: number
}): Promise<LlmResponse> {
  const res = await fetch(API_BASE + "/api/chat/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, stream: false, store: false }),
  })
  if (!res.ok) throw new Error("LLM API error " + res.status)
  return res.json()
}

export async function streamLlmCall(
  params: { model: string; messages: LlmMessage[]; tools?: LlmToolDef[]; temperature?: number; max_tokens?: number },
  onToken: (token: string) => void,
  onToolCall: (tc: LlmToolCall) => void,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: LlmToolCall[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const res = await fetch(API_BASE + "/api/chat/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, stream: true, store: false }),
    signal,
  })
  if (!res.ok) throw new Error("LLM stream error " + res.status)

  const reader = res.body?.getReader()
  if (!reader) throw new Error("No readable stream")

  const decoder = new TextDecoder()
  let buffer = ""
  let fullContent = ""
  const toolCalls: LlmToolCall[] = []
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith("data: ")) continue
      const data = trimmed.slice(6)
      if (data === "[DONE]") continue
      try {
        const event: LlmStreamEvent = JSON.parse(data)
        for (const choice of event.choices) {
          if (choice.delta.content) {
            fullContent += choice.delta.content
            onToken(choice.delta.content)
          }
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || "call_" + idx, type: "function", function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" } }
              } else if (tc.function?.arguments) {
                toolCalls[idx].function.arguments += tc.function.arguments
              }
            }
          }
        }
        if (event.usage) usage = event.usage
      } catch { /* skip malformed frames */ }
    }
  }

  for (const tc of toolCalls.filter(Boolean)) {
    if (tc.function?.name) onToolCall(tc)
  }

  return { content: fullContent, toolCalls: toolCalls.filter(Boolean), usage }
}

export function estimateCost(model: string, usage?: { prompt_tokens: number; completion_tokens: number }): number {
  const rates: Record<string, { prompt: number; completion: number }> = {
    "claude-sonnet-4-20250514": { prompt: 3, completion: 15 },
    "gpt-4o": { prompt: 2.5, completion: 10 },
  }
  const rate = rates[model] || { prompt: 1, completion: 5 }
  if (!usage) return 0
  return (usage.prompt_tokens / 1_000_000) * rate.prompt + (usage.completion_tokens / 1_000_000) * rate.completion
}