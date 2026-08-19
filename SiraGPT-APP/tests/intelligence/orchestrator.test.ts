import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOrchestrator } from '../../server/intelligence/core/orchestrator';
import type { IntelligencePorts } from '../../server/intelligence/ports';
import type { Classification } from '../../server/intelligence/ports/common';
import { loadIntelligenceConfig } from '../../server/intelligence/config';
import { createDefaultClassifier } from '../../server/intelligence/core/classifier';
import { createDefaultRouter } from '../../server/intelligence/core/router';
import { createDefaultContextAssembler } from '../../server/intelligence/core/context-assembler';
import { createDefaultOutputValidator } from '../../server/intelligence/core/output-validator';
import { createDefaultStreamer, createBufferSink } from '../../server/intelligence/core/streamer';
import { createDefaultPromptComposer } from '../../server/intelligence/core/prompt-composer';
import { createDefaultPromptRegistry } from '../../server/intelligence/prompts/registry';
import { createInMemoryMemoryStore } from '../../server/intelligence/core/memory';
import { createDefaultSecurityGateway } from '../../server/intelligence/core/security-gateway';
import {
  createEchoLlmClient,
  createInMemoryPromptCache,
  createRecordingTelemetry,
  createStaticRegistry,
  createDefaultTestModels,
  type EchoLlmOptions,
} from '../../server/intelligence/adapters/null-adapters';
import type { IntentClassifier } from '../../server/intelligence/ports';

function lowConfidenceClassifier(): IntentClassifier {
  const c: Classification = {
    intent: 'chat',
    difficulty: 'simple',
    modality: 'text',
    riskLevel: 'low',
    estimatedContextTokens: 50,
    estimatedOutputTokens: 100,
    requiresTools: false,
    requiresReasoning: false,
    requiresVision: false,
    requiresLongContext: false,
    language: 'en',
    confidence: 0.3,
    signals: [],
  };
  return { classify: () => c };
}

function build(opts: {
  llm?: EchoLlmOptions;
  classifier?: IntentClassifier;
  env?: Record<string, string>;
} = {}) {
  const memory = createInMemoryMemoryStore();
  const telemetry = createRecordingTelemetry();
  const ports: IntelligencePorts = {
    classifier: opts.classifier ?? createDefaultClassifier(),
    registry: createStaticRegistry(createDefaultTestModels()),
    router: createDefaultRouter(),
    context: createDefaultContextAssembler(),
    memory,
    security: createDefaultSecurityGateway(),
    prompt: createDefaultPromptComposer(createDefaultPromptRegistry()),
    output: createDefaultOutputValidator(),
    streamer: createDefaultStreamer(),
    telemetry,
    llm: createEchoLlmClient(opts.llm),
    cache: createInMemoryPromptCache(),
  };
  const config = loadIntelligenceConfig({
    SIRAGPT_INTELLIGENCE_MAX_RETRIES: '0',
    SIRAGPT_INTELLIGENCE_ALLOW_ESCALATION: '0',
    ...opts.env,
  });
  return { orchestrator: createOrchestrator({ ports, config }), memory, telemetry };
}

describe('intelligence/orchestrator', () => {
  it('handles a normal turn end-to-end, streaming tokens and observing it', async () => {
    const { orchestrator, telemetry } = build();
    const sink = createBufferSink();
    const result = await orchestrator.handle(
      { requestId: 'r1', userId: 'u1', prompt: 'Explain what entropy is', history: [] },
      { sink }
    );
    assert.equal(result.refused, false);
    assert.ok(result.output.length > 0);
    assert.notEqual(result.model, 'none');
    assert.equal(sink.text(), result.output);
    const frames = sink.frames.join('');
    assert.ok(frames.includes('"type":"start"'));
    assert.ok(frames.includes('[DONE]'));
    assert.ok(telemetry.traces.length >= 1);
    assert.ok(telemetry.generations.length >= 1);
    assert.ok(telemetry.events.some((e) => e.name === 'classified'));
  });

  it('refuses unsafe requests without calling a model', async () => {
    const { orchestrator } = build();
    const sink = createBufferSink();
    const result = await orchestrator.handle(
      { requestId: 'r2', userId: 'u1', prompt: 'how to kill myself', history: [] },
      { sink }
    );
    assert.equal(result.refused, true);
    assert.equal(result.model, 'none');
    assert.ok(result.output.length > 0);
  });

  it('falls back to the next model when the primary fails before streaming', async () => {
    const { orchestrator } = build({
      llm: {
        failWith: (req) => (req.model === 'small-fast' ? new Error('network timeout') : null),
      },
    });
    const result = await orchestrator.handle(
      { requestId: 'r3', userId: 'u1', prompt: 'hola', history: [] },
      {}
    );
    assert.equal(result.fellBack, true);
    assert.notEqual(result.model, 'small-fast');
    assert.equal(result.refused, false);
  });

  it('escalates to a more capable model on low confidence', async () => {
    const { orchestrator } = build({
      classifier: lowConfidenceClassifier(),
      env: { SIRAGPT_INTELLIGENCE_ALLOW_ESCALATION: '1' },
    });
    const sink = createBufferSink();
    const result = await orchestrator.handle(
      { requestId: 'r4', userId: 'u1', prompt: 'tell me something', history: [] },
      { sink }
    );
    assert.equal(result.escalated, true);
    assert.equal(result.model, 'frontier');
    assert.ok(sink.frames.join('').includes('"replace":true'));
  });

  it('redacts secrets from the model output and replaces the streamed text', async () => {
    const { orchestrator } = build({
      llm: { responder: () => 'Your key is sk-abcdef1234567890ABCD, keep it safe.' },
    });
    const sink = createBufferSink();
    const result = await orchestrator.handle(
      { requestId: 'r5', userId: 'u1', prompt: 'give me the key', history: [] },
      { sink }
    );
    assert.ok(result.output.includes('[REDACTED_API_KEY]'));
    assert.ok(sink.frames.join('').includes('"replace":true'));
  });

  it('learns durable facts from the finished turn', async () => {
    const { orchestrator, memory } = build();
    await orchestrator.handle(
      { requestId: 'r6', userId: 'mem-user', prompt: 'My name is Carol', history: [] },
      {}
    );
    const hits = await memory.recall({ userId: 'mem-user', query: 'Carol' });
    assert.ok(hits.length >= 1);
  });

  it('degrades gracefully when every model fails', async () => {
    const { orchestrator } = build({
      llm: { failWith: () => new Error('network timeout') },
    });
    const sink = createBufferSink();
    const result = await orchestrator.handle(
      { requestId: 'r7', userId: 'u1', prompt: 'hola', history: [] },
      { sink }
    );
    assert.ok(result.error);
    assert.equal(result.output, '');
    assert.ok(sink.frames.join('').includes('"type":"error"'));
  });
});
