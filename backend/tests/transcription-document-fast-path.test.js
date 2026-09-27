'use strict';

// Prod 2026-09-27 (verified turn): «transcribir en un docuemnto word» on a
// .md took 342 s through the agent loop before generating a 3.6 KB Word from
// text the runner already had. The fast path builds the document straight
// from the attachment's extracted text and only when that text is real.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fastPath = require('../src/services/agents/transcription-document-fast-path');

const policy = { mode: 'doc_required', format: 'docx', autoGenerate: true };
const transcript = Array.from({ length: 30 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] Hablante: línea ${i} de la transcripción.`).join('\n');

function deps({ source = transcript, artifact = { id: 'a1', filename: 'Transcripcion.docx', format: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 3611, downloadUrl: 'https://uploads.example/a1.docx' }, generateError = null } = {}) {
  const calls = { source: 0, generate: [], emitted: [], starts: 0 };
  return {
    calls,
    args: {
      prisma: {}, userId: 'u1', fileIds: ['f1'], task: { taskId: 't1' }, goal: 'transcribir en un docuemnto word', documentPolicy: policy,
      emit: (ev) => calls.emitted.push(ev),
      onStart: () => { calls.starts += 1; },
      buildTranscriptionTextFromFiles: async () => { calls.source += 1; return source; },
      generateAutoDocument: async (input) => { calls.generate.push(input); if (generateError) throw generateError; return { artifact }; },
      logger: { warn: () => {} },
    },
  };
}

test('gating: only a transcription-to-file with document attachments, a document policy and no prior artifacts', () => {
  const base = { transcriptionToFileRequest: true, hasAttachedFiles: true, mediaBatchRows: null, wantsSourcePreservingEdit: false, documentPolicy: policy, artifactsCount: 0 };
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath(base), true);
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, transcriptionToFileRequest: false }), false, 'plain chat request');
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, hasAttachedFiles: false }), false, 'nothing to transcribe');
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, mediaBatchRows: [{ id: 'audio' }] }), false, 'audio/video keep the media batch');
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, wantsSourcePreservingEdit: true }), false, 'surgical edits keep the editor');
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, documentPolicy: { ...policy, autoGenerate: false } }), false, 'chat-only policy');
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, artifactsCount: 1 }), false, 'already delivered');
});

test('delivers the document from the attachment text and answers with the file link', async () => {
  const { args, calls } = deps();
  const out = await fastPath.runTranscriptionDocumentFastPath(args);
  assert.equal(out.handled, true);
  assert.equal(out.sourceWords, fastPath.countWords(transcript));
  assert.equal(calls.starts, 1);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.generate[0].finalText, transcript, 'the Word body is the transcript itself, not a summary');
  assert.equal(calls.generate[0].policy, policy);
  assert.deepEqual(out.artifact, { id: 'a1', filename: 'Transcripcion.docx', format: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 3611, downloadUrl: 'https://uploads.example/a1.docx' });
  assert.match(out.finalMarkdown, /Transcribí el archivo adjunto en un documento Word, sin resumir ni alterar el contenido/);
  assert.match(out.finalMarkdown, /\[Transcripcion\.docx\]\(https:\/\/uploads\.example\/a1\.docx\)/);
  assert.ok(calls.emitted.some((ev) => ev.type === 'checkpoint' && /Transcripción tomada del archivo adjunto/.test(ev.label)));
});

test('an attachment without usable text is left to the agent loop, without opening a step', async () => {
  const { args, calls } = deps({ source: 'solo tres palabras' });
  const out = await fastPath.runTranscriptionDocumentFastPath(args);
  assert.deepEqual(out, { handled: false, reason: 'source_too_short', sourceWords: 3 });
  assert.equal(calls.starts, 0);
  assert.equal(calls.generate.length, 0);
});

test('a failed generation falls back instead of failing the turn; an abort propagates', async () => {
  const failing = deps({ generateError: new Error('pipeline down') });
  const out = await fastPath.runTranscriptionDocumentFastPath(failing.args);
  assert.equal(out.handled, false);
  assert.equal(out.reason, 'generation_failed');

  const controller = new AbortController();
  const aborted = deps({ generateError: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
  const originalGenerate = aborted.args.generateAutoDocument;
  aborted.args.generateAutoDocument = async (input) => { controller.abort(); return originalGenerate(input); };
  aborted.args.signal = controller.signal;
  await assert.rejects(fastPath.runTranscriptionDocumentFastPath(aborted.args), /aborted/);
});

test('delivery text names the format and the number of files', () => {
  const artifact = { filename: 'Actas.pdf', downloadUrl: 'https://x/actas.pdf' };
  assert.match(fastPath.buildTranscriptionDeliveryMarkdown({ fileCount: 3, format: 'pdf', artifact }), /los 3 archivos adjuntos en un documento PDF/);
  assert.match(fastPath.buildTranscriptionDeliveryMarkdown({ fileCount: 1, format: 'xlsx', artifact }), /documento Excel/);
  const unknown = fastPath.buildTranscriptionDeliveryMarkdown({ fileCount: 1, format: 'unknown', artifact });
  assert.match(unknown, /en un documento, sin resumir/);
  assert.doesNotMatch(unknown, /documento documento/);
});
