import type { AgentInfo, AgentRunRequest, AgentRunResult, AgentStreamController } from "./types"

export interface SiragptAgentOptions {
  apiKey?: string
  baseUrl?: string
}

export class SiragptAgent {
  private apiKey: string
  private baseUrl: string

  constructor(options: SiragptAgentOptions = {}) {
    this.apiKey = options.apiKey || ""
    this.baseUrl = options.baseUrl || "https://siragpt.com"
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" }
    if (this.apiKey) h["Authorization"] = "Bearer " + this.apiKey
    return h
  }

  async listAgents(): Promise<AgentInfo[]> {
    const res = await fetch(this.baseUrl + "/api/agents", { headers: this.headers() })
    if (!res.ok) throw new Error("Failed to list agents: " + res.status)
    const data = await res.json()
    return data.agents
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const res = await fetch(this.baseUrl + "/api/agents/run", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ agent: req.agent, prompt: req.prompt, model: req.model, mode: req.mode || "auto" }),
    })
    if (!res.ok) throw new Error("Agent run failed: " + res.status)
    return res.json()
  }

  async plan(req: AgentRunRequest): Promise<{ plan: string }> {
    const res = await fetch(this.baseUrl + "/api/agents/run", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ agent: req.agent, prompt: req.prompt, mode: "plan" }),
    })
    if (!res.ok) throw new Error("Plan failed: " + res.status)
    return res.json()
  }

  async runWithWebhook(req: AgentRunRequest & { webhook_url: string }): Promise<{ accepted: boolean }> {
    const res = await fetch(this.baseUrl + "/api/agents/run", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...req, mode: req.mode || "auto" }),
    })
    if (!res.ok) throw new Error("Webhook run failed: " + res.status)
    return res.json()
  }

  stream(req: AgentRunRequest & { signal?: AbortSignal }): AgentStreamController {
    const handlers: Record<string, Array<(data: any) => void>> = {}
    let aborted = false

    const controller: AgentStreamController = {
      on(event: string, handler: (data: any) => void) {
        if (!handlers[event]) handlers[event] = []
        handlers[event].push(handler)
        return controller
      },
      abort() { aborted = true },
    }

    const run = async () => {
      try {
        const res = await fetch(this.baseUrl + "/api/agents/run", {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ agent: req.agent, prompt: req.prompt, model: req.model, mode: req.mode || "auto" }),
          signal: req.signal,
        })
        if (!res.ok) throw new Error("Stream failed: " + res.status)

        const reader = res.body?.getReader()
        if (!reader) throw new Error("No readable stream")

        const decoder = new TextDecoder()
        let buffer = ""

        while (!aborted) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith("data: ")) continue

            try {
              const eventType = trimmed.startsWith("event: ")
                ? trimmed.split("\n")[0].slice(7)
                : "message"
              const dataStr = trimmed.includes("\ndata: ") ? trimmed.split("\ndata: ")[1] : trimmed.slice(6)
              const data = JSON.parse(dataStr)
              handlers[eventType]?.forEach((h) => h(data))
              handlers["*"]?.forEach((h) => h({ event: eventType, data }))
            } catch { /* skip malformed */ }
          }
        }
      } catch (e) {
        if (!aborted) handlers["error"]?.forEach((h) => h({ message: String(e) }))
      }
    }

    run()
    return controller
  }
}

export function createClient(options?: SiragptAgentOptions): SiragptAgent {
  return new SiragptAgent(options)
}