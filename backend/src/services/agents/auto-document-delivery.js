const path = require('path');
const os = require('os');
const { runAdvancedDocumentPipeline } = require('../document-pipeline/advanced-document-pipeline');
const { renderPreview } = require('../doc-preview');
const { saveArtifact, EXTENSION_TO_MIME } = require('./task-tools');
const persistence = require('./agent-task-persistence');

function documentPrompt({ goal, finalText, policy }) {
  return [
    `Solicitud del usuario: ${goal || 'Crear documento profesional'}`,
    `Formato requerido: ${policy?.format || 'docx'}`,
    `Plantilla/paleta: ${policy?.template || 'business'}`,
    '',
    'Contenido base validado por el agente:',
    finalText || 'Genera un documento profesional con estructura ejecutiva, secciones claras, tablas cuando aporten valor y cierre accionable.',
  ].join('\n');
}

async function generateAutoDocument({
  task,
  goal,
  finalText,
  policy,
  signal,
  emit,
} = {}) {
  if (!policy || policy.mode === 'chat_only') return null;
  const format = policy.format || 'docx';
  const template = policy.template || 'business';
  const complexity = policy.complexity || 'standard';

  emit?.({
    type: 'checkpoint',
    label: 'Generación automática de documento',
    status: 'running',
    payload: { format, template, mode: policy.mode },
  });

  const result = await runAdvancedDocumentPipeline({
    prompt: documentPrompt({ goal, finalText, policy }),
    format,
    template,
    complexity,
    outputDir: path.join(os.tmpdir(), 'siragpt-agent-documents'),
    maxRepairAttempts: 2,
    signal,
  });

  const mime = result.artifact?.mime || EXTENSION_TO_MIME[format] || 'application/octet-stream';
  const filename = result.artifact?.filename || `siragpt_document.${format}`;
  const artifact = saveArtifact({
    filename,
    base64: result.buffer.toString('base64'),
    mime,
    ownerUserId: task.userId,
    chatId: task.chatId,
    validation: result.validation,
  });

  let previewHtml = null;
  if (['docx', 'xlsx', 'csv'].includes(format)) {
    try {
      const preview = await renderPreview(format, result.buffer.toString('base64'));
      previewHtml = preview?.html || null;
    } catch (err) {
      emit?.({
        type: 'quality_gate',
        gate: 'preview',
        passed: false,
        summary: `Preview no disponible: ${err.message}`,
      });
    }
  }

  const gatePayload = {
    format,
    checks: result.validation?.checks || {},
    attempts: result.attempts?.length || 1,
    sizeBytes: artifact.sizeBytes,
  };
  emit?.({
    type: 'quality_gate',
    gate: 'artifact_validation',
    label: `Validación ${format.toUpperCase()}`,
    passed: Boolean(result.validation?.passed),
    score: result.validation?.overallScore ?? null,
    summary: result.validation?.passed
      ? 'Documento verificado antes de entregar.'
      : 'Documento generado con advertencias de validación.',
    payload: gatePayload,
  });
  if ((result.attempts?.length || 0) > 1) {
    emit?.({
      type: 'repair_attempt',
      attempt: result.attempts.length - 1,
      status: result.validation?.passed ? 'resolved' : 'warning',
      message: 'La pipeline regeneró el documento tras una validación técnica.',
    });
  }
  emit?.({
    type: 'file_artifact',
    artifact: {
      id: artifact.id,
      filename: artifact.filename,
      format: artifact.format || format,
      mime: artifact.mime,
      sizeBytes: artifact.sizeBytes,
      downloadUrl: artifact.downloadUrl,
      previewHtml,
      validation: result.validation,
    },
  });

  await persistence.persistGeneratedArtifact({
    artifact: { ...artifact, validation: result.validation },
    task,
    previewHtml,
    validation: result.validation,
  });

  return { artifact, previewHtml, validation: result.validation, result };
}

module.exports = {
  generateAutoDocument,
};
