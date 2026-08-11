import { createAuthenticatedFetch } from "../authenticated-fetch"
import { isSlowModel } from "./model-policy"

let activeSubagents = 0
const DEFAULT_MAX_PARALLEL = 6
const DEFAULT_MAX_DEPTH = 1
const DEFAULT_MODEL =
  process.env.SIRAGPT_SUBAGENT_MODEL || "claude-sonnet-4-20250514"
const SIRA_API_ROOT = `${process.env.SIRAGPT_API_BASE || "http://backend:5000"}/api`
const subagentFetch = createAuthenticatedFetch({ apiBaseUrl: SIRA_API_ROOT })

export type SubagentTier = "starter" | "standard" | "complex"

export interface SubagentLimits {
  maxParallel: number
  maxDepth: number
}

const TIER_LIMITS: Record<SubagentTier, SubagentLimits> = {
  starter: { maxParallel: 4, maxDepth: 1 },
  standard: { maxParallel: 6, maxDepth: 2 },
  complex: { maxParallel: 12, maxDepth: 3 },
}

export function getSubagentLimits(tier?: SubagentTier): SubagentLimits {
  if (!tier) return { maxParallel: DEFAULT_MAX_PARALLEL, maxDepth: DEFAULT_MAX_DEPTH }
  return TIER_LIMITS[tier] || TIER_LIMITS.standard
}

export interface SubagentRequest {
  name: string
  prompt: string
  depth?: number
  model?: string
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

export async function spawnSubagent(
  req: SubagentRequest,
  limits?: SubagentLimits,
): Promise<SubagentResult> {
  const maxDepth = limits?.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxParallel = limits?.maxParallel ?? DEFAULT_MAX_PARALLEL
  const depth = req.depth ?? 0
  if (depth >= maxDepth) {
    return { name: req.name, summary: "max depth reached", error: "depth limit" }
  }

  if (activeSubagents >= maxParallel * 2) {
    return { name: req.name, summary: "", error: "too many active subagents" }
  }

  const requestedModel = req.model || DEFAULT_MODEL
  const model = isSlowModel(requestedModel) ? DEFAULT_MODEL : requestedModel

  activeSubagents++
  try {
    const res = await subagentFetch(
      `${SIRA_API_ROOT}/chat/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
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

export async function spawnSubagents(
  reqs: SubagentRequest[],
  limits?: SubagentLimits,
): Promise<SubagentResult[]> {
  const maxParallel = limits?.maxParallel ?? DEFAULT_MAX_PARALLEL
  const maxDepth = limits?.maxDepth ?? DEFAULT_MAX_DEPTH
  const limited = reqs.slice(0, maxParallel)
  const results = await Promise.allSettled(
    limited.map((r) => spawnSubagent({ ...r, depth: (r.depth ?? 0) + 1 }, { maxParallel, maxDepth }))
  )
  return results.map((r) =>
    r.status === "fulfilled" ? r.value : { name: "unknown", summary: "", error: String(r.reason) }
  )
}

export function getActiveSubagentCount(): number {
  return activeSubagents
}