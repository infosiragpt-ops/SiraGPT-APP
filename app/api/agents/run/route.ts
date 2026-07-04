import { NextRequest } from "next/server"
import { getAgent } from "@/server/agents/registry"
import { streamLlmCall, estimateCost, getToolDefsForAgent } from "@/server/agents/llm"
import { spawnSubagents } from "@/lib/code-agent/subagent"
import type { LlmToolCall, LlmMessage } from "@/server/agents/llm"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface AgentRunBody {
  agent: string
  prompt: string
  model?: string
  mode?: "auto" | "plan" | "build"
  webhook_url?: string
  api_key?: string
}

function sseFrame(event: string, data: unknown): string {
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"
}

function heartbeat(controller: ReadableStreamDefaultController, interval: number) {
  return setInterval(() => {
    try { controller.enqueue(new TextEncoder().encode(sseFrame("heartbeat", { ts: Date.now() }))) } catch { /* closed */ }
  }, interval)
}

export async function POST(request: NextRequest) {
  const body: AgentRunBody = await request.json().catch(() => ({} as AgentRunBody))
  const { agent: agentId, prompt, mode = "auto", webhook_url } = body

  if (!agentId || !prompt) {
    return new Response(JSON.stringify({ error: "agent and prompt are required" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    })
  }

  const def = getAgent(agentId)
  if (!def) {
    return new Response(JSON.stringify({ error: "Agent not found: " + agentId }), {
      status: 404, headers: { "Content-Type": "application/json" },
    })
  }

  // Webhook mode: process async, return immediately
  if (webhook_url) {
    const resultPromise = runAgentLoop(def, prompt, mode).catch((e) => ({ error: String(e) }))
    resultPromise.then(async (result) => {
      try {
        await fetch(webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: agentId, result }),
        })
      } catch { /* webhook delivery failure */ }
    })
    return new Response(JSON.stringify({ accepted: true, agent: agentId }), {
      status: 202, headers: { "Content-Type": "application/json" },
    })
  }

  // SSE streaming mode
  const hbInterval = 15000
  const stream = new ReadableStream({
    start(controller) {
      const hb = heartbeat(controller, hbInterval)
      let aborted = false

      const send = (event: string, data: unknown) => {
        if (aborted) return
        try { controller.enqueue(new TextEncoder().encode(sseFrame(event, data))) } catch { aborted = true }
      }

      request.signal?.addEventListener("abort", () => { aborted = true; clearInterval(hb) })

      runAgentLoop(def, prompt, mode, send)
        .then((result) => {
          send("done", result)
          clearInterval(hb)
          try { controller.close() } catch { /* already closed */ }
        })
        .catch((err) => {
          send("error", { message: String(err) })
          clearInterval(hb)
          try { controller.close() } catch { /* already closed */ }
        })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

async function runAgentLoop(
  def: ReturnType<typeof getAgent>,
  prompt: string,
  mode: string,
  send?: (event: string, data: unknown) => void,
) {
  if (!def) return { error: "agent not found" }

  const tools = getToolDefsForAgent(def.tools as unknown as Record<string, boolean>)
  const messages: LlmMessage[] = [
    { role: "system", content: def.prompts.system },
    { role: "user", content: prompt },
  ]

  send?.("agent_start", { agent: def.id, model: def.model.name, mode })

  // Plan mode: single call, return plan only
  if (mode === "plan") {
    messages[0].content += "\n\nGenera un plan de acción detallado paso a paso. NO ejecutes herramientas, solo describe el plan."
    const plan = await streamLlmCall(
      { model: def.model.name, messages, tools, temperature: def.model.temperature, max_tokens: def.model.max_tokens },
      (t) => send?.("token", { t }),
      () => {},
    )
    send?.("plan", { text: plan.content, cost: estimateCost(def.model.name, plan.usage) })
    return { plan: plan.content, turns: 0, cost: estimateCost(def.model.name, plan.usage) }
  }

  // Agentic loop: max turns
  let totalCost = 0
  let turn = 0
  const maxTurns = def.intake.max_turns

  while (turn < maxTurns) {
    send?.("heartbeat", { ts: Date.now(), turn })
    const result = await streamLlmCall(
      { model: def.model.name, messages, tools, temperature: def.model.temperature, max_tokens: def.model.max_tokens },
      (t) => send?.("token", { t }),
      (tc) => send?.("tool_call", { id: tc.id, name: tc.function.name, args: tc.function.arguments }),
    )

    totalCost += estimateCost(def.model.name, result.usage)
    turn++

    if (result.toolCalls.length === 0) {
      // No tool calls, agent is done
      messages.push({ role: "assistant", content: result.content })
      send?.("done", { content: result.content, turns: turn, cost: totalCost })
      return { content: result.content, turns: turn, cost: totalCost }
    }

    // Execute tool calls
    messages.push({ role: "assistant", content: result.content || "", tool_calls: result.toolCalls } as any)

    for (const tc of result.toolCalls) {
      let toolResult: string
      try {
        if (tc.function.name === "spawn_subagent" && def.tools.spawn_subagent) {
          const args = JSON.parse(tc.function.arguments)
          const subs = await spawnSubagents([{ name: args.name || "subagent", prompt: args.prompt }])
          toolResult = subs[0]?.summary || "Subagent completed"
          send?.("subagent_result", { name: args.name, result: toolResult })
        } else {
          toolResult = "Tool " + tc.function.name + " called with args: " + tc.function.arguments + " — result placeholder"
        }
      } catch {
        toolResult = "Error executing " + tc.function.name
      }

      send?.("tool_result", { id: tc.id, name: tc.function.name, result: toolResult })
      messages.push({ role: "tool", content: toolResult, tool_call_id: tc.id } as any)
    }
  }

  send?.("done", { turns: turn, cost: totalCost, note: "max_turns reached" })
  return { turns: turn, cost: totalCost }
}