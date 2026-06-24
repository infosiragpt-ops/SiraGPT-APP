/**
 * server/intelligence/index.ts
 *
 * Composition root for the SiraGPT intelligence core. Wires the typed ports to
 * their adapters (real backend-backed when available, deterministic defaults
 * otherwise), constructs the orchestrator, and exposes the feature flag.
 *
 * The entire core is OFF by default (`SIRAGPT_INTELLIGENCE_CORE_ENABLED`) for a
 * safe rollout. Nothing here is imported by the live request path until the
 * flag is turned on and the orchestrator is explicitly mounted.
 */

import { loadIntelligenceConfig, isIntelligenceCoreEnabled } from './config';
import type { EnvLike, IntelligenceConfig } from './config';
import type { IntelligencePorts, KnowledgeRetriever, AgenticExecutor } from './ports';
import { createOrchestrator } from './core/orchestrator';
import type { Orchestrator } from './core/orchestrator';

import { createDefaultClassifier } from './core/classifier';
import { createDefaultRouter } from './core/router';
import { createDefaultContextAssembler } from './core/context-assembler';
import { createDefaultOutputValidator } from './core/output-validator';
import { createDefaultStreamer } from './core/streamer';
import { createDefaultPromptComposer } from './core/prompt-composer';
import { createDefaultPromptRegistry } from './prompts/registry';
import { createInMemoryMemoryStore } from './core/memory';
import { createDefaultSecurityGateway } from './core/security-gateway';

import {
  createEchoLlmClient,
  createInMemoryPromptCache,
  createNullTelemetry,
  createStaticRegistry,
  createDefaultTestModels,
} from './adapters/null-adapters';
import { createBackendRegistry } from './adapters/registry.adapter';
import { createBackendTelemetry } from './adapters/telemetry.adapter';
import { createBackendMemoryStore } from './adapters/memory.adapter';
import { createBackendSecurityGateway } from './adapters/security.adapter';
import { createBackendLlmClient } from './adapters/llm.adapter';
import { createHybridRetriever } from './knowledge/hybrid-retriever';
import { createOpenAlexSource } from './knowledge/openalex.adapter';
import { createSemanticScholarSource } from './knowledge/semantic-scholar.adapter';
import { createAgenticExecutor } from './agentic/state-machine';

const PROVIDER_KEY_ENV = [
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_AI_API_KEY',
  'DEEPSEEK_API_KEY',
  'CEREBRAS_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
] as const;

