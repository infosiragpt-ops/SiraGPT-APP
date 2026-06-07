/**
 * server/intelligence/ports/index.ts
 *
 * The hexagonal "ports" of the intelligence core: typed, decoupled interfaces
 * that every subsystem hides behind. The orchestrator depends ONLY on these
 * interfaces, so any port can be re-implemented (swapped adapter) without
 * touching the rest of the core.
 *
 * Re-exports the shared domain vocabulary from ./common so callers have a
 * single import surface: `from '../ports'`.
 */

import type { z } from 'zod';
import type {
  Attachment,
  ChatMessage,
  Classification,
  GroundingContext,
  ModelDescriptor,
  RequestEnvelope,
  Result,
  TokenUsage,
  CostTier,
  LatencyTier,
} from './common';

export * from './common';

/* ========================================================================== */
/* Intent / difficulty classifier                                             */
/* ========================================================================== */

export interface ClassifierInput {
  readonly prompt: string;
  readonly history?: ReadonlyArray<ChatMessage>;
  readonly attachments?: ReadonlyArray<Attachment>;
  readonly language?: string;
}

export interface IntentClassifier {
  classify(input: ClassifierInput): Promise<Classification> | Classification;
}

/* ========================================================================== */
/* Model registry (reads current models — never hardcodes ids)                */
/* ========================================================================== */

export interface ModelRegistryQuery {
  readonly plan?: string;
  readonly onlyReachable?: boolean;
  readonly capability?: keyof ModelDescriptor['capabilities'];
}

export interface ModelRegistry {
  listModels(query?: ModelRegistryQuery): Promise<ModelDescriptor[]>;
  getModel(id: string): Promise<ModelDescriptor | null>;
  /** Force a refresh of the underlying source (e.g. re-sync from OpenRouter). */
  refresh?(): Promise<void>;
}

/* ========================================================================== */
/* Model router (budget-aware selection + fallback + escalation)              */
/* ========================================================================== */

export interface RoutingConstraints {
  readonly maxCostTier?: CostTier;
  readonly maxLatencyTier?: LatencyTier;
  readonly plan?: string;
  /** User-requested model id; honored unless policy/eligibility forbids it. */
  readonly preferModelId?: string;
  readonly blocklist?: ReadonlyArray<string>;
  /** When true the router may upgrade past the user's model on hard turns. */
  readonly allowEscalation?: boolean;
}

export interface RoutingDecision {
  readonly primary: ModelDescriptor;
  /** Ordered fallback chain to try on failure/timeout/rate-limit. */
  readonly fallbacks: ReadonlyArray<ModelDescriptor>;
  /** A more capable model to escalate to when answer confidence is low. */
  readonly escalation?: ModelDescriptor;
  readonly rationale: string;
  readonly score: number;
  readonly changedFromRequested: boolean;
}

export interface ModelRouter {
  route(
    input: { classification: Classification; constraints?: RoutingConstraints },
    registry: ModelRegistry
  ): Promise<RoutingDecision>;
}

/* ========================================================================== */
/* Context assembler (rolling summaries, dedup, safe compression)             */
/* ========================================================================== */

export type Summarizer = (
  messages: ReadonlyArray<ChatMessage>
) => Promise<string>;

export interface ContextAssemblerOptions {
  readonly maxContextTokens: number;
  readonly reserveOutputTokens: number;
  /** Optional LLM-backed summarizer; falls back to extractive when absent. */
  readonly summarize?: Summarizer;
  /** Keep at least this many of the most-recent turns verbatim. */
  readonly minRecentMessages?: number;
}

export interface AssembledContext {
  /** Final, ready-to-send message list (excluding the system prompt). */
  readonly messages: ReadonlyArray<ChatMessage>;
  /** Rolling summary block injected when older turns were compacted. */
  readonly summary?: string;
  readonly droppedMessages: number;
  readonly dedupedMessages: number;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
  readonly summarized: boolean;
}

export interface ContextAssembler {
  assemble(input: {
    history: ReadonlyArray<ChatMessage>;
    currentTurn: ChatMessage;
    options: ContextAssemblerOptions;
  }): Promise<AssembledContext>;
}

/* ========================================================================== */
/* Long-term memory (derive / store / recall / forget, per-user isolation)    */
/* ========================================================================== */

export interface MemoryFact {
  readonly content: string;
  readonly category?: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly source?: string;
}

export interface RecalledMemory {
  readonly content: string;
  readonly category: string;
  readonly score: number;
}

