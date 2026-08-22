/**
 * code-agent · shared types.
 *
 * Pure type definitions for the /code chat agent FSM. Kept dependency-free so
 * both the React panel (client) and the pure orchestrator/tests can import them
 * without pulling in localStorage or network code.
 */

export type ComposerMode = "app" | "build" | "deps" | "plan" | "debug" | "ask" | "image"

export type AgentPhase = "idle" | "intake" | "generating" | "preview" | "debugging"

export type AgentGoal = "landing" | "app"

/** A persistent task the agent tracks across multiple turns. */
export type AgentTask = {
  id: string
  title: string
  /**
   * "error" marks a task that genuinely failed after its bounded retries
   * (Frente 4): it is the resume point for "reintentar desde el paso roto".
   */
  status: "pending" | "in_progress" | "completed" | "blocked" | "error"
  /** Brief description of what this task involves. */
  detail?: string
  /** Files affected by this task. */
  files?: string[]
  /** Timestamp (ms) when the task was created. */
  createdAt: number
  /** Timestamp (ms) when the task was last updated. */
  updatedAt: number
}

/** Context accumulated during the intake gate (slot-filling, goal-adaptive). */
export interface AgentBuildContext {
  goal: AgentGoal
  productType?: string
  brand?: string
  styleAudience?: string
  /** Landing path: which sections the page should have. */
  sections?: string
  /** Landing path: colours / palette / visual references. */
  colorRef?: string
  /** App path: the key features that can't be missing. */
  features?: string
  /** App path: the main data entities the app manages. */
  dataEntities?: string
}

/** Per-chat-session agent state, persisted with the session. */
export interface AgentState {
  phase: AgentPhase
  /** Number of intake questions asked so far (also the slot index to fill next). */
  intakeStep: number
  context: AgentBuildContext
  /** Last captured build/error log (debugging phase). */
  lastError?: string
  /** Which tier produced the last generation. */
  generator?: "llm" | "deterministic"
  /** Persistent task list the agent tracks across turns. */
  tasks?: AgentTask[]
  /** Autonomous-iteration budget preventing infinite agent loops. */
  budget?: AgentIterationBudget
}

/** Budget guard for the autonomous agent loop (Mejora 4). */
export interface AgentIterationBudget {
  /** How many autonomous iterations have run so far. */
  count: number
  /** Hard cap on autonomous iterations (default 20). */
  max: number
  /** Epoch ms when the autonomous run started. */
  startedAt: number
  /** Max wall-clock duration for the whole run (0 = no time limit). */
  timeoutMs: number
  /** True once the budget has been spent; the FSM must stop autonomous work. */
  exhausted?: boolean
}

export function defaultAgentState(): AgentState {
  return { phase: "idle", intakeStep: 0, context: { goal: "landing" } }
}

/** Signals the panel passes to the pure orchestrator each turn. */
export interface AgentSignal {
  mode: ComposerMode
  /** True when the ⚡ Construir button fired (skip intake, force deterministic). */
  forceDeterministic?: boolean
  /** Set when an error came from the preview "Arreglar con IA" bridge. */
  fixErrorText?: string
  /** Whether an LLM model is selected/available right now. */
  hasModel?: boolean
}

export type AgentAction =
  | { type: "generate"; context: AgentBuildContext; tier: "llm" | "deterministic" }
  | { type: "patch"; instruction: string }
  | { type: "debug"; log: string }
  | { type: "passthrough" }
  | { type: "work_task"; taskId: string; instruction: string }

/** Result of the deterministic build-error classifier (SRE tier-0). */
export interface BuildErrorVerdict {
  matched: boolean
  category: string
  diagnostico: string
  quePasaba: string
  causaRaiz: string
  arreglo: string
  siguientePaso: string
  /** package.json overrides to apply, when the fix is deterministic. */
  suggestedOverrides?: Record<string, string>
  /** Prisma model renames to apply across schema/code, when deterministic. */
  suggestedPrismaModelRenames?: Record<string, string>
}
