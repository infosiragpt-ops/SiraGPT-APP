import { NextRequest } from "next/server"
import { getAgent } from "@/server/agents/registry"
import { streamLlmCall, estimateCost, getToolDefsForAgent } from "@/server/agents/llm"
import { spawnSubagents } from "@/lib/code-agent/subagent"
import {
  createWorkspace,
  executeTool,
  listWorkspaceFiles,
  type AgentWorkspace,
} from "@/server/agents/tools"
import type { LlmMessage } from "@/server/agents/llm"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface AgentRunBody {
  agent: string
  prompt: string
  model?: string
  mode?: "auto" | "plan" | "build"
  webhook_url?: string
  api_key?: string
  session_id?: string
}

function sseFrame(event: string, data: unknown): string {
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"
}

function heartbeat(controller: ReadableStreamDefaultController, interval: number) {
  return setInterval(() => {
    try {
      controller.enqueue(new TextEncoder().encode(sseFrame("heartbeat", { ts: Date.now() })))
    } catch {
      /* closed */
    }
  }, interval)
}

export async function POST(request: NextRequest) {
  const body: AgentRunBody = await request.json().catch(() => ({} as AgentRunBody))
  const { agent: agentId, prompt, mode = "auto", webhook_url, session_id } = body

  if (!agentId || !prompt) {
    return new Response(JSON.stringify({ error: "agent and prompt are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const def = getAgent(agentId)
  if (!def) {
    return new Response(JSON.stringify({ error: "Agent not found: " + agentId }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
  }

  if (webhook_url) {
    const resultPromise = runAgentLoop(def, prompt, mode, session_id).catch((e) => ({
      error: String(e),
    }))
    resultPromise.then(async (result) => {
      try {
        await fetch(webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: agentId, result }),
        })
      } catch {
        /* webhook delivery failure */
      }
    })
    return new Response(JSON.stringify({ accepted: true, agent: agentId }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    })
  }

  const hbInterval = 15000
  const stream = new ReadableStream({
    start(controller) {
      const hb = heartbeat(controller, hbInterval)
      let aborted = false

      const send = (event: string, data: unknown) => {
        if (aborted) return
        try {
          controller.enqueue(new TextEncoder().encode(sseFrame(event, data)))
        } catch {
          aborted = true
        }
      }

      request.signal?.addEventListener("abort", () => {
        aborted = true
        clearInterval(hb)
      })

      runAgentLoop(def, prompt, mode, session_id, send)
        .then((result) => {
          send("done", result)
          clearInterval(hb)
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        })
        .catch((err) => {
          send("error", { message: String(err) })
          clearInterval(hb)
          try {
            controller.close()
          } catch {
            /* already closed */
          }
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
  def: NonNullable<ReturnType<typeof getAgent>>,
  prompt: string,
  mode: string,
  sessionId?: string,
  send?: (event: string, data: unknown) => void,
) {
  const workspace: AgentWorkspace = createWorkspace(sessionId)
  const tools = getToolDefsForAgent(def.tools as unknown as Record<string, boolean>)
  const files = listWorkspaceFiles(workspace, 40)
  const systemExtra = [
    "",
    "## Workspace sandbox",
    `session_id: ${workspace.sessionId}`,
    `root: ${workspace.root}`,
    files.length ? `archivos actuales:\n${files.map((f) => "- " + f).join("\n")}` : "workspace vacío (solo README.md seed).",
    "Usa las herramientas reales (read/write/edit/bash/glob/grep/web_search/web_fetch). No inventes salidas.",
    "Cuando termines, deja de llamar herramientas y entrega un resumen accionable en español.",
  ].join("\n")

  const messages: LlmMessage[] = [
    { role: "system", content: def.prompts.system + systemExtra },
    { role: "user", content: prompt },
  ]

  send?.("agent_start", {
    agent: def.id,
    model: def.model.name,
    mode,
    session_id: workspace.sessionId,
  })

  if (mode === "plan") {
    messages[0].content +=
      "\n\nGenera un plan de acción detallado paso a paso. NO ejecutes herramientas, solo describe el plan con archivos, módulos y criterios de aceptación."
    const plan = await streamLlmCall(
      {
        model: def.model.name,
        messages,
        tools: [],
        temperature: def.model.temperature,
        max_tokens: def.model.max_tokens,
      },
      (t) => send?.("token", { t }),
      () => {},
    )
    const cost = estimateCost(def.model.name, plan.usage)
    send?.("plan", { text: plan.content, cost })
    return {
      plan: plan.content,
      turns: 0,
      cost,
      session_id: workspace.sessionId,
      files: listWorkspaceFiles(workspace, 80),
    }
  }

  let totalCost = 0
  let turn = 0
  const maxTurns = def.intake.max_turns
  const toolTrace: Array<{ name: string; ok: boolean; summary: string }> = []

  while (turn < maxTurns) {
    send?.("heartbeat", { ts: Date.now(), turn, session_id: workspace.sessionId })
    const result = await streamLlmCall(
      {
        model: def.model.name,
        messages,
        tools,
        temperature: def.model.temperature,
        max_tokens: def.model.max_tokens,
      },
      (t) => send?.("token", { t }),
      (tc) =>
        send?.("tool_call", {
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments,
        }),
    )

    totalCost += estimateCost(def.model.name, result.usage)
    turn++

    if (result.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: result.content })
      return {
        content: result.content,
        turns: turn,
        cost: totalCost,
        session_id: workspace.sessionId,
        tools: toolTrace,
        files: listWorkspaceFiles(workspace, 80),
      }
    }

    messages.push({
      role: "assistant",
      content: result.content || "",
      // tool_calls kept for providers that echo them; our adapter accepts content-only follow-ups.
      tool_calls: result.toolCalls,
    } as LlmMessage & { tool_calls: typeof result.toolCalls })

    for (const tc of result.toolCalls) {
      let toolResult: string
      let ok = true
      let summary = ""
      try {
        if (tc.function.name === "spawn_subagent" && def.tools.spawn_subagent) {
          let args: { name?: string; prompt?: string } = {}
          try {
            args = JSON.parse(tc.function.arguments || "{}")
          } catch {
            args = {}
          }
          const subs = await spawnSubagents([
            { name: args.name || "subagent", prompt: args.prompt || prompt },
          ])
          toolResult = subs[0]?.summary || "Subagent completed"
          summary = (subs[0]?.summary || "").slice(0, 120)
          ok = !subs[0]?.error
          send?.("subagent_result", { name: args.name, result: toolResult })
        } else {
          const exec = await executeTool(tc.function.name, tc.function.arguments, workspace)
          toolResult = exec.observation
          ok = exec.ok
          summary = (exec.summary || exec.observation).slice(0, 160)
        }
      } catch (e) {
        ok = false
        toolResult = "Error executing " + tc.function.name + ": " + String(e)
        summary = "exception"
      }

      toolTrace.push({ name: tc.function.name, ok, summary })
      send?.("tool_result", {
        id: tc.id,
        name: tc.function.name,
        ok,
        summary,
        result: toolResult.slice(0, 8000),
      })
      messages.push({
        role: "tool",
        content: toolResult.slice(0, 12_000),
        tool_call_id: tc.id,
      } as LlmMessage & { tool_call_id: string })
    }
  }

  return {
    turns: turn,
    cost: totalCost,
    note: "max_turns reached",
    session_id: workspace.sessionId,
    tools: toolTrace,
    files: listWorkspaceFiles(workspace, 80),
  }
}
