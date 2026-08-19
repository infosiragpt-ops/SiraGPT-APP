/**
 * server/intelligence/core/orchestrator.ts
 *
 * THE orchestrator. A single owner of the full request lifecycle:
 *
 *   validate → trace → classify → moderate(input) → recall(memory)
 *   → retrieve(knowledge?) → assemble(context) → route(model)
 *   → compose(prompt) → execute(stream, retry+fallback) → moderate(output)
 *   → [escalate if low-confidence] → stream done → derive(memory) → observe
 *
 * Every subsystem is reached through a typed port (hexagonal). The orchestrator
 * contains the policy/sequencing; the ports contain the mechanism. It is
 * fail-open: a failure in any non-essential stage degrades gracefully and the
 * user still gets an answer.
 */

import type {
  Classification,
  RequestEnvelope,
  TokenUsage,
} from '../ports/common';
import { RequestEnvelopeSchema } from '../ports/common';
import type {
  GroundingContext,
  InputModerationResult,
  IntelligencePorts,
  LlmResult,
  OutputModerationResult,
  PromptLayer,
  RecalledMemory,
  RoutingDecision,
  StreamSink,
} from '../ports';
import type { IntelligenceConfig } from '../config';
import { dynamicLayer } from './prompt-composer';
import { cascade, withRetry, withTimeout } from './retry';

export interface OrchestratorResult {
  readonly requestId: string;
  readonly output: string;
  readonly model: string;
  readonly provider: string;
  readonly classification: Classification;
  readonly routing: RoutingDecision;
  readonly usage?: TokenUsage;
  readonly moderation: {
    readonly input: InputModerationResult;
    readonly output?: OutputModerationResult;
  };
  readonly memoryRecalled: number;
  readonly escalated: boolean;
  readonly fellBack: boolean;
  readonly refused: boolean;
  readonly truncatedContext: boolean;
  readonly promptVersion: string;
  readonly promptVariant?: string;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface HandleOptions {
  readonly sink?: StreamSink;
  readonly signal?: AbortSignal;
}

export interface Orchestrator {
  handle(
    envelope: RequestEnvelope,
    options?: HandleOptions
  ): Promise<OrchestratorResult>;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isTransient(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const anyErr = error as { status?: number; code?: string } | null;
  const status = anyErr && typeof anyErr.status === 'number' ? anyErr.status : undefined;
  if (status === 429 || (status != null && status >= 500)) return true;
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded') ||
    msg.includes('503') ||
    msg.includes('502')
  );
}

function temperatureFor(classification: Classification): number {
  switch (classification.intent) {
    case 'code':
    case 'extract':
    case 'translate':
      return 0.2;
    case 'generate':
    case 'visualize':
      return 0.7;
    default:
      return 0.4;
  }
}

function formatMemoryBlock(facts: ReadonlyArray<RecalledMemory>): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f) => `- (${f.category}) ${f.content}`);
  return [
    'Known facts about this user (apply silently; do not announce that you remember them):',
    ...lines,
  ].join('\n');
}

function formatEvidenceBlock(grounding: GroundingContext): string {
  if (grounding.sources.length === 0) return '';
  const lines = grounding.sources.map((s, i) => {
    const title = s.title ? `${s.title} — ` : '';
    const url = s.url ? ` (${s.url})` : '';
    const snippet = s.text.length > 280 ? `${s.text.slice(0, 277)}…` : s.text;
    return `[${i + 1}] ${title}${snippet}${url}`;
  });
  return [
    'Sources you may cite. Cite them as [N] and NEVER cite a number not listed here:',
    ...lines,
  ].join('\n');
}

function refusalMessage(language: string): string {
  return language.startsWith('es')
    ? 'No puedo ayudar con esa solicitud. Si necesitas información relacionada de forma segura, dime y veré cómo orientarte responsablemente.'
    : 'I can’t help with that request. If there’s a safe, related goal I can assist with, let me know and I’ll do my best.';
}

