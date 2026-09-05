import { randomUUID } from 'node:crypto';
import type { BetaMessageParam, BetaContentBlockParam, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { loadEditorPrompt } from '../agent/prompt';
import { contractExamples } from '../agent/contracts';
import { hostedSkillsForFormats } from '../agent/skills';
import { agentResultSchema, classifyAgentResult, editPlanSchema, identifierSchema } from '../types/contracts';
import type { Artifact, DocumentOutcome, EditPlan, InputFile, JobEvent, JobForEngine, RunRequest, Usage } from '../types/contracts';
import { DocSandboxError } from '../types/errors';
import { addUsage, assertPriceTable, calculateUsage, emptyUsage, totalTokens } from './cost';
import { engineManifestSchema, extractGeneratedFileIds, isSafeFilename, parseJsonArtifact, readBoundedResponse, sha256 } from './artifacts';
import type { DocumentProviderClient, ProviderCallOptions } from './provider-client';
import type { AnthropicEngineConfig, EnginePersistence, RunResult, SandboxEngine, SandboxSession } from './types';

interface SessionState {
  handle: SandboxSession;
  createdAt: number;
  deadline: number;
  controller: AbortController;
  inputs: Array<Omit<InputFile, 'data'> & { providerId: string }>;
  files: Map<string, 'input' | 'output'>;
  persistedFiles: Set<string>;
  artifacts: Artifact[];
  budget?: RunRequest['budget'];
  modelTier?: RunRequest['modelTier'];
  usage: Usage;
  turns: number;
  pendingReservationUsd: number;
  transcript: JobEvent[];
  privateTranscript: unknown[];
  stage?: 'plan' | 'edit';
  busy: boolean;
  closing: boolean;
  closed: boolean;
}

const JSON_MIME = 'application/json';
const MAX_EXPORT_FILES = 40;

/**
 * The response expires_at is a rolling checkpoint timestamp, not proof of data
 * deletion. The documented container retention is up to 30 days. Start that
 * conservative window when we observe each response; preserve any longer value.
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool#container-reuse
 */
export function providerContainerRetentionDeadline(rollingExpiry: string | null | undefined, observedAt = Date.now()): string {
  const minimum = observedAt + 30 * 24 * 60 * 60 * 1000;
  const reported = rollingExpiry ? Date.parse(rollingExpiry) : NaN;
  return new Date(Number.isFinite(reported) ? Math.max(minimum, reported) : minimum).toISOString();
}

/**
 * Interchangeable remote editor, not a validator. No method publishes artifacts.
 * Caller must freeze/validate plans independently and run all four validation
 * levels before making the returned bytes downloadable.
 */
export class AnthropicSandboxEngine implements SandboxEngine {
  private readonly sessions = new Map<string, SessionState>();
  private readonly prompt = loadEditorPrompt();

  constructor(
    private readonly client: DocumentProviderClient,
    private readonly config: AnthropicEngineConfig,
    private readonly persistence: EnginePersistence,
  ) {
    for (const model of Object.values(config.models)) {
      assertPriceTable(model.prices);
      if (!model.id.trim() || !Number.isSafeInteger(model.maxOutputTokensPerTurn) || model.maxOutputTokensPerTurn < 1
        || !Number.isFinite(model.reservationUsdPerTurn) || model.reservationUsdPerTurn <= 0) throw new DocSandboxError('E_NOT_READY', 503);
    }
    for (const value of [config.maxFileBytes, config.maxOutputBytes, config.maxSessionMs, config.apiTimeoutMs, config.cleanupTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new DocSandboxError('E_NOT_READY', 503);
    }
  }

  async createSession(job: JobForEngine): Promise<SandboxSession> {
    identifierSchema.parse(job.id);
    identifierSchema.parse(job.userId);
    if (job.promptVersion !== this.prompt.version || !Number.isInteger(job.attempt) || job.attempt < 1 || job.attempt > 3) {
      throw new DocSandboxError('E_PARAMS');
    }
    const handle = Object.freeze({ id: randomUUID(), jobId: job.id, userId: job.userId, attempt: job.attempt });
    await this.persistence.sessionCreated(handle);
    this.sessions.set(handle.id, {
      handle, createdAt: Date.now(), deadline: Date.now() + this.config.maxSessionMs,
      controller: new AbortController(), inputs: [], files: new Map(), persistedFiles: new Set(), artifacts: [],
      usage: emptyUsage(), turns: 0, pendingReservationUsd: 0, transcript: [], privateTranscript: [],
      busy: false, closing: false, closed: false,
    });
    return handle;
  }

  async uploadInputs(handle: SandboxSession, files: InputFile[], signal?: AbortSignal): Promise<void> {
    const session = this.session(handle);
    this.acquire(session);
    const abort = (): void => session.controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (session.inputs.length || files.length < 1 || files.length > 10) throw new DocSandboxError('E_PARAMS');
      const ids = new Set<string>();
      for (const file of files) {
        identifierSchema.parse(file.id);
        if (ids.has(file.id) || !isSafeFilename(file.name) || file.data.length > this.config.maxFileBytes
          || file.data.length === 0 || sha256(file.data) !== file.sha256) throw new DocSandboxError('E_PARAMS');
        ids.add(file.id);
      }
      // Aliases prevent cross-input filename collisions inside the remote container.
      for (const [index, file] of files.entries()) {
        const alias = `input-${index}.${file.format}`;
        const uploaded = await this.call(session, signal, (options) => this.client.upload(file.data, alias, file.mime, options));
        await this.trackFile(session, uploaded.id, 'input');
        if (session.controller.signal.aborted) throw new DocSandboxError('E_CANCELLED', 409);
        if (uploaded.size_bytes !== file.data.length) throw new DocSandboxError('E_PROVIDER', 502);
        session.inputs.push({ id: file.id, name: file.name, format: file.format, mime: file.mime, sha256: file.sha256, providerId: uploaded.id });
      }
    } catch (error: unknown) {
      throw this.safeError(error, session);
    } finally {
      signal?.removeEventListener('abort', abort);
      session.busy = false;
    }
  }

  async run(handle: SandboxSession, originalRequest: RunRequest, onEvent: (event: JobEvent) => Promise<void> | void): Promise<RunResult> {
    const session = this.session(handle);
    this.acquire(session);
    const signal = originalRequest.signal;
    const abort = () => session.controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // Snapshot mutable caller objects before the first await. Neither the plan
      // nor the budget can be expanded while a provider call is in flight.
      const request: RunRequest = { ...originalRequest, budget: { ...originalRequest.budget },
        formats: [...originalRequest.formats], skills: [...originalRequest.skills],
        approvedPlan: originalRequest.approvedPlan ? editPlanSchema.parse(originalRequest.approvedPlan) : undefined,
        inventory: structuredClone(originalRequest.inventory) };
      this.checkRequest(session, request);
      const stage = request.stage;
      // A new container for editing guarantees plan inspection did not modify input
      // bytes. Only pause_turn continuations within this stage reuse a container.
      let containerId: string | undefined;
      const skillList = hostedSkillsForFormats(request.formats, this.config.skillVersions);
      const wantedSkills = [...new Set(request.skills)].sort();
      if (JSON.stringify(wantedSkills) !== JSON.stringify(skillList.map((skill) => skill.skill_id))) throw new DocSandboxError('E_PARAMS');
      const model = this.config.models[request.modelTier];
      const text = this.userPayload(session, request);
      const messages: BetaMessageParam[] = [{ role: 'user', content: [
        ...session.inputs.map((file): BetaContentBlockParam => ({ type: 'container_upload', file_id: file.providerId })),
        { type: 'text', text },
      ] }];
      const exportIds = new Set<string>();
      await this.emit(session, { type: 'phase', payload: { phase: stage === 'plan' ? 'Planificando edición' : 'Editando documento' } }, onEvent);
      for (;;) {
        this.assertBudget(session, model.reservationUsdPerTurn);
        const reservation = { requestId: randomUUID(), usd: model.reservationUsdPerTurn };
        await this.persistence.reserve(handle, reservation);
        session.pendingReservationUsd += reservation.usd;
        session.turns += 1;
        const started = Date.now();
        const params: MessageCreateParamsNonStreaming = {
          model: model.id, stream: false,
          max_tokens: Math.min(model.maxOutputTokensPerTurn, request.budget.maxTokens - totalTokens(session.usage)),
          // 20260120 is currently documented and typed by the pinned 0.92 SDK.
          tools: [{ type: 'code_execution_20260120', name: 'code_execution' }],
          container: { ...(containerId ? { id: containerId } : {}), ...(skillList.length ? { skills: skillList } : {}) },
          system: [{ type: 'text', text: this.prompt.text, cache_control: { type: 'ephemeral' } }],
          messages,
        };
        let response;
        try {
          response = await this.call(session, signal, (options) => this.client.message(params, options));
        } catch (error: unknown) {
          const unknown: Usage = { ...emptyUsage(), costUsd: null, costExact: false };
          session.usage = addUsage(session.usage, unknown);
          // Never refund a request whose provider execution/billing is uncertain.
          await this.persistence.settle(handle, { requestId: reservation.requestId, usage: unknown, uncertain: true });
          await this.persistence.usageChanged(handle, session.usage);
          throw error;
        }
        const usage = calculateUsage(response.usage, model.prices, Date.now() - started, true);
        session.usage = addUsage(session.usage, usage);
        session.privateTranscript.push({ stage, response });
        // References must be persisted even if the response subsequently fails a
        // usage/protocol gate, so cleanup can find all remotely created files.
        let persistenceFailure: unknown;
        for (const id of extractGeneratedFileIds(response.content)) {
          if (session.inputs.some((input) => input.providerId === id)) {
            persistenceFailure = new DocSandboxError('E_PROVIDER', 502);
            continue;
          }
          try { await this.trackFile(session, id, 'output'); } catch (error: unknown) { persistenceFailure = error; }
          exportIds.add(id);
        }
        if (response.container?.id) {
          if (containerId && response.container.id !== containerId) persistenceFailure = new DocSandboxError('E_PROVIDER', 502);
          // Every response may extend the container's retention window. Even an
          // unexpected replacement ID must be tracked before rejecting it.
          try { await this.persistence.containerCreated(handle, {
            id: response.container.id, expiresAt: providerContainerRetentionDeadline(response.container.expires_at), stage,
          }); } catch (error: unknown) { persistenceFailure = error; }
          containerId = response.container.id;
        }
        await this.persistence.settle(handle, { requestId: reservation.requestId, usage, uncertain: usage.costUsd === null });
        if (usage.costUsd !== null) session.pendingReservationUsd -= reservation.usd;
        await this.persistence.usageChanged(handle, session.usage);
        if (persistenceFailure) throw persistenceFailure;
        if (exportIds.size > MAX_EXPORT_FILES) throw new DocSandboxError('E_PROVIDER', 502);
        if (session.controller.signal.aborted) throw new DocSandboxError('E_CANCELLED', 409);
        await this.emit(session, { type: 'tool_call', payload: {
          phase: stage, turn: session.turns,
          count: response.content.filter((block) => block.type === 'server_tool_use').length,
        } }, onEvent);
        if (session.usage.costUsd === null || session.usage.costUsd > request.budget.maxCostUsd
          || totalTokens(session.usage) > request.budget.maxTokens) throw new DocSandboxError('E_QUOTA', 429);
        if (response.stop_reason === 'pause_turn') {
          if (!containerId) throw new DocSandboxError('E_PROVIDER', 502);
          // The provider documents replaying the assistant response unchanged.
          messages.push({ role: 'assistant', content: response.content });
          continue;
        }
        if (response.stop_reason !== 'end_turn') throw new DocSandboxError('E_PROVIDER', 502);
        break;
      }
      session.artifacts = await this.collectArtifacts(session, exportIds, request);
      const planArtifact = session.artifacts.find((artifact) => artifact.kind === 'edit_plan');
      if (!planArtifact) throw new DocSandboxError('E_PROVIDER', 502);
      const plan = editPlanSchema.parse(parseJsonArtifact(planArtifact.data));
      this.checkInputPlan(session, plan);
      session.stage = stage;
      if (stage === 'plan') return { status: 'planned', editPlan: plan, usage: { ...session.usage }, transcript: [...session.transcript] };
      if (!request.approvedPlan || JSON.stringify(plan) !== JSON.stringify(editPlanSchema.parse(request.approvedPlan))) throw new DocSandboxError('E_VALIDATION', 422);
      const resultArtifact = session.artifacts.find((artifact) => artifact.kind === 'agent_result');
      if (!resultArtifact) throw new DocSandboxError('E_PROVIDER', 502);
      const result = agentResultSchema.parse(parseJsonArtifact(resultArtifact.data));
      let outcome: DocumentOutcome;
      try { outcome = classifyAgentResult(plan, result); }
      catch { throw new DocSandboxError('E_VALIDATION', 422); }
      return { status: outcome === 'not_possible' ? 'not_possible' : 'edited', editPlan: plan, agentResult: { ...result, outcome },
        usage: { ...session.usage }, transcript: [...session.transcript] };
    } catch (error: unknown) {
      // A partially collected bundle is never available after a failed run.
      session.artifacts = [];
      throw this.safeError(error, session);
    } finally {
      signal?.removeEventListener('abort', abort);
      session.busy = false;
    }
  }

  async downloadOutputs(handle: SandboxSession): Promise<Artifact[]> {
    const session = this.session(handle);
    if (session.busy || !session.stage) throw new DocSandboxError('E_CONFLICT', 409);
    const transcriptData = Buffer.from(JSON.stringify(session.privateTranscript), 'utf8');
    return [
      ...session.artifacts.map((artifact) => ({ ...artifact, data: Buffer.from(artifact.data) })),
      { name: 'transcript.json', kind: 'transcript', mime: JSON_MIME, data: transcriptData, sha256: sha256(transcriptData) },
    ];
  }

  async destroy(handle: SandboxSession): Promise<void> {
    const session = this.sessions.get(handle.id);
    if (!session) return;
    if (session.handle !== handle) throw new DocSandboxError('E_FORBIDDEN', 403);
    session.closing = true;
    session.controller.abort();
    // Abort is independent of cleanup. Abort of an HTTP request does not claim to
    // instantly destroy the provider container (no such API is assumed).
    let failed = false;
    for (const [id, kind] of session.files) {
      try {
        await this.deleteFile(session, id);
        await this.persistence.fileChanged(handle, { id, kind, state: 'deleted' });
        session.files.delete(id);
      } catch {
        failed = true;
        try { await this.persistence.fileChanged(handle, { id, kind, state: 'delete_failed' }); } catch { /* Retain session and fail cleanup below. */ }
      }
    }
    session.artifacts = [];
    session.privateTranscript = [];
    if (failed || session.busy) throw new DocSandboxError('E_PROVIDER', 502);
    session.closed = true;
    this.sessions.delete(handle.id);
  }

  private session(handle: SandboxSession): SessionState {
    const session = this.sessions.get(handle.id);
    if (!session || session.handle !== handle || session.closed || session.closing) throw new DocSandboxError('E_FORBIDDEN', 403);
    return session;
  }

  private acquire(session: SessionState): void {
    if (session.busy) throw new DocSandboxError('E_CONFLICT', 409);
    session.busy = true;
  }

  private checkRequest(session: SessionState, request: RunRequest): void {
    if (!session.inputs.length || request.mode !== 'preserve' || !request.instructions.trim() || request.instructions.length > 100_000) throw new DocSandboxError('E_PARAMS');
    const budget = request.budget;
    if (![budget.maxTurns, budget.maxTokens, budget.timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)
      || !Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd <= 0) throw new DocSandboxError('E_PARAMS');
    if (session.stage === 'edit' || (session.stage === 'plan' && request.stage === 'plan')) throw new DocSandboxError('E_CONFLICT', 409);
    if (request.stage === 'edit') {
      if (!request.approvedPlan) throw new DocSandboxError('E_PARAMS');
      this.checkInputPlan(session, editPlanSchema.parse(request.approvedPlan));
    }
    const expectedFormats = [...new Set(session.inputs.map((input) => input.format))].sort();
    if (JSON.stringify([...new Set(request.formats)].sort()) !== JSON.stringify(expectedFormats)) throw new DocSandboxError('E_PARAMS');
    if (session.budget && JSON.stringify(session.budget) !== JSON.stringify(budget)) throw new DocSandboxError('E_PARAMS');
    if (session.modelTier && session.modelTier !== request.modelTier) throw new DocSandboxError('E_PARAMS');
    // A queued job retains its selected model across configuration changes.
    // A replacement in the same tier is not permission to call that model.
    if (!request.requestedModel || this.config.models[request.modelTier]?.id !== request.requestedModel) {
      throw new DocSandboxError('E_NOT_READY', 503);
    }
    session.budget = { ...budget };
    session.modelTier = request.modelTier;
    session.deadline = Math.min(session.deadline, session.createdAt + budget.timeoutMs);
  }

  private checkInputPlan(session: SessionState, plan: EditPlan): void {
    if (plan.outputName !== session.inputs[0]?.name || !isSafeFilename(plan.outputName)) throw new DocSandboxError('E_VALIDATION', 422);
    if (Object.keys(plan.inputHashes).length !== session.inputs.length
      || session.inputs.some((input) => plan.inputHashes[input.id] !== input.sha256)) throw new DocSandboxError('E_VALIDATION', 422);
  }

  private assertBudget(session: SessionState, reservation: number): void {
    if (Date.now() >= session.deadline) throw new DocSandboxError('E_TIMEOUT', 408);
    if (session.controller.signal.aborted) throw new DocSandboxError('E_CANCELLED', 409);
    if (!session.budget || session.turns >= session.budget.maxTurns || totalTokens(session.usage) >= session.budget.maxTokens
      || session.usage.costUsd === null || session.usage.costUsd + session.pendingReservationUsd + reservation > session.budget.maxCostUsd) {
      throw new DocSandboxError('E_QUOTA', 429);
    }
  }

  private userPayload(session: SessionState, request: RunRequest): string {
    const primary = session.inputs[0];
    if (!primary) throw new DocSandboxError('E_PARAMS');
    const payload = {
      stage: request.stage,
      instructions: request.instructions,
      inputs: session.inputs.map((file, index) => ({ inputId: file.id, captureAlias: `input-${index}.${file.format}`,
        originalName: file.name, format: file.format, sha256: file.sha256 })),
      output: { originalName: primary.name, captureAlias: `document-output.${primary.format}`, inputId: primary.id },
      trustedInventory: request.inventory ?? null,
      approvedPlan: request.approvedPlan ?? null,
      contracts: contractExamples(primary.id, primary.name, Object.fromEntries(session.inputs.map((file) => [file.id, file.sha256]))),
      exports: request.stage === 'plan' ? ['edit_plan.json', 'manifest.json']
        : ['edit_plan.json', 'result.json', 'recipe.zip', `document-output.${primary.format}`, 'manifest.json'],
    };
    const result = JSON.stringify(payload);
    if (result.length > 1_000_000) throw new DocSandboxError('E_PARAMS');
    return result;
  }

  private async collectArtifacts(session: SessionState, exportIds: Set<string>, request: RunRequest): Promise<Artifact[]> {
    const captured = new Map<string, Buffer>();
    let totalBytes = 0;
    for (const id of exportIds) {
      const metadata = await this.call(session, request.signal, (options) => this.client.metadata(id, options));
      if (!isSafeFilename(metadata.filename) || metadata.id !== id || metadata.downloadable !== true || captured.has(metadata.filename)
        || metadata.size_bytes < 0 || !Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes > this.config.maxOutputBytes) {
        throw new DocSandboxError('E_PROVIDER', 502);
      }
      const data = await this.call(session, request.signal, async (options) => {
        const response = await this.client.download(id, options);
        return Buffer.from(await readBoundedResponse(response, this.config.maxOutputBytes - totalBytes, options.signal));
      });
      if (data.length !== metadata.size_bytes) throw new DocSandboxError('E_PROVIDER', 502);
      totalBytes += data.length;
      captured.set(metadata.filename, data);
    }
    const manifestData = captured.get('manifest.json');
    if (!manifestData) throw new DocSandboxError('E_PROVIDER', 502);
    const manifest = engineManifestSchema.parse(parseJsonArtifact(manifestData));
    if (manifest.stage !== request.stage || new Set(manifest.files.map((file) => file.filename)).size !== manifest.files.length
      || captured.size !== manifest.files.length + 1) throw new DocSandboxError('E_PROVIDER', 502);
    const primary = session.inputs[0];
    if (!primary) throw new DocSandboxError('E_PARAMS');
    const requirements: Array<{ name: string; kind: Artifact['kind'] }> = [{ name: 'edit_plan.json', kind: 'edit_plan' }];
    if (request.stage === 'edit') requirements.push({ name: 'result.json', kind: 'agent_result' }, { name: 'recipe.zip', kind: 'recipe' },
      { name: `document-output.${primary.format}`, kind: 'output' });
    if (requirements.length !== manifest.files.length) throw new DocSandboxError('E_PROVIDER', 502);
    const artifacts: Artifact[] = [];
    for (const requirement of requirements) {
      const file = manifest.files.find((item) => item.filename === requirement.name && item.kind === requirement.kind);
      const data = captured.get(requirement.name);
      if (!file || !data || sha256(data) !== file.sha256) throw new DocSandboxError('E_PROVIDER', 502);
      if (file.kind === 'output' && file.inputId !== primary.id) throw new DocSandboxError('E_PROVIDER', 502);
      if (file.kind !== 'output' && file.inputId !== undefined) throw new DocSandboxError('E_PROVIDER', 502);
      if (file.kind === 'recipe' && (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50)) throw new DocSandboxError('E_PROVIDER', 502);
      artifacts.push({ name: file.kind === 'output' ? primary.name : file.filename, kind: file.kind, data,
        sha256: file.sha256, mime: file.kind === 'output' ? primary.mime : file.kind === 'recipe' ? 'application/zip' : JSON_MIME });
    }
    // Preserve the validated transport manifest as a private transcript artefact.
    artifacts.push({ name: 'manifest.json', kind: 'transcript', data: manifestData, mime: JSON_MIME, sha256: sha256(manifestData) });
    return artifacts;
  }

  private async trackFile(session: SessionState, id: string, kind: 'input' | 'output'): Promise<void> {
    if (!/^file_[a-zA-Z0-9_-]{1,180}$/.test(id)) throw new DocSandboxError('E_PROVIDER', 502);
    if (session.files.has(id) && session.files.get(id) !== kind) throw new DocSandboxError('E_PROVIDER', 502);
    session.files.set(id, kind);
    if (session.persistedFiles.has(id)) return;
    try {
      await this.persistence.fileChanged(session.handle, { id, kind, state: 'known' });
      session.persistedFiles.add(id);
      if (session.closing) throw new DocSandboxError('E_CANCELLED', 409);
    } catch (error: unknown) {
      // Persistence failure must not orphan an unregistered remote file silently.
      try { await this.deleteFile(session, id); session.files.delete(id); } catch { /* destroy retries the retained reference. */ }
      throw error;
    }
  }

  private async deleteFile(session: SessionState, id: string): Promise<void> {
    const signal = AbortSignal.timeout(this.config.cleanupTimeoutMs);
    await this.client.delete(id, { signal, timeoutMs: this.config.cleanupTimeoutMs });
    session.persistedFiles.delete(id);
  }

  private async emit(session: SessionState, event: JobEvent, onEvent: (event: JobEvent) => Promise<void> | void): Promise<void> {
    session.transcript.push(event);
    await onEvent(event);
  }

  private async call<T>(session: SessionState, external: AbortSignal | undefined, operation: (options: ProviderCallOptions) => Promise<T>): Promise<T> {
    const remaining = Math.min(this.config.apiTimeoutMs, session.deadline - Date.now());
    if (remaining <= 0) throw new DocSandboxError('E_TIMEOUT', 408);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), remaining);
    const signals = [session.controller.signal, timeout.signal, ...(external ? [external] : [])];
    const combined = AbortSignal.any(signals);
    try {
      combined.throwIfAborted();
      const value = await operation({ signal: combined, timeoutMs: remaining });
      return value;
    } catch (error: unknown) {
      if (timeout.signal.aborted) throw new DocSandboxError('E_TIMEOUT', 408);
      if (combined.aborted) throw new DocSandboxError('E_CANCELLED', 409);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private safeError(error: unknown, session: SessionState): DocSandboxError {
    if (error instanceof DocSandboxError) return error;
    if (session.controller.signal.aborted) return new DocSandboxError('E_CANCELLED', 409);
    // Never attach raw SDK errors: their bodies can contain document text or keys.
    return new DocSandboxError('E_PROVIDER', 502);
  }
}