export function hasAnyProviderKey(env: EnvLike = process.env as EnvLike): boolean {
  return PROVIDER_KEY_ENV.some((k) => {
    const v = env[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

export interface IntelligenceCore {
  readonly orchestrator: Orchestrator;
  readonly ports: IntelligencePorts;
  readonly config: IntelligenceConfig;
  readonly enabled: boolean;
}

export interface CreateIntelligenceCoreOptions {
  readonly env?: EnvLike;
  /** Override any port (test seams / custom deployments). */
  readonly overrides?: Partial<IntelligencePorts>;
  /** Force the deterministic, dependency-free default ports (used in tests). */
  readonly useDefaults?: boolean;
  /** Enable the academic hybrid retriever extension point. */
  readonly enableRetriever?: boolean;
}

/** Build the academic hybrid retriever (OpenAlex + Semantic Scholar). */
export function buildDefaultRetriever(env: EnvLike = process.env as EnvLike): KnowledgeRetriever {
  return createHybridRetriever({
    sources: [
      createOpenAlexSource({ mailto: env.SIRAGPT_RESEARCH_EMAIL }),
      createSemanticScholarSource({ apiKey: env.SEMANTIC_SCHOLAR_API_KEY }),
    ],
  });
}

/**
 * Assemble the full intelligence core. With `useDefaults` (or no provider keys)
 * it runs fully offline on deterministic adapters; otherwise it binds the real
 * backend-backed registry/memory/telemetry/security/LLM adapters.
 */
export function createIntelligenceCore(
  options: CreateIntelligenceCoreOptions = {}
): IntelligenceCore {
  const env = options.env ?? (process.env as EnvLike);
  const config = loadIntelligenceConfig(env);
  const o = options.overrides ?? {};
  const useDefaults = options.useDefaults === true;

  const promptRegistry = createDefaultPromptRegistry();
  if (config.promptExperiment) {
    promptRegistry.setExperiment({ promptId: 'base', variants: ['v1', 'v2'] });
  }

  const registry =
    o.registry ??
    (useDefaults
      ? createStaticRegistry(createDefaultTestModels())
      : createBackendRegistry({ env: env as NodeJS.ProcessEnv }));

  const telemetry = o.telemetry ?? (useDefaults ? createNullTelemetry() : createBackendTelemetry());

  const memory = o.memory ?? (useDefaults ? createInMemoryMemoryStore() : createBackendMemoryStore());

  const security =
    o.security ?? (useDefaults ? createDefaultSecurityGateway() : createBackendSecurityGateway());

  // The LLM is the one true IO seam: use the real client only when a provider
  // key exists, else the deterministic echo client (keeps everything runnable).
  const llm =
    o.llm ??
    (useDefaults || !hasAnyProviderKey(env)
      ? createEchoLlmClient()
      : createBackendLlmClient({ env: env as NodeJS.ProcessEnv }));

  let retriever: KnowledgeRetriever | undefined = o.retriever;
  if (!retriever && options.enableRetriever && !useDefaults) {
    retriever = buildDefaultRetriever(env);
  }

  const agentic: AgenticExecutor | undefined = o.agentic;

  const ports: IntelligencePorts = {
    classifier: o.classifier ?? createDefaultClassifier(),
    registry,
    router: o.router ?? createDefaultRouter(),
    context: o.context ?? createDefaultContextAssembler(),
    memory,
    security,
    prompt: o.prompt ?? createDefaultPromptComposer(promptRegistry),
    output: o.output ?? createDefaultOutputValidator(),
    streamer: o.streamer ?? createDefaultStreamer(),
    telemetry,
    llm,
    cache: o.cache ?? createInMemoryPromptCache(),
    retriever,
    agentic,
  };

  const orchestrator = createOrchestrator({ ports, config });

  return { orchestrator, ports, config, enabled: config.enabled };
}

/* ----------------------------- public surface ----------------------------- */

export { isIntelligenceCoreEnabled, loadIntelligenceConfig };
export type { IntelligenceConfig, EnvLike } from './config';
export type { Orchestrator, OrchestratorResult, HandleOptions } from './core/orchestrator';
export * from './ports';

// Factory re-exports for consumers/tests that want to wire pieces by hand.
export { createOrchestrator } from './core/orchestrator';
export { createDefaultClassifier } from './core/classifier';
export { createDefaultRouter, NoEligibleModelError } from './core/router';
export { createDefaultContextAssembler } from './core/context-assembler';
export { createDefaultOutputValidator } from './core/output-validator';
export { createDefaultStreamer, createBufferSink } from './core/streamer';
export { createDefaultPromptComposer, dynamicLayer } from './core/prompt-composer';
export { createDefaultPromptRegistry, PromptRegistry } from './prompts/registry';
export { createInMemoryMemoryStore } from './core/memory';
export {
  createDefaultSecurityGateway,
  type SecurityGatewayWithAudit,
} from './core/security-gateway';
export {
  createEchoLlmClient,
  createStaticRegistry,
  createDefaultTestModels,
  createNullTelemetry,
  createRecordingTelemetry,
  createInMemoryPromptCache,
} from './adapters/null-adapters';
export { createBackendRegistry } from './adapters/registry.adapter';
export { createBackendTelemetry } from './adapters/telemetry.adapter';
export { createBackendMemoryStore } from './adapters/memory.adapter';
export { createBackendSecurityGateway } from './adapters/security.adapter';
export { createBackendLlmClient, LlmNotConfiguredError } from './adapters/llm.adapter';
export { createHybridRetriever, lexicalRerank } from './knowledge/hybrid-retriever';
export { createOpenAlexSource } from './knowledge/openalex.adapter';
export { createSemanticScholarSource } from './knowledge/semantic-scholar.adapter';
export { createAgenticExecutor } from './agentic/state-machine';
export { runDefaultEval, createEvalDeps, formatReport } from './eval/run';
export { runEvalSuite } from './eval/scorer';
export type { EvalReport, EvalDeps, CaseScore } from './eval/scorer';
export { EVAL_SUITE } from './eval/suite';
export type { EvalCase, EvalExpectation } from './eval/suite';
