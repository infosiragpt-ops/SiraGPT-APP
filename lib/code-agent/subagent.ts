import { createAuthenticatedFetch } from "../authenticated-fetch"

let activeSubagents = 0
const MAX_PARALLEL = 6
const MAX_DEPTH = 1
const SIRA_API_ROOT = `${process.env.SIRAGPT_API_BASE || "http://backend:5000"}/api`
const subagentFetch = createAuthenticatedFetch({ apiBaseUrl: SIRA_API_ROOT })

export interface SubagentRequest {
  name: string
  prompt: string
  depth?: number
}

export interface SubagentResult {
  name: string
  summary: string
  error?: string
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + "..."
}

export async function spawnSubagent(req: SubagentRequest): Promise<SubagentResult> {
  const depth = req.depth ?? 0
  if (depth >= MAX_DEPTH) {
    return { name: req.name, summary: "max depth reached", error: "depth limit" }
  }

  if (activeSubagents >= MAX_PARALLEL * 2) {
    return { name: req.name, summary: "", error: "too many active subagents" }
  }

  activeSubagents++
  try {
    // Use the backend LLM with store:false for ephemeral subagent context
    const res = await subagentFetch(
      `${SIRA_API_ROOT}/chat/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          messages: [
            { role: "system", content: "You are " + req.name + ". Respond concisely in under 300 words." },
            { role: "user", content: req.prompt },
          ],
          max_tokens: 1024,
          temperature: 0.3,
          stream: false,
          store: false,
        }),
      }
    )

    if (!res.ok) throw new Error("subagent API error " + res.status)

    const data = await res.json()
    const summary = truncate(
      data.choices?.[0]?.message?.content || "(no output)",
      1000
    )
    return { name: req.name, summary }
  } catch (e) {
    return { name: req.name, summary: "", error: String(e) }
  } finally {
    activeSubagents--
  }
}

export async function spawnSubagents(reqs: SubagentRequest[]): Promise<SubagentResult[]> {
  const limited = reqs.slice(0, MAX_PARALLEL)
  const results = await Promise.allSettled(
    limited.map((r) => spawnSubagent({ ...r, depth: (r.depth ?? 0) + 1 }))
  )
  return results.map((r) =>
    r.status === "fulfilled" ? r.value : { name: "unknown", summary: "", error: String(r.reason) }
  )
}

export function getActiveSubagentCount(): number {
  return activeSubagents
}