const OpenAI = require('openai');
const reactAgent = require('../react-agent');
const { buildTaskTools } = require('./task-tools');
const taskStore = require('./task-store');
const auditLog = require('./audit-log');
const metrics = require('./metrics');
const {
  buildExecutionProfile,
  validateFinalize,
} = require('./agentic-execution-profile');
const { buildUserIntentAlignmentProfile } = require('./user-intent-alignment');
const { buildAgentTaskPlan } = require('./agent-task-plan');
const { resolveTaskContract } = require('./task-contract-resolver');
const {
  buildUniversalTaskContract,
  deriveLegacyTaskContract,
  enforceLegacyTaskContract,
} = require('./universal-task-contract');
const {
  buildEnterpriseExecutionGraph,
  buildEnterpriseRuntimeProfile,
} = require('./enterprise-agentic-runtime');
const { buildToolRuntimePlan } = require('./enterprise-tool-gateway');
const { buildAgenticQaBoardReview } = require('./agentic-qa-board');
const { buildAgenticOperatingCore } = require('./agentic-operating-core');
const durableExecutionStore = require('./durable-execution-store');
const { buildDocumentDeliveryPolicy } = require('./document-delivery-policy');
const { getQueueName } = require('./agent-task-queue');
const persistence = require('./agent-task-persistence');
const { generateAutoDocument } = require('./auto-document-delivery');
const { buildLangGraphLayer } = require('./agentic-langgraph');
const { buildAgenticFrameworkStatus } = require('./agentic-frameworks');
const {
  buildUploadedFileContext,
  serializeMessageAttachments,
} = require('../message-attachments');

const prisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

function routeInternals() {
  return require('../../routes/agent-task').INTERNAL;
}

function buildFinalizeProfile(executionProfile, universalTaskContract) {
  const executableContractTools = new Set(
    (universalTaskContract?.required_tools || [])
      .filter((tool) => tool !== 'finalize')
      .filter((tool) => [
        'web_search',
        'create_document',
        'verify_artifact',
        'rag_retrieve',
        'self_rag_answer',
        'python_exec',
        'run_tests',
      ].includes(tool))
  );
  return {
    ...(executionProfile || {}),
    requiredTools: Array.from(new Set([
      ...(executionProfile?.requiredTools || []),
      ...executableContractTools,
    ])),
    minimumToolCalls: {
      ...(executionProfile?.minimumToolCalls || {}),
      ...(universalTaskContract?.source_requirements?.verification_policy === 'strict' && executableContractTools.has('web_search')
        ? { web_search: Math.max(2, executionProfile?.minimumToolCalls?.web_search || 0) }
        : {}),
    },
  };
}

function summarizeForChat(text, policy) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const intro = `Preparé el entregable profesional en formato ${String(policy?.format || 'documento').toUpperCase()} y lo validé antes de adjuntarlo.`;
  if (!raw) return intro;
  const clipped = raw.length > 900 ? `${raw.slice(0, 900).trim()}...` : raw;
  return `${intro}\n\nResumen conversacional:\n\n${clipped}`;
}

function normalizeAgentRuntimeModel(selectedModel) {
  const displayModel = String(selectedModel || '').trim() || 'gpt-4o';
  const configuredFallback = String(
    process.env.AGENT_TASK_OPENAI_MODEL ||
    process.env.AGENT_TASK_RUNTIME_MODEL ||
    'gpt-4o-mini'
  ).trim();
  const isOpenAICompatible = /^(gpt-|o\d|chatgpt-|ft:gpt-|ft:o)/i.test(displayModel);
  return {
    displayModel,
    runtimeModel: isOpenAICompatible ? displayModel : configuredFallback,
    runtimeProvider: isOpenAICompatible ? 'selected-openai' : 'openai-fallback',
    remapped: !isOpenAICompatible,
  };
}

