'use strict';

// Prod 2026-09-27 (verified turns): «transcribir en un docuemnto word» on a .md
// took 342 s through the agent loop; the first fast path (#880) answered in
// 15 s with a 30-word «Resumen ejecutivo» template because the authored
// document pipeline rewrote the transcript. The document is built verbatim.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fastPath = require('../src/services/agents/transcription-document-fast-path');

const policy = { mode: 'doc_required', format: 'docx', autoGenerate: true };
const transcript = Array.from({ length: 30 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] Hablante: línea ${i} de la transcripción.`).join('\n');

function deps({ source = transcript, buildError = null, format = 'docx' } = {}) {
  const calls = { built: [], emitted: [], starts: 0 };
  return {
    calls,
    args: {
      prisma: {}, userId: 'u1', fileIds: ['f1'], task: { taskId: 't1', userId: 'u1', chatId: 'c1' },
      documentPolicy: { ...policy, format },
      emit: (ev) => calls.emitted.push(ev),
      onStart: () => { calls.starts += 1; },
      buildTranscriptionTextFromFiles: async () => source,
      loadSourceNames: async () => ['Transcripcion_Justicia_Restaurativa_min15-65.md'],
      buildDocument: async (input) => {
        calls.built.push(input);
        if (buildError) throw buildError;
        return { artifact: { id: 'a1', filename: input.filename, format, mime: 'application/x', sizeBytes: 3611, downloadUrl: `/api/agent/artifact/a1` } };
      },
      logger: { warn: () => {} },
      now: new Date('2026-09-27T12:00:00Z'),
    },
  };
}

test('gating: transcription-to-file with document attachments, a verbatim format and no prior artifacts', () => {
  const base = { transcriptionToFileRequest: true, hasAttachedFiles: true, mediaBatchRows: null, wantsSourcePreservingEdit: false, documentPolicy: policy, artifactsCount: 0 };
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath(base), true);
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, documentPolicy: { ...policy, format: 'pdf' } }), true);
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, documentPolicy: { ...policy, format: 'xlsx' } }), false, 'xlsx/pptx keep the agent loop');
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, transcriptionToFileRequest: false }), false);
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, hasAttachedFiles: false }), false);
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, mediaBatchRows: [{ id: 'audio' }] }), false, 'audio/video keep the media batch');
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, wantsSourcePreservingEdit: true }), false);
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, documentPolicy: { ...policy, autoGenerate: false } }), false);
  assert.equal(fastPath.shouldUseTranscriptionDocumentFastPath({ ...base, artifactsCount: 1 }), false);
});

test('the document body is the transcript itself, named after the source file', async () => {
  const { args, calls } = deps();
  const out = await fastPath.runTranscriptionDocumentFastPath(args);
  assert.equal(out.handled, true);
  assert.equal(out.sourceWords, fastPath.countWords(transcript));
  assert.equal(calls.starts, 1);
  assert.equal(calls.built.length, 1);
  const built = calls.built[0];
  assert.equal(built.format, 'docx');
  assert.equal(built.filename, 'Transcripcion_Justicia_Restaurativa_min15-65.docx');
  assert.match(built.markdown, /^# Transcripción — Transcripcion_Justicia_Restaurativa_min15-65\n/);
  assert.match(built.markdown, /Transcripción literal de el archivo «Transcripcion_Justicia_Restaurativa_min15-65\.md»/);
  for (const line of transcript.split('\n')) assert.ok(built.markdown.includes(line), `verbatim line kept: ${line}`);
  assert.match(built.markdown, /línea 0 de la transcripción\.\n\n\[00:01:00\]/, 'each transcript line is its own paragraph');
  assert.match(out.finalMarkdown, /Transcribí el archivo adjunto en un documento Word, sin resumir ni alterar el contenido/);
  assert.match(out.finalMarkdown, /\[Transcripcion_Justicia_Restaurativa_min15-65\.docx\]\(\/api\/agent\/artifact\/a1\)/);
  assert.ok(calls.emitted.some((ev) => ev.type === 'checkpoint' && /Transcripción tomada del archivo adjunto/.test(ev.label)));
});

test('an attachment without usable text, or a non-verbatim format, is left to the agent loop', async () => {
  const short = deps({ source: 'solo tres palabras' });
  assert.deepEqual(await fastPath.runTranscriptionDocumentFastPath(short.args), { handled: false, reason: 'source_too_short', sourceWords: 3 });
  assert.equal(short.calls.starts, 0);
  const pptx = deps({ format: 'pptx' });
  assert.deepEqual(await fastPath.runTranscriptionDocumentFastPath(pptx.args), { handled: false, reason: 'format_not_verbatim' });
});

test('a failed build falls back instead of failing the turn; an abort propagates', async () => {
  const failing = deps({ buildError: new Error('docx writer down') });
  const out = await fastPath.runTranscriptionDocumentFastPath(failing.args);
  assert.equal(out.handled, false);
  assert.equal(out.reason, 'generation_failed');
  const controller = new AbortController();
  const aborted = deps({ buildError: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
  const original = aborted.args.buildDocument;
  aborted.args.buildDocument = async (input) => { controller.abort(); return original(input); };
  aborted.args.signal = controller.signal;
  await assert.rejects(fastPath.runTranscriptionDocumentFastPath(aborted.args), /aborted/);
});

test('filename and markdown helpers', () => {
  assert.equal(fastPath.transcriptionFilename(['Acta reunión 12/05.md'], 'pdf'), 'Acta reunión 12 05 (transcripción).pdf');
  assert.equal(fastPath.transcriptionFilename(['transcripcion_clase.txt'], 'docx'), 'transcripcion_clase.docx');
  assert.equal(fastPath.transcriptionFilename([], 'docx'), 'transcripcion.docx');
  const md = fastPath.transcriptionDocumentMarkdown({ sourceNames: ['a.md', 'b.md'], text: 'uno\r\ndos\n\n\n\ntres', now: new Date('2026-09-27T12:00:00Z') });
  assert.match(md, /^# Transcripción\n/);
  assert.match(md, /«a\.md», «b\.md»/);
  assert.equal(md.split('\n\n').slice(2).join('\n\n').trim(), 'uno\n\ndos\n\ntres');
  const headed = fastPath.transcriptionDocumentMarkdown({
    sourceNames: ['acta.html'],
    text: 'HTML document — "Acta" — 176 words, 1165 chars\n---\nPrimera línea\nPDF document — 3 page(s), 900 characters extracted\n---\nSegunda línea',
    now: new Date('2026-09-27T12:00:00Z'),
  });
  assert.doesNotMatch(headed, /document —|^---$/m);
  assert.match(headed, /Primera línea\n\nSegunda línea/);
  assert.equal(fastPath.stripExtractorHeaders('Word document — 12 characters extracted, structure preserved as markdown\n---\nHola'), 'Hola');
  assert.equal(fastPath.stripExtractorHeaders('Un document — no es cabecera porque va en medio'), 'Un document — no es cabecera porque va en medio');
  const unknown = fastPath.buildTranscriptionDeliveryMarkdown({ fileCount: 3, format: 'pdf', artifact: { filename: 'x.pdf', downloadUrl: '/x' } });
  assert.match(unknown, /los 3 archivos adjuntos en un documento PDF/);
});

test('the default builder writes a real Word whose text is the transcript (no model)', async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const PizZip = require('pizzip');
  const saved = [];
  const taskTools = require('../src/services/agents/task-tools');
  const originalSave = taskTools.saveVerifiedArtifact;
  const persistence = require('../src/services/agents/agent-task-persistence');
  const originalPersist = persistence.persistGeneratedArtifact;
  const docService = require('../src/services/document-service');
  const originalCreate = docService.createDocument;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-'));
  docService.createDocument = async (userId, filename, content) => {
    const filePath = path.join(tmp, filename);
    await originalCreate.call(docService, `verbatim-test-${process.pid}`, filename, content).then(async (r) => { await fs.promises.copyFile(r.filePath, filePath); await fs.promises.rm(path.dirname(r.filePath), { recursive: true, force: true }); });
    return { filePath, safeFilename: filename };
  };
  taskTools.saveVerifiedArtifact = async (input) => {
    const artifact = await originalSave(input);
    assert.equal(artifact.validation.passed, true);
    assert.equal(artifact.validation.structure.summary.reader, 'python-docx');
    saved.push(input);
    return { ...artifact, id: 'art1' };
  };
  persistence.persistGeneratedArtifact = async () => ({});
  try {
    const events = [];
    const out = await fastPath.buildVerbatimTranscriptionDocument({
      task: { userId: 'u1', chatId: null }, filename: 'prueba.docx', format: 'docx', emit: (ev) => events.push(ev),
      markdown: fastPath.transcriptionDocumentMarkdown({ sourceNames: ['prueba.md'], text: transcript }),
    });
    assert.equal(out.artifact.id, 'art1');
    const xml = new PizZip(Buffer.from(saved[0].base64, 'base64')).file('word/document.xml').asText().replace(/<[^>]+>/g, ' ');
    assert.match(xml, /Hablante: línea 0 de la transcripción/);
    assert.match(xml, /línea 29 de la transcripción/);
    assert.ok(events.some((ev) => ev.type === 'file_artifact' && ev.artifact.id === 'art1'));
  } finally {
    taskTools.saveVerifiedArtifact = originalSave;
    persistence.persistGeneratedArtifact = originalPersist;
    docService.createDocument = originalCreate;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