export interface MemoryStore {
  /** Derive durable facts from a finished turn and persist them. */
  deriveAndStore(input: {
    userId: string;
    userMessage: string;
    assistantMessage: string;
  }): Promise<{ stored: number }>;
  /** Semantic recall, strictly scoped to the given user. */
  recall(input: {
    userId: string;
    query: string;
    k?: number;
  }): Promise<RecalledMemory[]>;
  /** Right-to-be-forgotten: delete all memory for a user. */
  forget(input: { userId: string }): Promise<{ removed: number }>;
  /** Optional explicit fact write (e.g. user preference capture). */
  storeFacts?(input: {
    userId: string;
    facts: ReadonlyArray<MemoryFact>;
  }): Promise<{ stored: number }>;
}

/* ========================================================================== */
/* Constitutional security / ethics gateway                                   */
/* ========================================================================== */

export type SecurityVerdict =
  | 'allow'
  | 'caution'
  | 'redact'
  | 'refuse'
  | 'route_to_human';

export interface Redaction {
  readonly type: string;
  readonly count: number;
}

export interface InputModerationResult {
  readonly verdict: SecurityVerdict;
  readonly categories: ReadonlyArray<string>;
  readonly jailbreakConfidence: number;
  readonly sanitizedPrompt: string;
  readonly redactions: ReadonlyArray<Redaction>;
  readonly rationale: string;
}

export interface CitationDiscipline {
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly issues: ReadonlyArray<string>;
}

export interface OutputModerationResult {
  readonly verdict: SecurityVerdict;
  readonly sanitizedOutput: string;
  readonly redactions: ReadonlyArray<Redaction>;
  readonly citationDiscipline: CitationDiscipline;
  readonly rationale: string;
}

export interface SecurityAuditEvent {
  readonly requestId: string;
  readonly userId: string;
  readonly stage: 'input' | 'output';
  readonly verdict: SecurityVerdict;
  readonly categories: ReadonlyArray<string>;
  readonly at: number;
}

export interface SecurityGateway {
  moderateInput(input: {
    prompt: string;
    classification?: Classification;
    context?: GroundingContext;
  }): Promise<InputModerationResult>;
  moderateOutput(input: {
    output: string;
    classification?: Classification;
    context?: GroundingContext;
  }): Promise<OutputModerationResult>;
  audit(event: SecurityAuditEvent): void;
}

/* ========================================================================== */
/* Composed / versioned prompt system (base + feature + user, A/B, rollback)  */
/* ========================================================================== */

export type PromptLayerKind =
  | 'base'
  | 'feature'
  | 'user'
  | 'memory'
  | 'evidence'
  | 'security'
  | 'dynamic';

export interface PromptLayer {
  readonly kind: PromptLayerKind;
  readonly id: string;
  readonly version: string;
  readonly text: string;
  /** Whether this layer is stable enough to be served from the prompt cache. */
  readonly cacheable: boolean;
  /** Tier; lower numbers are more protected from budget trimming. */
  readonly priority: number;
}

export interface ComposedPrompt {
  readonly text: string;
  readonly layers: ReadonlyArray<PromptLayer>;
  /** The cacheable prefix (stable layers concatenated) for prompt caching. */
  readonly cacheablePrefix: string;
  /** A/B variant id when an experiment is active. */
  readonly variant?: string;
  readonly version: string;
}

export interface PromptComposeInput {
  readonly feature?: string;
  readonly userId?: string;
  readonly classification?: Classification;
  /** Dynamic, per-turn layers (memory, evidence, security directives, …). */
  readonly layers?: ReadonlyArray<PromptLayer>;
  /** Force a specific A/B variant (else chosen deterministically per user). */
  readonly variant?: string;
}

export interface PromptComposer {
  compose(input: PromptComposeInput): ComposedPrompt;
}

/* ========================================================================== */
/* Structured outputs (Zod) + repair                                          */
/* ========================================================================== */

export interface OutputValidationError {
  readonly kind: 'no_json' | 'parse_error' | 'schema_error';
  readonly message: string;
  readonly issues?: ReadonlyArray<string>;
}

export interface OutputValidator {
  validate<T>(
    raw: string,
    schema: z.ZodType<T>
  ): Result<T, OutputValidationError>;
  repairPrompt(originalPrompt: string, error: OutputValidationError): string;
}

/* ========================================================================== */
/* Streaming (SSE, token-by-token)                                            */
/* ========================================================================== */

export interface StreamSink {
  write(chunk: string): void | Promise<void>;
  end?(): void;
}

export type StreamEventType =
  | 'start'
  | 'token'
  | 'replace'
  | 'tool'
  | 'usage'
  | 'meta'
  | 'error'
  | 'heartbeat'
  | 'done';

export interface StreamEvent {
  readonly type: StreamEventType;
  readonly content?: string;
  readonly data?: Record<string, unknown>;
}

