'use strict';

const { isLinkTranscriptionRequest, resolveMediaLinkContext } = require('../media-link-context');

// This is permission to stop, not an intent router. Recognize only a complete,
// simple transcription request; unfamiliar wording keeps normal verification.
// In particular, a brief whose primary deliverable is "transcription" can
// still ask for a summary, translation or a second task after the transcript.
const TRANSCRIPTION_WORDS = new Set(`hola por favor porfavor porfa gracias puedes podrias
  quiero necesito que me ayudes a la el los las un una de del en y e este ese estos esos
  enlace enlaces link links url urls video videos audio audios youtube
  transcribir transcribe transcribeme transcripcion transcripciones transcribas
  completo completa completos completas todo toda todos todas integro integra
  literal literalmente palabra palabras texto con sin marcas tiempo timestamps
  desde hasta al minuto minutos segundo segundos hora horas inicio final fin
  solo solamente ahora`.split(/\s+/));

function createMediaDeliveryCompletionPolicy({ prompt, history = [], files = [], requiredTools = [], requestBrief } = {}) {
  if ((Array.isArray(files) && files.length) || requiredTools.some(name => name !== 'transcribe_url')
      || (requestBrief?.deliverable?.kind && requestBrief.deliverable.kind !== 'transcription')
      || !isLinkTranscriptionRequest(prompt)) return null;
  const urls = [];
  let invalidUrl = false;
  const remaining = String(prompt || '').replace(/(?:https?:\/\/|(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\/)[^\s<>"'`\]]+/gi, raw => {
    const source = resolveMediaLinkContext({ prompt: `Transcribir ${raw}` });
    if (!source) invalidUrl = true;
    else urls.push(source.url);
    return ' enlace ';
  });
  if (invalidUrl) return null;
  if (!urls.length) {
    const source = resolveMediaLinkContext({ prompt, history, files });
    if (!source) return null;
    urls.push(source.url);
  }
  // Matching the source does not prove that the requested time range was
  // queued. Keep numeric constraints on the normal verification path.
  if (/\d/.test(remaining)) return null;
  const words = remaining.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[.,;:!?¿¡()[\]–—-]/g, ' ').trim().split(/\s+/);
  if (words.some(word => !TRANSCRIPTION_WORDS.has(word)
      // Reuse the canonical verb/typo recognition instead of drifting from
      // the resolver that selected this transcription lane.
      && !isLinkTranscriptionRequest(`${word} enlace`))) return null;
  const expectedSources = [...new Set(urls)];
  return payload => resolveMediaDeliveryCompletion({ ...payload, expectedSources });
}

// Only the executed server tool can acknowledge a durable hand-off. A model's
// proposed arguments, prose, or another tool's similar fields are not evidence.
function readMediaDeliveryHandoff(toolName, result) {
  if (toolName !== 'transcribe_url' || !result || typeof result !== 'object'
      || result.ok !== true || result.deferred !== true || result.error) return null;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  if (!validId(result.fileId) || !validId(result.delivery)
      || typeof result.userMessage !== 'string' || !result.userMessage.trim()) return null;
  return { fileId: result.fileId, deliveryId: result.delivery, message: result.userMessage.trim() };
}

function collectMediaDeliveryReferences(previous = {}, actions = []) {
  const handoffs = actions.map(action => readMediaDeliveryHandoff(action?.tool, action?.observation)).filter(Boolean);
  if (!handoffs.length) return previous;
  return {
    mediaDeliveryHandoff: previous.mediaDeliveryHandoff || handoffs[0].deliveryId,
    transcriptionFileIds: [...new Set([...(previous.transcriptionFileIds || []), ...handoffs.map(value => value.fileId)])],
  };
}

function coversWholeSource(result) {
  const duration = result?.durationSeconds;
  const range = result?.range;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    && range?.start === 0
    && (range.end === null || (typeof range.end === 'number' && Number.isFinite(range.end) && range.end >= duration));
}

function resolveMediaDeliveryCompletion({ toolName, result, steps = [], remainingToolNames = [], expectedSources = [], ctx } = {}) {
  if (ctx?.signal?.aborted || !readMediaDeliveryHandoff(toolName, result)) return null;
  // Finish the whole requested tool batch. In particular, don't drop a second
  // video or an unrelated operation scheduled after the first transcription.
  if (remainingToolNames.some(name => name !== 'finalize')) return null;
  const actions = steps.flatMap(step => Array.isArray(step?.actions) ? step.actions : []);
  // No completed side effect or failed operation may disappear behind a
  // successful job. Nor may the model forget a second URL requested by user.
  if (!actions.length || !expectedSources.length || actions.some(action => action?.tool !== 'transcribe_url')) return null;
  const completedSources = new Set(actions.map(action => action.observation?.source));
  if (completedSources.size !== expectedSources.length || expectedSources.some(url => !completedSources.has(url))) return null;
  const handoffs = actions.map(action => readMediaDeliveryHandoff(action.tool, action.observation));
  // A failed or inline transcription still needs the ordinary finalization
  // path; one successful hand-off must not hide the other result.
  if (handoffs.some(value => !value) || actions.some(action => !coversWholeSource(action.observation))) return null;
  const unique = [...new Map(handoffs.map(value => [value.deliveryId, value])).values()];
  return {
    finalAnswer: unique.map(value => value.message).join('\n\n'),
    stoppedReason: 'media_delivery_handoff',
    metadata: {
      mediaDeliveryHandoff: unique[0].deliveryId,
      transcriptionFileIds: [...new Set(unique.map(value => value.fileId))],
    },
  };
}

module.exports = { readMediaDeliveryHandoff, collectMediaDeliveryReferences, resolveMediaDeliveryCompletion, createMediaDeliveryCompletionPolicy };
