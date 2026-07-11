"use client"

import { authenticatedFetch } from "../authenticated-fetch"

/**
 * Frontend client for the /api/builder backend (siraGPT Builder · E1–E3).
 *
 * Mirrors lib/projects-service.ts: localStorage JWT, credentials:include,
 * thin fetch wrappers. The intake is stateless on the server — the client
 * owns the `session` object and round-trips it on every /intake/step call.
 */

export type CoverageDimension =
  | "purpose"
  | "platform"
  | "coreFeatures"
  | "dataEntities"
  | "style"
  | "audience"

export type QuestionType = "chips" | "select" | "multiselect" | "text"

export interface QuestionCard {
  id: string
  dimension: CoverageDimension
  prompt: string
  type: QuestionType
  options: string[]
  allowFreeText: boolean
}

/** Value shapes the engine accepts per dimension. */
export type AnswerValue = string | string[]

export interface IntakeSession {
  answers: Partial<Record<CoverageDimension, AnswerValue>>
  integrations: string[]
  constraints: string
}

export interface Coverage {
  covered: CoverageDimension[]
  missing: CoverageDimension[]
  complete: boolean
  ratio: number
}

export interface IntakeSnapshot {
  session: IntakeSession
  coverage: Coverage
  nextQuestion: QuestionCard | null
  complete: boolean
}

export interface ProjectBrief {
  purpose: string
  platform: "web" | "mobile" | "landing" | "desktop"
  audience: string
  coreFeatures: string[]
  dataEntities: Array<{ name: string; fields: string[] }>
  style: { theme: string; refs: string[] }
  integrations: string[]
  constraints: string
  openQuestions: string[]
}

export interface Blueprint {
  stack: { frontend: string; backend: string; database: string; hosting: string }
  pages: Array<{ name: string; purpose: string; components: string[] }>
  dataModel: Array<{ entity: string; fields: Array<{ name: string; type: string }> }>
  integrations: string[]
  milestones: Array<{ title: string; tasks: string[] }>
  estimate: { screens: number; entities: number; complexity: "low" | "medium" | "high" }
}

export interface ScaffoldFile {
  path: string
  language: string
  content: string
}

export interface ScaffoldResult {
  blueprint: Blueprint
  files: ScaffoldFile[]
}

export interface GenerateResult {
  brief: ProjectBrief
  blueprint: Blueprint
  files: ScaffoldFile[]
}

const baseUrl = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/builder`

function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      message = body.message || body.error || message
    } catch {
      // body wasn't JSON — fall back to the status line
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export interface StepInput {
  session?: IntakeSession
  answer?: { dimension: CoverageDimension; value: AnswerValue }
  integrations?: string[]
  constraints?: string
}

export const intakeService = {
  /** The full QuestionCard catalogue + the ordered coverage dimensions. */
  async questions(): Promise<{ dimensions: CoverageDimension[]; questions: QuestionCard[] }> {
    const res = await authenticatedFetch(`${baseUrl}/intake/questions`, {
      credentials: "include",
      headers: authHeaders(),
    })
    return handle(res)
  },

  /** Record an answer (or just hydrate) and get the next snapshot. */
  async step(input: StepInput): Promise<IntakeSnapshot> {
    const res = await authenticatedFetch(`${baseUrl}/intake/step`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
    return handle<IntakeSnapshot>(res)
  },

  /** Assemble the ProjectBrief — only valid once coverage is complete. */
  async brief(session: IntakeSession, openQuestions: string[] = []): Promise<ProjectBrief> {
    const res = await authenticatedFetch(`${baseUrl}/intake/brief`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ session, openQuestions }),
    })
    const json = await handle<{ brief: ProjectBrief }>(res)
    return json.brief
  },

  /** Deterministic build plan from a brief (E2). */
  async blueprint(brief: ProjectBrief): Promise<Blueprint> {
    const res = await authenticatedFetch(`${baseUrl}/blueprint`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ brief }),
    })
    const json = await handle<{ blueprint: Blueprint }>(res)
    return json.blueprint
  },

  /** Starter artifacts — blueprint + generated files (E3). */
  async scaffold(brief: ProjectBrief): Promise<ScaffoldResult> {
    const res = await authenticatedFetch(`${baseUrl}/scaffold`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ brief }),
    })
    return handle<ScaffoldResult>(res)
  },

  /**
   * One-shot, LLM-free generation from a single free-text description. The
   * server derives a ProjectBrief heuristically and scaffolds runnable files
   * (incl. a live index.html). Powers the /code "Construir app" button so the
   * build + preview flow works even when the chat model is unavailable.
   */
  async generate(prompt: string, signal?: AbortSignal): Promise<GenerateResult> {
    // Bound the build: an unresponsive backend must NOT leave the caller's
    // `buildingApp` latch wedged forever (the chat composer would then silently
    // park every later message). A hard timeout aborts the fetch so buildApp's
    // catch fires and releases the latch; a caller signal (e.g. a session
    // switch) can also cancel an in-flight build.
    const timeout = AbortSignal.timeout(120_000)
    const anyOf = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
    const composite = signal && typeof anyOf === "function" ? anyOf([signal, timeout]) : timeout
    const res = await authenticatedFetch(`${baseUrl}/generate`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ prompt }),
      signal: composite,
    })
    return handle<GenerateResult>(res)
  },
}
