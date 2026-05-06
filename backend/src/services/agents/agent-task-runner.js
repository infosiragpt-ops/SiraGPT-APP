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
const { listManifests } = require('./tool-manifest');
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
const {
  generateVancouverMatrixDocument,
  isVancouverMatrixWordRequest,
} = require('./vancouver-table-document');
const { buildLangGraphLayer } = require('./agentic-langgraph');
const { buildAgenticFrameworkStatus } = require('./agentic-frameworks');
const {
  buildTranscriptionTextFromFiles,
  buildUploadedFileContext,
  isPlainTranscriptionRequest,
  resolveTranscriptionFileIds,
  serializeMessageAttachments,
} = require('../message-attachments');
const { assessAttachmentContext } = require('./attachment-context-guard');

const prisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

function routeInternals() {
  return require('../../routes/agent-task').INTERNAL;
}

function buildFinalizeProfile(executionProfile, universalTaskContract) {
  // Dynamic approved tool list from the manifest — no hardcoded names.
  // This stays current as new tools are registered without code changes.
  const appTools = new Set(listManifests().map((m) => m.name));
  const executableContractTools = new Set(
    (universalTaskContract?.required_tools || [])
      .filter((tool) => tool !== 'finalize')
      .filter((tool) => appTools.has(tool))
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
    const serialized = serializeAgentState(streamState);
    const data = {
      content: serialized,
      tokens: Math.ceil(serialized.length / 4),
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
  const plainTranscriptionRequest = isPlainTranscriptionRequest(goal);
  const deterministicVancouverRequest = isVancouverMatrixWordRequest(`${goal || ''} ${displayGoal || ''}`) &&
    Array.isArray(files) &&
    files.length > 0;
  if (!process.env.OPENAI_API_KEY && !plainTranscriptionRequest && !deterministicVancouverRequest) {
    throw new Error('OPENAI_API_KEY not configured');
  }

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
  const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
  if (!plainTranscriptionRequest && openai) {
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
    if (job) {
      // Catch and discard: BullMQ writes progress through Redis, which
      // can reject mid-failover. Without .catch() the rejection goes
      // unhandled and (depending on Node policy) can terminate the
      // worker. Progress is best-effort observability — never fatal.
      Promise.resolve(job.updateProgress({ status, lastEventSeq: task.lastEventSeq || 0 })).catch(() => {});
    }
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
  const finishDeterministicTask = async ({
    finalMarkdown,
    stoppedReason,
    steps,
    artifactsList = artifacts,
    metadata = {},
  }) => {
    if (finalMarkdown) emit({ type: 'final_text', markdown: finalMarkdown });
    const doneEvent = emit({
      type: 'done',
      stoppedReason,
      stats: { steps, artifacts: artifactsList.length },
    });

    const status = 'completed';
    task.status = status;
    task.updatedAt = new Date().toISOString();
    const dbMessage = await persistAssistantMessage({
      chatId,
      userId: user.id,
      assistantMessageId,
      streamState,
      task,
      status,
      artifacts: artifactsList,
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
        stoppedReason,
        maxSteps,
        maxRuntimeMs,
        ...metadata,
      },
    });
    if (dbMessage?.id && doneEvent) {
      emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
    }

    taskStore.markTaskStatus(task, status, {
      streamState,
      stats: {
        steps,
        artifacts: artifactsList.length,
        durationMs: Date.now() - startedAt,
        stoppedReason,
      },
      artifacts: artifactsList,
    });
    if (task.durableExecution?.graphId) {
      try {
        durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
          stats: {
            steps,
            artifacts: artifactsList.length,
            durationMs: Date.now() - startedAt,
            stoppedReason,
          },
        });
      } catch (err) {
        console.warn('[agent-task-runner] durable graph status write failed:', err.message);
      }
    }
    metrics.counter('agent_task_invocations_total', { status });
    metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
    metrics.counter('agent_task_artifacts_total', { status }, artifactsList.length);
    persistProgress(status);
    auditLog.audit({
      event: 'agent_task_worker_finished',
      taskId,
      userId: user.id,
      chatId,
      status,
      stoppedReason,
      steps,
      artifacts: artifactsList.length,
      durationMs: Date.now() - startedAt,
    });
    return { taskId, status, artifacts: artifactsList.length };
  };

  try {
    if (plainTranscriptionRequest) {
      const transcriptionFileIds = Array.isArray(files) && files.length
        ? files.map(String).filter(Boolean)
        : await resolveTranscriptionFileIds(prisma, {
          userId: user.id,
          chatId,
          providedFileIds: files,
        });
      const transcriptionText = await buildTranscriptionTextFromFiles(prisma, {
        userId: user.id,
        fileIds: transcriptionFileIds,
      });

      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: transcriptionText
          ? 'Solicitud de transcripción literal; se devuelve el texto extraído en el chat.'
          : 'Solicitud de transcripción literal sin contenido legible disponible.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          transcriptionOnly: true,
          fileCount: transcriptionFileIds.length,
          wordCount: transcriptionText ? transcriptionText.split(/\s+/).filter(Boolean).length : 0,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      const readStepId = 's1';
      const finalStepId = 's2';
      stepIdCounter = 1;
      emit({ type: 'step_start', id: readStepId, label: 'Leyendo archivo adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: readStepId, ok: Boolean(transcriptionText) });
      emit({
        type: 'checkpoint',
        label: transcriptionText ? 'Texto extraído' : 'Sin texto legible',
        status: transcriptionText ? 'saved' : 'warning',
        payload: { fileIds: transcriptionFileIds, textLength: transcriptionText.length },
      });
      stepIdCounter = 2;
      emit({ type: 'step_start', id: finalStepId, label: 'Preparando transcripción', icon: 'braces' });
      emit({ type: 'step_done', id: finalStepId, ok: true });

      const finalMarkdown = transcriptionText || 'No se encontró texto disponible para transcribir en los archivos adjuntos. Por favor, proporciona un archivo legible o más detalles sobre el contenido que deseas transcribir.';
      emit({ type: 'final_text', markdown: finalMarkdown });
      const doneEvent = emit({
        type: 'done',
        stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        stats: { steps: 2, artifacts: 0 },
      });

      const status = 'completed';
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
          stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
          transcriptionFileIds,
        },
      });
      if (dbMessage?.id && doneEvent) {
        emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
      }

      taskStore.markTaskStatus(task, status, {
        streamState,
        stats: {
          steps: 2,
          artifacts: 0,
          durationMs: Date.now() - startedAt,
          stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        },
        artifacts,
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
            stats: {
              steps: 2,
              artifacts: 0,
              durationMs: Date.now() - startedAt,
              stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
            },
          });
        } catch (err) {
          console.warn('[agent-task-runner] durable graph status write failed:', err.message);
        }
      }
      metrics.counter('agent_task_invocations_total', { status });
      metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
      metrics.counter('agent_task_artifacts_total', { status }, 0);
      persistProgress(status);
      auditLog.audit({
        event: 'agent_task_worker_finished',
        taskId,
        userId: user.id,
        chatId,
        status,
        stoppedReason: transcriptionText ? 'transcription_finalize' : 'no_transcription_content',
        steps: 2,
        artifacts: 0,
        durationMs: Date.now() - startedAt,
        transcriptionFileCount: transcriptionFileIds.length,
        transcriptionTextLength: transcriptionText.length,
      });
      return { taskId, status, artifacts: 0 };
    }

    // ── Thin-attachment guard ─────────────────────────────────────────
    // If the user attached files AND the question references the attachment
    // ("de qué es esto?", "qué dice este documento?"), but extraction
    // produced only a handful of useful words, refuse to bluff. Ask the
    // user for the real content instead — better UX than a confident
    // "no se pudo determinar..." follow-up wrapped in an auto DOCX.
    const attachmentStats = assessAttachmentContext({
      uploadedFileContext,
      files,
      userText: displayGoal || goal,
    });
    if (attachmentStats.isThin) {
      documentPolicy = {
        ...(documentPolicy || {}),
        mode: 'chat_only',
        autoGenerate: false,
        reason: 'Contexto adjunto insuficiente; se solicita material adicional al usuario.',
        thresholds: {
          ...(documentPolicy?.thresholds || {}),
          thinContextWords: attachmentStats.usefulWords,
          fileCount: files.length,
          transcriptionOnly: false,
        },
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      const stepId = 's1';
      stepIdCounter = 1;
      emit({ type: 'step_start', id: stepId, label: 'Revisando adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: stepId, ok: true });
      emit({
        type: 'checkpoint',
        label: 'Adjunto con contenido insuficiente',
        status: 'warning',
        payload: { usefulWords: attachmentStats.usefulWords, fileCount: files.length },
      });

      const wordsLabel = attachmentStats.usefulWords === 1 ? '1 palabra útil' : `${attachmentStats.usefulWords} palabras útiles`;
      const finalMarkdown = [
        `El material adjunto solo contiene ${wordsLabel}, lo que no me alcanza para responder tu pregunta con confianza.`,
        '',
        '**¿Puedes ayudarme con una de estas opciones?**',
        '- Pega el texto completo de la página o documento.',
        '- Sube el archivo original (PDF, DOCX, imagen completa).',
        '- Comparte el enlace de origen para revisar el contenido directamente.',
      ].join('\n');

      emit({ type: 'final_text', markdown: finalMarkdown });
      const doneEvent = emit({
        type: 'done',
        stoppedReason: 'thin_attachment_context',
        stats: { steps: 1, artifacts: 0 },
      });

      const status = 'completed';
      task.status = status;
      task.updatedAt = new Date().toISOString();
      const dbMessage = await persistAssistantMessage({
        chatId,
        userId: user.id,
        assistantMessageId,
        streamState,
        task,
        status,
        artifacts: [],
        metadata: {
          documentPolicy,
          runtimeModel: runtimeModelProfile.runtimeModel,
          selectedModel: model,
          stoppedReason: 'thin_attachment_context',
          attachmentStats,
        },
      });
      if (dbMessage?.id && doneEvent) {
        emit({ type: 'checkpoint', label: 'Mensaje persistido', status: 'saved', payload: { dbMessageId: dbMessage.id } });
      }

      taskStore.markTaskStatus(task, status, {
        streamState,
        stats: {
          steps: 1,
          artifacts: 0,
          durationMs: Date.now() - startedAt,
          stoppedReason: 'thin_attachment_context',
        },
        artifacts: [],
      });
      if (task.durableExecution?.graphId) {
        try {
          durableExecutionStore.markExecutionStatus(task.durableExecution.graphId, task.userId, status, {
            stats: {
              steps: 1,
              artifacts: 0,
              durationMs: Date.now() - startedAt,
              stoppedReason: 'thin_attachment_context',
            },
          });
        } catch (err) {
          console.warn('[agent-task-runner] durable graph status write failed:', err.message);
        }
      }
      metrics.counter('agent_task_invocations_total', { status });
      metrics.observe('agent_task_duration_ms', { status }, Date.now() - startedAt);
      metrics.counter('agent_task_artifacts_total', { status }, 0);
      persistProgress(status);
      auditLog.audit({
        event: 'agent_task_worker_finished',
        taskId,
        userId: user.id,
        chatId,
        status,
        stoppedReason: 'thin_attachment_context',
        steps: 1,
        artifacts: 0,
        durationMs: Date.now() - startedAt,
        attachmentStats,
      });
      return { taskId, status, artifacts: 0 };
    }

    if (deterministicVancouverRequest) {
      documentPolicy = {
        ...buildDocumentDeliveryPolicy({
          goal,
          displayGoal,
          files,
          requestedFormat: 'docx',
        }),
        mode: 'doc_required',
        format: 'docx',
        autoGenerate: true,
        reason: 'Solicitud explícita de tabla en Word con estructura Vancouver.',
      };
      task.documentPolicy = documentPolicy;
      emit({ type: 'document_policy', policy: documentPolicy });

      stepIdCounter = 1;
      emit({ type: 'step_start', id: 's1', label: 'Leyendo documento adjunto', icon: 'file-text' });
      emit({ type: 'step_done', id: 's1', ok: true });
      emit({
        type: 'checkpoint',
        label: 'Contenido documental disponible',
        status: 'saved',
        payload: {
          fileCount: files.length,
          contextChars: String(uploadedFileContext || '').length,
        },
      });

      stepIdCounter = 2;
      emit({ type: 'step_start', id: 's2', label: 'Construyendo matriz Vancouver', icon: 'table' });
      const generated = await generateVancouverMatrixDocument({
        prisma,
        task,
        userId: user.id,
        fileIds: files,
        goal: displayGoal || goal,
        emit,
      });
      if (generated?.artifact) artifacts.push(generated.artifact);
      emit({ type: 'step_done', id: 's2', ok: true });

      stepIdCounter = 3;
      emit({ type: 'step_start', id: 's3', label: 'Preparando entrega final', icon: 'check' });
      emit({ type: 'step_done', id: 's3', ok: true });

      return finishDeterministicTask({
        finalMarkdown: generated.finalMarkdown,
        stoppedReason: 'vancouver_matrix_docx',
        steps: 3,
        artifactsList: artifacts,
        metadata: {
          vancouverMatrix: true,
          sourceFileIds: files,
          validation: generated.validation,
        },
      });
    }

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
      prisma,
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
          format: generated.artifact.format,
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

// ── Error introspection & recovery helpers ─────────────────────
// Used externally by the job scheduler to decide retry strategy.

/**
 * Classify an error thrown by runAgentTaskJob to determine retry eligibility.
 * Returns { retryable, reason, ttlMs } where ttlMs is how long before retry
 * (0 = immediate, >0 = backoff).
 */
function classifyTaskError(err) {
  if (!err) return { retryable: false, reason: 'no-error' };
  const msg = String(err.message || err).toLowerCase();
  const code = String(err.code || err.statusCode || '').toLowerCase();

  // Retryable: network / rate-limit / timeout / temporary
  if (code.includes('rate_limit') || msg.includes('rate limit'))
    return { retryable: true, reason: 'rate-limited', ttlMs: 15_000 };
  if (code.includes('timeout') || msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnreset'))
    return { retryable: true, reason: 'network-timeout', ttlMs: 5_000 };
  if (code.startsWith('5') || msg.includes('internal server') || msg.includes('service unavailable') || msg.includes('bad gateway'))
    return { retryable: true, reason: 'server-error', ttlMs: 10_000 };
  if (msg.includes('too many requests') || code === '429')
    return { retryable: true, reason: 'throttled', ttlMs: 30_000 };

  // Non-retryable: auth, validation, config
  if (msg.includes('api_key') || msg.includes('authentication') || code === '401' || code === '403')
    return { retryable: false, reason: 'auth-failure' };
  if (msg.includes('missing') || msg.includes('invalid') || msg.includes('required'))
    return { retryable: false, reason: 'validation-error' };

  // Default: safe to retry once
  return { retryable: true, reason: 'unknown', ttlMs: 3_000 };
}

module.exports = {
  runAgentTaskJob,
  buildFinalizeProfile,
  classifyTaskError,
  normalizeAgentRuntimeModel,
};