async function persistAssistantMessage({
  chatId,
  userId,
  assistantMessageId,
  streamState,
  task,
  status,
  artifacts,
  metadata,
}) {
  if (!chatId || !prisma) return null;
  try {
    const { serializeAgentState } = routeInternals();
    const data = {
      content: serializeAgentState(streamState),
      tokens: Math.ceil(serializeAgentState(streamState).length / 4),
      metadata: {
        source: 'agent-task',
        taskId: task.taskId,
        status,
        displayGoal: task.displayGoal,
        artifacts,
        updatedAt: new Date().toISOString(),
        ...metadata,
      },
    };
    if (assistantMessageId) {
      return prisma.message.update({ where: { id: assistantMessageId }, data });
    }
    const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
    if (!chat) return null;
    return prisma.message.create({
      data: { chatId, role: 'ASSISTANT', timestamp: new Date(), ...data },
    });
  } catch {
    return null;
  }
}

async function runAgentTaskJob(payload = {}, job = null) {
  const {
    taskId,
    traceId,
    user,
    goal,
    displayGoal,
    systemContract,
    files = [],
    fileMetadata = [],
    chatId = null,
    model = 'gpt-4o',
    maxSteps = 60,
    maxRuntimeMs = 2 * 60 * 60 * 1000,
  } = payload;
  if (!taskId) throw new Error('agent task payload missing taskId');
  if (!user?.id) throw new Error('agent task payload missing user.id');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const internals = routeInternals();
  const controller = new AbortController();
  const startedAt = Date.now();
  const existing = taskStore.getTaskSnapshotForUser(taskId, user.id);
  let streamState = existing?.streamState || internals.initialAgentState();
  let documentPolicy = payload.documentPolicy || existing?.documentPolicy || buildDocumentDeliveryPolicy({
    goal,
    displayGoal,
    files,
  });
  const runtimeModelProfile = normalizeAgentRuntimeModel(model);

  const executionProfile = buildExecutionProfile({ goal, fileIds: files });
  const intentAlignmentProfile = buildUserIntentAlignmentProfile({ request: goal, fileIds: files });
  const universalTaskContract = buildUniversalTaskContract({
    rawUserRequest: goal,
    fileIds: files,
  });
  const finalizeProfile = buildFinalizeProfile(executionProfile, universalTaskContract);
  let taskContract = deriveLegacyTaskContract(universalTaskContract);
  let taskContractSource = 'fallback';
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const resolved = await resolveTaskContract({
      goal,
      openai,
      fileIds: files,
      fallback: () => deriveLegacyTaskContract(universalTaskContract),
    });
    taskContract = enforceLegacyTaskContract(resolved.contract || taskContract, universalTaskContract);
    taskContractSource = resolved.source || taskContractSource;
  } catch (err) {
    console.warn('[agent-task-runner] task-contract resolver failed:', err?.message);
  }

  const taskPlan = buildAgentTaskPlan({
    goal,
    executionProfile,
    intentAlignmentProfile,
    universalTaskContract,
    fileIds: files,
    maxRuntimeMs,
  });
  const enterpriseExecutionGraph = buildEnterpriseExecutionGraph({
    contract: universalTaskContract,
    taskId,
    userId: user.id,
    chatId,
  });
  const enterpriseToolRuntimePlan = buildToolRuntimePlan({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
  });
  const enterpriseQaBoardReview = buildAgenticQaBoardReview({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
    toolRuntimePlan: enterpriseToolRuntimePlan,
    phase: 'worker-preflight',
  });
  const agenticOperatingCore = buildAgenticOperatingCore({
    contract: universalTaskContract,
    graph: enterpriseExecutionGraph,
    toolRuntimePlan: enterpriseToolRuntimePlan,
    qaBoardReview: enterpriseQaBoardReview,
  });
  let durableExecution = null;
  try {
    durableExecution = durableExecutionStore.createDurableExecutionRecord({
      graph: enterpriseExecutionGraph,
      contract: universalTaskContract,
      taskId,
      userId: user.id,
      chatId,
      toolRuntimePlan: enterpriseToolRuntimePlan,
      qaBoardReview: enterpriseQaBoardReview,
    });
  } catch (err) {
    console.warn('[agent-task-runner] durable execution record failed:', err?.message || err);
  }
  const enterpriseRuntimeProfile = {
    ...buildEnterpriseRuntimeProfile(universalTaskContract, enterpriseExecutionGraph),
    agenticOperatingCore: agenticOperatingCore.summary,
    toolRuntime: enterpriseToolRuntimePlan.summary,
    qaPreflight: enterpriseQaBoardReview.summary,
    durableExecution: durableExecution
      ? {
        graphId: durableExecution.graphId,
        persisted: true,
        nodeCount: durableExecution.nodes.length,
        checkpointCount: durableExecution.checkpoints.length,
      }
      : { graphId: enterpriseExecutionGraph.graph_id, persisted: false },
  };

  const task = internals.createTaskRecord({
    taskId,
    userId: user.id,
    chatId,
    displayGoal,
    model,
    controller,
    maxSteps,
    maxRuntimeMs,
    streamState,
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    durableExecution,
    jobId: job?.id ? String(job.id) : existing?.jobId || taskId,
    queueName: getQueueName(),
    traceId: traceId || existing?.traceId || null,
    documentPolicy,
    status: 'running',
  });
  task.runtimeModel = runtimeModelProfile.runtimeModel;

  const artifacts = [];
  const persistProgress = (status = task.status) => {
    void persistence.upsertAgentTask({
      ...task,
      status,
      state: streamState,
      documentPolicy,
    });
    if (job) void job.updateProgress({ status, lastEventSeq: task.lastEventSeq || 0 });
  };
  const emit = (event) => {
    streamState = internals.reduceAgentState(streamState, event);
    task.streamState = streamState;
    const written = taskStore.appendTaskEvent(task, event, streamState, { eventLimit: internals.TASK_EVENT_LIMIT || 600 });
    if (written) {
      task.events = written.events || task.events;
      task.checkpoints = written.checkpoints || task.checkpoints;
      task.lastEventSeq = written.lastEventSeq || task.lastEventSeq;
      task.artifacts = written.artifacts || task.artifacts;
    }
    void persistence.appendAgentTaskEvent(task, task.events?.[task.events.length - 1] || event);
    metrics.counter('agent_task_events_total', { type: event.type || 'unknown' });
    persistProgress('running');
    return event;
  };

  emit({
    type: 'queue_status',
    taskId,
    status: 'running',
    queue: getQueueName(),
    jobId: job?.id ? String(job.id) : task.jobId,
    position: null,
    estimatedWaitMs: 0,
  });
  emit({ type: 'document_policy', policy: documentPolicy });

  const langGraphLayer = await buildLangGraphLayer({ taskId, documentPolicy });
  const tools = buildTaskTools();
  const frameworkStatus = await buildAgenticFrameworkStatus({ tools, langGraphLayer });
  emit({
    type: 'framework_status',
    taskId,
    ...frameworkStatus,
  });
  emit({
    type: 'checkpoint',
    label: langGraphLayer.enabled ? 'LangGraph durable listo' : 'Grafo durable fallback listo',
    status: 'saved',
    payload: {
      provider: langGraphLayer.provider,
      enabled: langGraphLayer.enabled,
      nodes: langGraphLayer.nodes,
      checkpointer: langGraphLayer.checkpointer || null,
      humanInTheLoop: Boolean(langGraphLayer.humanInTheLoop),
      fallback: langGraphLayer.fallback || null,
    },
  });

  emit({
    type: 'meta',
    taskId,
    goal: displayGoal,
    model,
    runtimeModel: runtimeModelProfile.runtimeModel,
    runtimeProvider: runtimeModelProfile.runtimeProvider,
    tools: tools.map((tool) => tool.name),
    executionProfile,
    intentAlignmentProfile,
    taskPlan,
    universalTaskContract,
    enterpriseExecutionGraph,
    enterpriseRuntimeProfile,
    enterpriseToolRuntimePlan,
    enterpriseQaBoardReview,
    agenticOperatingCore,
    frameworks: frameworkStatus,
    taskContract,
    taskContractSource,
  });

  auditLog.audit({
    event: 'agent_task_worker_started',
    taskId,
    userId: user.id,
    chatId,
    model,
    runtimeModel: runtimeModelProfile.runtimeModel,
    runtimeProvider: runtimeModelProfile.runtimeProvider,
    modelRemapped: runtimeModelProfile.remapped,
    queue: getQueueName(),
    jobId: job?.id ? String(job.id) : task.jobId,
    traceId: task.traceId,
    documentPolicy,
  });

  let assistantMessageId = existing?.assistantMessageId || null;
  const uploadedFileContext = await buildUploadedFileContext(prisma, {
    userId: user.id,
    fileIds: files,
  });
  if (chatId && prisma) {
    try {
      const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: user.id } });
      if (chat) {
        if (!existing?.assistantMessageId) {
          const messageFiles = await serializeMessageAttachments(prisma, {
            userId: user.id,
            fileIds: files,
            clientMetadata: fileMetadata,
          });
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: displayGoal,
              files: messageFiles.length ? messageFiles : null,
              timestamp: new Date(),
              metadata: { source: 'agent-task-user', taskId, fileIds: files },
            },
          });
        }
        const assistant = assistantMessageId
          ? null
          : await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: internals.serializeAgentState(streamState),
              timestamp: new Date(),
              metadata: {
                source: 'agent-task',
                taskId,
                status: 'running',
                displayGoal,
                documentPolicy,
              },
            },
          });
        assistantMessageId = assistantMessageId || assistant?.id || null;
        task.assistantMessageId = assistantMessageId;
        taskStore.markTaskStatus(task, 'running', { assistantMessageId, streamState });
      }
    } catch {
      // DB persistence is intentionally non-fatal for local/dev.
    }
  }

  let stepIdCounter = 0;
  let currentStepId = null;
  const runtimeTimer = setTimeout(() => controller.abort(), maxRuntimeMs + 5000);

  try {
    const toolCtx = {
      userId: user.id,
      userEmail: user.email,
      openai,
      signal: controller.signal,
      chatId,
      taskId,
      fileIds: files,
      displayGoal,
      taskContract,
      universalTaskContract,
      enterpriseExecutionGraph,
      enterpriseRuntimeProfile,
      enterpriseToolRuntimePlan,
      onEvent: (evt) => {
        const payloadEvent = { ...evt, stepId: evt.stepId || currentStepId };
        if (evt.type === 'file_artifact' && evt.artifact) {
          artifacts.push(evt.artifact);
          void persistence.persistGeneratedArtifact({ artifact: evt.artifact, task, validation: evt.artifact.validation });
        }
        if (evt.type === 'contract_review') {
          emit({
            type: 'quality_gate',
            gate: 'contract_review',
            label: 'Contrato de artefacto',
            passed: Boolean(evt.passed),
            summary: `${evt.testsPassed || 0}/${evt.testsTotal || 0} pruebas contractuales`,
            payload: evt,
          });
        }
        emit(payloadEvent);
      },
    };

    const result = await reactAgent.run(openai, {
      query: goal,
      tools,
      maxSteps,
      maxRuntimeMs,
      model: runtimeModelProfile.runtimeModel,
      extraSystem: internals.buildAgentSystemPrompt(
        systemContract,
        files,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        taskContract,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        uploadedFileContext
      ),
      ctx: toolCtx,
      finalizeGuard: ({ steps }) => validateFinalize(finalizeProfile, steps),
      onStepStart: (step) => {
        stepIdCounter += 1;
        currentStepId = `s${stepIdCounter}`;
        const thought = (step.thought || '').trim();
        const firstAction = step.actions?.[0];
        const label = thought || firstAction?.tool || 'Pensando...';
        const icon = internals.inferIconFor ? internals.inferIconFor(firstAction?.tool) : undefined;
        emit({ type: 'step_start', id: currentStepId, label: internals.shortLabel ? internals.shortLabel(label) : label, icon });
      },
      onStepDone: (step) => {
        const firstAction = step.actions?.[0];
        emit({ type: 'step_done', id: currentStepId, ok: !firstAction?.observation?.error });
        emit({
          type: 'checkpoint',
          label: `Paso ${stepIdCounter} guardado`,
          status: 'saved',
          payload: { stepId: currentStepId },
        });
        currentStepId = null;
      },
    });

    let finalMarkdown = result.finalAnswer || '';
    documentPolicy = buildDocumentDeliveryPolicy({
      goal,
      displayGoal,
      finalText: finalMarkdown,
      files,
      requestedFormat: documentPolicy?.format,
    });
    task.documentPolicy = documentPolicy;
    emit({ type: 'document_policy', policy: documentPolicy });

    if (documentPolicy.autoGenerate && artifacts.length === 0) {
      try {
        const generated = await generateAutoDocument({
          task,
          goal: displayGoal,
          finalText: finalMarkdown,
          policy: documentPolicy,
          signal: controller.signal,
          emit,
        });
        if (generated?.artifact) artifacts.push({
          id: generated.artifact.id,
          filename: generated.artifact.filename,
          mime: generated.artifact.mime,
          sizeBytes: generated.artifact.sizeBytes,
          downloadUrl: generated.artifact.downloadUrl,
        });
        finalMarkdown = summarizeForChat(finalMarkdown, documentPolicy);
      } catch (err) {
        emit({
          type: 'repair_attempt',
          attempt: 1,
          status: 'failed',
          message: `La generación automática de documento falló: ${err.message}`,
        });
      }
    }

    if (finalMarkdown) emit({ type: 'final_text', markdown: finalMarkdown });
    const doneEvent = emit({
      type: 'done',
      stoppedReason: result.stoppedReason,
      stats: { steps: result.steps.length, artifacts: artifacts.length },
    });

    const status = result.stoppedReason === 'aborted' ? 'cancelled' : 'completed';
    task.status = status;
    task.updatedAt = new Date().toISOString();
    const dbMessage = await persistAssistantMessage({
      chatId,
      userId: user.id,
      assistantMessageId,
      streamState,
      task,
      status,
      artifacts,
      metadata: {
        documentPolicy,
        runtimeModel: runtimeModelProfile.runtimeModel,
        selectedModel: model,
        executionProfile,
        intentAlignmentProfile,
        taskPlan,
        universalTaskContract,
        enterpriseExecutionGraph,
        enterpriseRuntimeProfile,
        enterpriseToolRuntimePlan,
        enterpriseQaBoardReview,
        agenticOperatingCore,
        frameworks: frameworkStatus,
        durableExecution: enterpriseRuntimeProfile.durableExecution,
        stoppedReason: result.stoppedReason,
        maxSteps,
        maxRuntimeMs,
      },
    });
    if (dbMessage?.id && doneEvent) {
      emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
    }

    taskStore.markTaskStatus(task, status, {
      streamState,
      stats: {
        steps: result.steps.length,
        artifacts: artifacts.length,
        durationMs: Date.now() - startedAt,
        stoppedReason: result.stoppedReason,
      },
      artifacts,
    });
    if (task.durableExecution?.graphId) {
      try {
        durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
          stats: {
            steps: result.steps.length,
            artifacts: artifacts.length,
            durationMs: Date.now() - startedAt,
            stoppedReason: result.stoppedReason,
          },
        });
      } catch (err) {
        console.warn('[agent-task-runner] durable graph status write failed:', err.message);
      }
    }
    metrics.counter('agent_task_invocations_total', { status });
    metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
    metrics.counter('agent_task_artifacts_total', { status }, artifacts.length);
    persistProgress(status);
    auditLog.audit({
      event: 'agent_task_worker_finished',
      taskId,
      userId: user.id,
      chatId,
      status,
      stoppedReason: result.stoppedReason,
      steps: result.steps.length,
      artifacts: artifacts.length,
      durationMs: Date.now() - startedAt,
    });
    return { taskId, status, artifacts: artifacts.length };
  } catch (err) {
    const message = controller.signal.aborted ? 'Tarea detenida por el usuario.' : (err.message || 'agent task failed');
    task.status = controller.signal.aborted ? 'cancelled' : 'error';
    emit({ type: 'error', message });
    taskStore.markTaskStatus(task, task.status, {
      streamState,
      stats: { durationMs: Date.now() - startedAt, error: message },
    });
    persistProgress(task.status);
    auditLog.audit({
      event: 'agent_task_worker_failed',
      taskId,
      userId: user.id,
      chatId,
      status: task.status,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    if (task.status === 'error') throw err;
    return { taskId, status: task.status };
  } finally {
    clearTimeout(runtimeTimer);
  }
}

module.exports = {
  runAgentTaskJob,
};
