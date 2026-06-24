/**
 * code-agent · shared types.
 *
 * Pure type definitions for the /code chat agent FSM. Kept dependency-free so
 * both the React panel (client) and the pure orchestrator/tests can import them
 * without pulling in localStorage or network code.
 */

export type ComposerMode = "app" | "build" | "plan" | "debug" | "ask" | "image"

export type AgentPhase = "idle" | "intake" | "generating" | "preview" | "debugging"

export type AgentGoal = "landing" | "app"

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
  | { type: "ask"; question: string; slot: string; nextStep: number; context: AgentBuildContext }
  | { type: "generate"; context: AgentBuildContext; tier: "llm" | "deterministic" }
  | { type: "patch"; instruction: string }
  | { type: "debug"; log: string }
  | { type: "passthrough" }

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
}