function routeToHumanMessage(language: string): string {
  return language.startsWith('es')
    ? 'Lamento que estés pasando por esto y no estás solo/a. No soy un sustituto de ayuda profesional. Si estás en peligro inmediato, contacta a los servicios de emergencia locales o a una línea de prevención del suicidio de tu país.'
    : 'I’m really sorry you’re going through this — you’re not alone. I’m not a substitute for professional help. If you’re in immediate danger, please contact your local emergency services or a suicide-prevention hotline in your country.';
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateOrchestratorInput {
  readonly ports: IntelligencePorts;
  readonly config: IntelligenceConfig;
}

export function createOrchestrator(input: CreateOrchestratorInput): Orchestrator {
  const { ports, config } = input;

  async function handle(
    rawEnvelope: RequestEnvelope,
    options: HandleOptions = {}
  ): Promise<OrchestratorResult> {
    const started = Date.now();
    const sink = options.sink;

    // --- 0. Validate the envelope ------------------------------------------
    const parsed = RequestEnvelopeSchema.safeParse(rawEnvelope);
    const envelope: RequestEnvelope = parsed.success
      ? parsed.data
      : { ...rawEnvelope, history: rawEnvelope.history ?? [] };

    // --- 1. Telemetry trace -------------------------------------------------
    const trace = ports.telemetry.startTrace({
      name: 'intelligence.handle',
      userId: envelope.userId,
      sessionId: envelope.requestId,
      metadata: { feature: envelope.feature, requestedModel: envelope.requestedModel },
    });

    if (sink) await safe(() => ports.streamer.emit(sink, { type: 'start' }));

    // --- 2. Classify --------------------------------------------------------
    const classification = await Promise.resolve(
      ports.classifier.classify({
        prompt: envelope.prompt,
        history: envelope.history,
        attachments: envelope.attachments,
        language: envelope.language,
      })
    );
    trace.event('classified', {
      intent: classification.intent,
      difficulty: classification.difficulty,
      confidence: classification.confidence,
    });

    // --- 3. Moderate input --------------------------------------------------
    const inputMod = await ports.security.moderateInput({
      prompt: envelope.prompt,
      classification,
    });
    ports.security.audit({
      requestId: envelope.requestId,
      userId: envelope.userId,
      stage: 'input',
      verdict: inputMod.verdict,
      categories: inputMod.categories,
      at: Date.now(),
    });

    if (inputMod.verdict === 'refuse' || inputMod.verdict === 'route_to_human') {
      const text =
        inputMod.verdict === 'route_to_human'
          ? routeToHumanMessage(classification.language)
          : refusalMessage(classification.language);
      if (sink) {
        await safe(() => ports.streamer.token(sink, text));
        await safe(() => ports.streamer.done(sink));
      }
      trace.event('refused', { verdict: inputMod.verdict, categories: inputMod.categories });
      trace.end({ refused: true });
      await ports.telemetry.flush().catch(() => undefined);
      return {
        requestId: envelope.requestId,
        output: text,
        model: 'none',
        provider: 'none',
        classification,
        routing: emptyRouting(),
        moderation: { input: inputMod },
        memoryRecalled: 0,
        escalated: false,
        fellBack: false,
        refused: true,
        truncatedContext: false,
        promptVersion: 'refusal',
        latencyMs: Date.now() - started,
      };
    }

    const sanitizedPrompt = inputMod.sanitizedPrompt;

    // --- 4. Recall long-term memory (silent, per-user) ----------------------
    let recalled: RecalledMemory[] = [];
    await safe(async () => {
      recalled = await ports.memory.recall({
        userId: envelope.userId,
        query: sanitizedPrompt,
        k: config.memoryRecallK,
      });
    });

    // --- 5. Retrieve knowledge (optional extension point) -------------------
    let grounding: GroundingContext = { sources: [] };
    if (
      ports.retriever &&
      (classification.intent === 'research' || classification.intent === 'search')
    ) {
      await safe(async () => {
        const r = await ports.retriever!.retrieve({
          query: sanitizedPrompt,
          domain: classification.intent === 'research' ? 'academic' : 'general',
        });
        grounding = r.grounding;
      });
    }

    // --- 6. Assemble context (rolling summary, dedup, compress) -------------
    const assembled = await ports.context.assemble({
      history: envelope.history,
      currentTurn: { role: 'user', content: sanitizedPrompt },
      options: {
        maxContextTokens: config.maxContextTokens,
        reserveOutputTokens: config.reserveOutputTokens,
        minRecentMessages: config.minRecentMessages,
      },
    });

    // --- 7. Route the model (registry-driven, budget-aware) -----------------
    let routing: RoutingDecision;
    try {
      routing = await ports.router.route(
        {
          classification,
          constraints: {
            plan: envelope.userPlan,
            preferModelId: envelope.requestedModel,
            maxCostTier: config.defaultMaxCostTier,
            allowEscalation: config.allowEscalation,
          },
        },
        ports.registry
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (sink) {
        await safe(() => ports.streamer.emit(sink, { type: 'error', data: { message: msg } }));
        await safe(() => ports.streamer.done(sink));
      }
      trace.event('route_failed', { message: msg });
      trace.end({ error: msg });
      await ports.telemetry.flush().catch(() => undefined);
      return errorResult(envelope, classification, inputMod, msg, started);
    }
    if (sink) {
      await safe(() =>
        ports.streamer.emit(sink, {
          type: 'meta',
          data: { model: routing.primary.id, provider: routing.primary.provider },
        })
      );
    }

    // --- 8. Compose the layered, versioned system prompt --------------------
    const dynamicLayers: PromptLayer[] = [];
    const memoryBlock = formatMemoryBlock(recalled);
    if (memoryBlock) dynamicLayers.push(dynamicLayer('memory', 'user-memory', memoryBlock));
    const evidenceBlock = formatEvidenceBlock(grounding);
    if (evidenceBlock) dynamicLayers.push(dynamicLayer('evidence', 'rag-evidence', evidenceBlock));
    if (assembled.summary) {
      dynamicLayers.push(
        dynamicLayer('dynamic', 'rolling-summary', `Earlier conversation summary:\n${assembled.summary}`)
      );
    }
    if (inputMod.categories.length > 0 && inputMod.verdict === 'caution') {
      dynamicLayers.push(
        dynamicLayer(
          'security',
          'safety-posture',
          'The request triggered a caution signal. Stay within policy and decline anything that crosses into real-world harm.'
        )
      );
    }

    const composed = ports.prompt.compose({
      feature: envelope.feature ?? 'chat',
      userId: envelope.userId,
      classification,
      layers: dynamicLayers,
      variant: config.promptExperiment || undefined,
    });

    // --- 9. Build the final message list ------------------------------------
    const messages = [
      { role: 'system' as const, content: composed.text },
      ...assembled.messages,
    ];

    // --- 10. Execute with retry + provider-diverse fallback -----------------
    const modelChain = [routing.primary, ...routing.fallbacks];
    let emittedAny = false;
    let accumulated = '';
    let usage: TokenUsage | undefined;

    const streamModel = async (
      modelId: string,
      provider: string,
      signal: AbortSignal
    ): Promise<LlmResult> => {
      const gen = trace.generation({
        name: 'llm.stream',
        model: modelId,
        input: { messages: messages.length },
      });
      const genStarted = Date.now();
      const result = await ports.llm.stream(
        {
          model: modelId,
          provider,
          messages,
          temperature: temperatureFor(classification),
          maxTokens: Math.min(
            routing.primary.maxOutputTokens ?? config.reserveOutputTokens,
            Math.ceil(classification.estimatedOutputTokens * 1.5) + 256
          ),
          signal,
          cacheableSystemPrefix: composed.cacheablePrefix,
        },
        async (chunk) => {
          if (chunk.content) {
            emittedAny = true;
            accumulated += chunk.content;
            if (sink) await ports.streamer.token(sink, chunk.content);
          }
        }
      );
      usage = result.usage;
      gen.end({ output: { chars: result.content.length }, usage: result.usage, latencyMs: Date.now() - genStarted });
      return result;
    };

    const isRetryable = (e: unknown) => !emittedAny && isTransient(e);

    let fellBack = false;
    let finalModel = routing.primary;
    let execError: string | undefined;

    try {
      const result = await cascade(
        modelChain,
        (model) =>
          withRetry(
            () =>
              withTimeout(
                (signal) => streamModel(model.id, model.provider, signal),
                config.attemptTimeoutMs,
                options.signal
              ),
            {
              maxRetries: config.maxRetries,
              baseMs: config.retryBaseMs,
              maxMs: config.retryMaxMs,
              isRetryable,
            }
          ),
        {
          isRetryable: (e) => !emittedAny && isTransient(e),
          onFallback: (from, to) => {
            fellBack = true;
            trace.event('fallback', { from: from.id, to: to.id });
          },
        }
      );
      finalModel = modelChain[result.index];
      fellBack = result.fellBack || fellBack;
      if (!accumulated) accumulated = result.value.content;
    } catch (e) {
      execError = e instanceof Error ? e.message : String(e);
      trace.event('generation_failed', { message: execError });
      if (sink && !emittedAny) {
        await safe(() => ports.streamer.emit(sink, { type: 'error', data: { message: execError } }));
      }
    }

    // --- 11. Moderate output ------------------------------------------------
    let outputMod: OutputModerationResult | undefined;
    let finalOutput = accumulated;
    if (accumulated) {
      outputMod = await ports.security.moderateOutput({
        output: accumulated,
        classification,
        context: grounding,
      });
      ports.security.audit({
        requestId: envelope.requestId,
        userId: envelope.userId,
        stage: 'output',
        verdict: outputMod.verdict,
        categories: outputMod.redactions.map((r) => `redact:${r.type}`),
        at: Date.now(),
      });
      finalOutput = outputMod.sanitizedOutput;
    }

    // --- 12. Escalate to a more capable model on low confidence -------------
    let escalated = false;
    const wantsEscalation =
      config.allowEscalation &&
      !!routing.escalation &&
      !execError &&
      (classification.confidence < config.escalationConfidenceThreshold ||
        (outputMod?.citationDiscipline.required === true &&
          outputMod.citationDiscipline.satisfied === false));

    if (wantsEscalation && routing.escalation) {
      await safe(async () => {
        const gen = trace.generation({ name: 'llm.escalate', model: routing.escalation!.id });
        const genStarted = Date.now();
        const escResult = await withTimeout(
          (signal) =>
            ports.llm.complete({
              model: routing.escalation!.id,
              provider: routing.escalation!.provider,
              messages,
              temperature: temperatureFor(classification),
              maxTokens: Math.ceil(classification.estimatedOutputTokens * 1.6) + 256,
              signal,
              cacheableSystemPrefix: composed.cacheablePrefix,
            }),
          config.attemptTimeoutMs,
          options.signal
        );
        gen.end({ output: { chars: escResult.content.length }, usage: escResult.usage, latencyMs: Date.now() - genStarted });

        const escMod = await ports.security.moderateOutput({
          output: escResult.content,
          classification,
          context: grounding,
        });
        finalOutput = escMod.sanitizedOutput;
        outputMod = escMod;
        usage = escResult.usage ?? usage;
        finalModel = routing.escalation!;
        escalated = true;
        trace.event('escalated', { to: routing.escalation!.id });
        // Surface the escalated answer as a full replace frame.
        if (sink) await ports.streamer.emit(sink, { type: 'replace', content: finalOutput });
      });
    } else if (sink && outputMod && finalOutput !== accumulated) {
      // Redactions changed the text — push the clean version to the client.
      await safe(() => ports.streamer.emit(sink, { type: 'replace', content: finalOutput }));
    }

    // --- 13. Emit usage + done ---------------------------------------------
    if (sink) {
      if (usage) await safe(() => ports.streamer.emit(sink, { type: 'usage', data: { ...usage } }));
      await safe(() => ports.streamer.done(sink));
    }

    const latencyMs = Date.now() - started;

    // --- 14. Derive & store memory (post-answer learning) -------------------
    if (finalOutput && !execError) {
      await safe(() =>
        ports.memory.deriveAndStore({
          userId: envelope.userId,
          userMessage: sanitizedPrompt,
          assistantMessage: finalOutput,
        })
      );
    }

    // --- 15. Observe --------------------------------------------------------
    trace.end({
      model: finalModel.id,
      escalated,
      fellBack,
      outputChars: finalOutput.length,
      latencyMs,
    });
    await ports.telemetry.flush().catch(() => undefined);

    return {
      requestId: envelope.requestId,
      output: finalOutput,
      model: finalModel.id,
      provider: finalModel.provider,
      classification,
      routing,
      usage,
      moderation: { input: inputMod, output: outputMod },
      memoryRecalled: recalled.length,
      escalated,
      fellBack,
      refused: false,
      truncatedContext: assembled.truncated,
      promptVersion: composed.version,
      promptVariant: composed.variant,
      latencyMs,
      error: execError,
    };
  }

  return { handle };
}

/* -------------------------------------------------------------------------- */
/* Small internal utilities                                                   */
/* -------------------------------------------------------------------------- */

async function safe(fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* fail-open: never let an auxiliary stage break the request */
  }
}

function emptyRouting(): RoutingDecision {
  return {
    primary: {
      id: 'none',
      provider: 'none',
      contextWindow: 0,
      capabilities: { reasoning: false, code: false, tools: false, vision: false, longContext: false },
      costTier: 'low',
      latencyTier: 'fast',
    },
    fallbacks: [],
    rationale: 'no routing performed',
    score: 0,
    changedFromRequested: false,
  };
}

function errorResult(
  envelope: RequestEnvelope,
  classification: Classification,
  inputMod: InputModerationResult,
  message: string,
  started: number
): OrchestratorResult {
  return {
    requestId: envelope.requestId,
    output: '',
    model: 'none',
    provider: 'none',
    classification,
    routing: emptyRouting(),
    moderation: { input: inputMod },
    memoryRecalled: 0,
    escalated: false,
    fellBack: false,
    refused: false,
    truncatedContext: false,
    promptVersion: 'error',
    latencyMs: Date.now() - started,
    error: message,
  };
}
