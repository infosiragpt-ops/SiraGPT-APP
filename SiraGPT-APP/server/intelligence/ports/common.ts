/**
 * server/intelligence/ports/common.ts
 *
 * Shared domain vocabulary for the SiraGPT intelligence core.
 *
 * These are the data shapes that flow between subsystems. Validation-relevant
 * shapes are expressed as Zod schemas (single source of truth for the typed
 * structured-output contracts the orchestrator enforces); the inferred types
 * are re-exported for ergonomics.
 *
 * Design notes:
 * - No runtime dependencies beyond `zod` (already a first-party dependency in
 *   both the root and the backend package).
 * - Pure types + schemas only; no I/O, no side effects.
 * - Imports are intentionally extension-less so the same source type-checks
 *   under the root `tsconfig.json` (bundler resolution) and the test
 *   `tests/tsconfig.json` (CommonJS / Node resolution).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Result type (fail-open ergonomics)                                         */
/* -------------------------------------------------------------------------- */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E = string> {
  readonly ok: false;
  readonly error: E;
  readonly cause?: unknown;
}

export type Result<T, E = string> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E, cause?: unknown): Err<E> {
  return { ok: false, error, cause };
}

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

export const ModalitySchema = z.enum([
  'text',
  'image',
  'audio',
  'video',
  'code',
  'multimodal',
]);
export type Modality = z.infer<typeof ModalitySchema>;

export const DifficultySchema = z.enum([
  'trivial',
  'simple',
  'moderate',
  'complex',
  'expert',
]);
export type Difficulty = z.infer<typeof DifficultySchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const IntentSchema = z.enum([
  'chat',
  'analyze',
  'generate',
  'code',
  'search',
  'summarize',
  'translate',
  'compare',
  'extract',
  'explain',
  'plan',
  'visualize',
  'review',
  'research',
]);
export type Intent = z.infer<typeof IntentSchema>;

export const CostTierSchema = z.enum(['low', 'medium', 'high']);
export type CostTier = z.infer<typeof CostTierSchema>;

export const LatencyTierSchema = z.enum(['fast', 'normal', 'slow']);
export type LatencyTier = z.infer<typeof LatencyTierSchema>;

/* -------------------------------------------------------------------------- */
/* Chat primitives                                                            */
/* -------------------------------------------------------------------------- */

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
  name: z.string().optional(),
  /** Unix millis; optional, used by the context assembler for recency. */
  createdAt: z.number().optional(),
  /** Cached token estimate for this message, if known. */
  tokens: z.number().int().nonnegative().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const AttachmentSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['image', 'audio', 'video', 'document', 'code', 'data']),
  mimeType: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  /** Extracted text content, when available (e.g. parsed document). */
  text: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/* -------------------------------------------------------------------------- */
/* Request envelope — the unit the orchestrator owns end-to-end               */
/* -------------------------------------------------------------------------- */

export const RequestEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  userId: z.string().min(1),
  prompt: z.string(),
  history: z.array(ChatMessageSchema).default([]),
  attachments: z.array(AttachmentSchema).optional(),
  language: z.string().optional(),
  userPlan: z.string().optional(),
  /** User-requested model id (provider-native). Never invented by the core. */
  requestedModel: z.string().optional(),
  /** Feature surface (e.g. "chat", "builder", "research"). Drives prompt layers. */
  feature: z.string().optional(),
  /** Opaque caller metadata, forwarded to telemetry. */
  metadata: z.record(z.unknown()).optional(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

export const ClassificationSchema = z.object({
  intent: IntentSchema,
  difficulty: DifficultySchema,
  modality: ModalitySchema,
  riskLevel: RiskLevelSchema,
  estimatedContextTokens: z.number().int().nonnegative(),
  estimatedOutputTokens: z.number().int().nonnegative(),
  requiresTools: z.boolean(),
  requiresReasoning: z.boolean(),
  requiresVision: z.boolean(),
  requiresLongContext: z.boolean(),
  language: z.string(),
  /** Confidence of the classifier in its own reading, in [0,1]. */
  confidence: z.number().min(0).max(1),
  /** Human-readable signals that drove the classification (audit trail). */
  signals: z.array(z.string()),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/* -------------------------------------------------------------------------- */
/* Model descriptors                                                          */
/* -------------------------------------------------------------------------- */

export const ModelCapabilitiesSchema = z.object({
  reasoning: z.boolean(),
  code: z.boolean(),
  tools: z.boolean(),
  vision: z.boolean(),
  longContext: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelDescriptorSchema = z.object({
  /** Provider-native id. Sourced from the registry/OpenRouter — never hardcoded. */
  id: z.string().min(1),
  provider: z.string().min(1),
  displayName: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: ModelCapabilitiesSchema,
  costTier: CostTierSchema,
  latencyTier: LatencyTierSchema,
  inputCostPer1k: z.number().nonnegative().optional(),
  outputCostPer1k: z.number().nonnegative().optional(),
  plans: z.array(z.string()).optional(),
  /** Whether the provider key is present so the model is callable right now. */
  reachable: z.boolean().optional(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

/* -------------------------------------------------------------------------- */
/* Token usage / grounding                                                    */
/* -------------------------------------------------------------------------- */

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

export interface GroundingSource {
  readonly id: string;
  readonly text: string;
  readonly url?: string;
  readonly title?: string;
}

export interface GroundingContext {
  readonly sources: ReadonlyArray<GroundingSource>;
}

/* -------------------------------------------------------------------------- */
/* Lightweight, dependency-free token estimation                              */
/* -------------------------------------------------------------------------- */

/**
 * Cheap, deterministic token estimate (~4 chars/token heuristic with a small
 * floor). Good enough for budget arithmetic; never used for billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  // ~4 chars/token for mixed EN/ES prose; round up, minimum 1 for non-empty.
  return Math.max(1, Math.ceil(chars / 4));
}

export function estimateMessageTokens(message: ChatMessage): number {
  if (typeof message.tokens === 'number' && message.tokens >= 0) {
    return message.tokens;
  }
  // +4 token overhead per message for role/formatting framing.
  return estimateTokens(message.content) + 4;
}

export function estimateMessagesTokens(
  messages: ReadonlyArray<ChatMessage>
): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}