export interface Streamer {
  emit(sink: StreamSink, event: StreamEvent): Promise<void>;
  token(sink: StreamSink, text: string): Promise<void>;
  done(sink: StreamSink): Promise<void>;
}

/* ========================================================================== */
/* Telemetry (Langfuse traces: model, tokens, cost, latency, tool calls)      */
/* ========================================================================== */

export interface GenerationHandle {
  end(input: {
    output?: unknown;
    usage?: TokenUsage;
    latencyMs?: number;
  }): void;
}

export interface TraceHandle {
  readonly traceId: string;
  generation(input: {
    name: string;
    model: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): GenerationHandle;
  event(name: string, data?: Record<string, unknown>): void;
  score(input: { name: string; value: number; comment?: string }): void;
  end(output?: unknown): void;
}

export interface Telemetry {
  startTrace(input: {
    name: string;
    userId?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): TraceHandle;
  flush(): Promise<void>;
}

/* ========================================================================== */
/* LLM client (provider-agnostic completion + streaming)                      */
/* ========================================================================== */

export interface LlmRequest {
  readonly model: string;
  readonly provider: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  /** Stable system prefix eligible for provider-side prompt caching. */
  readonly cacheableSystemPrefix?: string;
}

export interface LlmChunk {
  readonly content?: string;
  readonly done?: boolean;
}

export interface LlmResult {
  readonly content: string;
  readonly usage?: TokenUsage;
  readonly finishReason?: string;
  readonly model: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
  stream(
    req: LlmRequest,
    onChunk: (chunk: LlmChunk) => void | Promise<void>
  ): Promise<LlmResult>;
}

/* ========================================================================== */
/* Knowledge retriever (hybrid RAG) — extension point, stubbed               */
/* ========================================================================== */

export interface RetrievedChunk {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly source: string;
  readonly url?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RetrievalQuery {
  readonly query: string;
  readonly k?: number;
  readonly domain?: 'general' | 'academic' | 'code';
  readonly filters?: Record<string, unknown>;
}

export interface RetrievalResult {
  readonly chunks: ReadonlyArray<RetrievedChunk>;
  readonly grounding: GroundingContext;
}

export interface KnowledgeRetriever {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
}

/** A pluggable scholarly/web source the hybrid retriever can fan out to. */
export interface KnowledgeSource {
  readonly name: string;
  search(query: RetrievalQuery): Promise<RetrievedChunk[]>;
}

/* ========================================================================== */
/* Agentic executor (plan → execute → reflect) — extension point, stubbed     */
/* ========================================================================== */

export type AgentPhase = 'plan' | 'execute' | 'reflect' | 'finalize';

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  /** Side-effect free tools may be executed in parallel. */
  readonly readOnly?: boolean;
}

export interface ToolCall {
  readonly tool: string;
  readonly args: unknown;
}

export interface ToolResult {
  readonly tool: string;
  readonly ok: boolean;
  readonly output: unknown;
  readonly error?: string;
}

export interface ToolRuntime {
  invoke(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}

export interface AgentStep {
  readonly phase: AgentPhase;
  readonly thought?: string;
  readonly toolCalls?: ReadonlyArray<ToolCall>;
  readonly toolResults?: ReadonlyArray<ToolResult>;
}

export interface AgentRunResult {
  readonly steps: ReadonlyArray<AgentStep>;
  readonly output: string;
  readonly completed: boolean;
  readonly reason: string;
}

export interface AgenticExecutor {
  run(input: {
    goal: string;
    tools: ReadonlyArray<ToolDescriptor>;
    runtime: ToolRuntime;
    maxSteps?: number;
    signal?: AbortSignal;
  }): Promise<AgentRunResult>;
}

/* ========================================================================== */
/* Prompt cache (system prompt + long context reuse)                          */
/* ========================================================================== */

export interface PromptCache {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttlMs?: number): Promise<void> | void;
  key(parts: ReadonlyArray<string>): string;
}

/* ========================================================================== */
/* The full set of ports the orchestrator is wired with                       */
/* ========================================================================== */

export interface IntelligencePorts {
  readonly classifier: IntentClassifier;
  readonly registry: ModelRegistry;
  readonly router: ModelRouter;
  readonly context: ContextAssembler;
  readonly memory: MemoryStore;
  readonly security: SecurityGateway;
  readonly prompt: PromptComposer;
  readonly output: OutputValidator;
  readonly streamer: Streamer;
  readonly telemetry: Telemetry;
  readonly llm: LlmClient;
  readonly cache: PromptCache;
  /** Optional extension points (stubbed by default). */
  readonly retriever?: KnowledgeRetriever;
  readonly agentic?: AgenticExecutor;
}

export type { RequestEnvelope };
