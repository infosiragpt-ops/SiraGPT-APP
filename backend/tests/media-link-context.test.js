'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const brief = require('../src/services/request-brief');
const { shouldUseAgenticChat } = require('../src/services/agentic-chat-stream');
const { resolveMediaLinkContext, isLinkTranscriptionRequest, extractMediaLinkSources } = require('../src/services/media-link-context');

const original = 'https://youtu.be/AbCdef12345?si=ShareToken&t=90';
const history = [
  { role: 'user', content: original },
  { role: 'assistant', content: '¿Qué quieres hacer con este enlace?' },
];

test('the screenshot Markdown uses its destination instead of its different URL-shaped label', () => {
  const prompt = '[youtu.be/SVN4/_Xw5VTU](https://youtu.be/SVN4_Xw5VTU ) transcribir';
  assert.deepEqual(resolveMediaLinkContext({ prompt }), { url: 'https://youtu.be/SVN4_Xw5VTU', source: 'explicit' });
  const request = brief.buildRequestBrief({ prompt });
  assert.equal(request.target.kind, 'url');
  assert.equal(request.deliverable.kind, 'transcription');
  assert.equal(request.mediaLink.url, 'https://youtu.be/SVN4_Xw5VTU');
});

test('Markdown titles, escapes and nested formatting preserve the exact href', () => {
  const url = 'https://media.example/Clip_(One).mp4?source=AbC#chapter';
  for (const markup of [
    `[video](${url})`,
    `**[https://label.example/wrong](${url})**`,
    `[video](<${url}> "Título descriptivo")`,
    `[video \\[capítulo\\]](${url} )`,
  ]) assert.deepEqual(resolveMediaLinkContext({ prompt: `${markup} transcribir` }), { url, source: 'explicit' }, markup);
});

test('Markdown hrefs share one source list with plain links and never invent a second source from labels', () => {
  const first = 'https://youtu.be/FirstVideo';
  const second = 'https://youtu.be/SecondVideo';
  assert.deepEqual(extractMediaLinkSources(`Transcribe [${second}](${first}) y ${second}`).urls, [first, second]);
  assert.equal(resolveMediaLinkContext({ prompt: `Transcribe [${second}](${first}) y ${second}` }), null);
  assert.deepEqual(extractMediaLinkSources(`Transcribe [uno](${first}) y [dos](${second})`).urls, [first, second]);
  assert.deepEqual(resolveMediaLinkContext({ prompt: `Transcribe [${second}](${first}) y ${first}` }), { url: first, source: 'explicit' });
  assert.deepEqual(resolveMediaLinkContext({ prompt: 'Transcribe este enlace', history: [{ role: 'user', content: `[${second}](${first})` }] }), { url: first, source: 'history' });
});

test('invalid Markdown destinations never use the URL label or a previous user link', () => {
  for (const destination of ['javascript:alert(1)', 'data:text/plain,audio', '../recording.mp4', '//example.test/video', 'https://', 'https://user:password@youtu.be/Video']) {
    const prompt = `[youtu.be/Label](${destination}) transcribir`;
    assert.equal(resolveMediaLinkContext({ prompt, history }), null, destination);
    const extracted = extractMediaLinkSources(prompt);
    assert.equal(extracted.invalid, true, destination);
    assert.deepEqual(extracted.urls, [], destination);
  }
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribe [youtu.be/Label](https://', history }), null);
  assert.equal(resolveMediaLinkContext({ prompt: `Transcribe [${original}](https://user:password@example.test/video) y ${original}`, history }), null);
});

test('standalone Markdown images never promote alt text or image URLs to transcription sources', () => {
  for (const prompt of [
    `Transcribe ![${original}](https://example.test/image.png)`,
    `Transcribe ![foto](${original})`,
    `Transcribe **![${original}](https://example.test/image.png)**`,
    `Transcribe ![${original}](https://example.test/image.png) y ${original}`,
  ]) {
    assert.equal(extractMediaLinkSources(prompt).invalid, true, prompt);
    assert.equal(resolveMediaLinkContext({ prompt, history }), null, prompt);
  }
  assert.deepEqual(extractMediaLinkSources(`Transcribe ![${original}](https://example.test/image.png)`).urls, []);
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribe este enlace', history: [{ role: 'user', content: `![${original}](https://example.test/image.png)` }] }), null);
});

test('a linked Markdown image keeps only the outer link as its explicit source', () => {
  const destination = 'https://youtu.be/OuterVideo';
  const prompt = `Transcribe [![${original}](https://example.test/image.png)](${destination})`;
  assert.deepEqual(extractMediaLinkSources(prompt).urls, [destination]);
  assert.deepEqual(resolveMediaLinkContext({ prompt }), { url: destination, source: 'explicit' });
});

test('the bounded source scan does not accept a partial list when the prompt is truncated', () => {
  const prompt = `Transcribe ${original} ${' '.repeat(16000)} https://youtu.be/SecondVideo`;
  assert.equal(extractMediaLinkSources(prompt).truncated, true);
  assert.equal(resolveMediaLinkContext({ prompt }), null);
});

for (const link of [original, 'https://www.youtube.com/watch?v=AbCdef12345&t=90', 'youtu.be/AbCdef12345?si=ShareToken&t=90', 'www.youtube.com/watch?v=AbCdef12345&t=90']) {
  test(`link transcription reaches tools with its own source: ${link}`, () => {
    const prompt = `Transcribir este enlace ${link}`;
    assert.equal(shouldUseAgenticChat({ prompt }), true);
    const result = brief.buildRequestBrief({ prompt });
    assert.equal(result.target.kind, 'url');
    assert.equal(result.deliverable.kind, 'transcription');
    assert.equal(result.ambiguity.ask, false);
  });
}

test('an explicit transcription follow-up retains the latest user link', () => {
  const prompt = 'Transcribir este enlace del minuto 1:30 al 10:00';
  const snapshot = JSON.stringify(history);
  assert.equal(shouldUseAgenticChat({ prompt, history }), true);
  const result = brief.buildRequestBrief({ prompt, recentTurns: history });
  assert.equal(result.target.kind, 'url');
  assert.equal(result.target.source, 'history');
  assert.equal(result.deliverable.kind, 'transcription');
  assert.equal(result.ambiguity.ask, false);
  assert.ok(brief.buildRequestBriefPromptBlock(result).includes(original));
  assert.equal(JSON.stringify(history), snapshot);
  assert.equal(JSON.stringify(brief.publicRequestBrief(result)).includes('ShareToken'), false);
});

test('the current link wins and its case, share query and timestamp survive', () => {
  const url = 'https://www.youtube.com/watch?v=ZyXwv987654&t=75#chapter';
  assert.deepEqual(resolveMediaLinkContext({ prompt: `Transcribe este enlace (${url}).`, history }), { url, source: 'explicit' });
  assert.deepEqual(resolveMediaLinkContext({ prompt: 'Transcribe este enlace youtu.be/AbCdef12345?si=ShareToken&t=90', history }), { url: original, source: 'explicit' });
});

test('never borrows an assistant, system, developer, tool or other-topic link', () => {
  for (const role of ['assistant', 'system', 'developer', 'tool']) {
    assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir este enlace', history: [{ role, content: original }] }), null, role);
  }
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir este enlace', history: [...history, { role: 'user', content: 'Ahora hablemos de la fotosíntesis' }] }), null);
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir este enlace', history: [{ role: 'user', content: 'Sin enlace' }, { role: 'assistant', content: original }] }), null);
});

test('ambiguous, malformed, foreign or attached sources do not guess an older URL', () => {
  const second = 'https://youtu.be/ZyXwv987654';
  for (const prompt of [`Transcribe este enlace ${original} ${second}`, 'Transcribe este enlace https://', 'Transcribe este enlace https://user:password@youtu.be/AbCdef12345']) {
    assert.equal(resolveMediaLinkContext({ prompt, history }), null, prompt);
  }
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir este enlace', history: [{ role: 'user', content: `${original} ${second}` }] }), null);
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir este enlace', history, files: [{ id: 'audio', mimeType: 'audio/mpeg' }] }), null);
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir este enlace', history: [{ role: 'user', content: original, files: [{ id: 'audio' }] }] }), null);
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir evil.youtu.be/AbCdef12345' }), null);
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir youtube.com.attacker.example/watch?v=AbCdef12345' }), null);
});

test('does not turn acknowledgements, how-to questions or a different source into a link task', () => {
  for (const prompt of ['hola', 'listo', 'gracias', '¿Cómo transcribir este enlace?', 'No quiero transcribir este enlace', 'Transcribe esta imagen', 'Transcribe el audio adjunto']) {
    assert.equal(isLinkTranscriptionRequest(prompt), false, prompt);
    assert.equal(resolveMediaLinkContext({ prompt, history }), null, prompt);
  }
  assert.equal(shouldUseAgenticChat({ prompt: 'hola', history }), false);
});

test('supports actual user content blocks and ignores stale history', () => {
  assert.deepEqual(resolveMediaLinkContext({ prompt: 'Transcribir este enlace', history: [{ role: 'USER', content: [{ type: 'text', text: original }, { type: 'image_url', image_url: { url: 'ignored' } }] }] }), { url: original, source: 'history' });
  assert.equal(resolveMediaLinkContext({ prompt: 'Transcribir este enlace', history: [...history, ...Array.from({ length: 8 }, () => ({ role: 'assistant', content: 'Más información' }))] }), null);
});

test('the persisted current user row is not mistaken for the preceding source', () => {
  const prompt = 'Transcribir este enlace';
  const persisted = [...history, { role: 'user', text: prompt }];
  const snapshot = JSON.stringify(persisted);
  assert.deepEqual(resolveMediaLinkContext({ prompt, history: persisted }), { url: original, source: 'history' });
  assert.equal(brief.buildRequestBrief({ prompt, recentTurns: persisted }).target.kind, 'url');
  assert.equal(JSON.stringify(persisted), snapshot);
  assert.equal(resolveMediaLinkContext({ prompt, history: [{ role: 'user', text: prompt }] }), null);
});

test('the real loop preserves the user request, model and URL without recovering old documents', async (t) => {
  const { PassThrough } = require('node:stream');
  const stream = require('../src/services/agentic-chat-stream');
  const attachments = require('../src/services/message-attachments');
  const react = require('../src/services/react-agent');
  let recovered = 0;
  let received;
  t.mock.method(attachments, 'resolveChatDocumentFileIds', async () => { recovered += 1; return ['older-document']; });
  t.mock.method(react, 'run', async (_client, options) => {
    received = options;
    return { finalAnswer: 'Prueba de enrutado completada.', stoppedReason: 'finalized', steps: [] };
  });
  const res = new PassThrough();
  res.resume();
  res.setHeader = () => {};
  res.flushHeaders = () => {};
  const prompt = 'Transcribir este enlace';
  await stream.runAgenticChat({
    openai: { chat: { completions: { create: async () => { throw new Error('No model call expected'); } } } },
    model: 'selected-test-model', provider: 'selected-test-provider',
    userQuery: prompt, history, res,
    toolContext: { prisma: {}, userId: 'synthetic-user', chatId: 'synthetic-chat', fileIds: [] },
    toolsOverride: [{ name: 'transcribe_url', description: 'Synthetic transcription tool', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) }],
  });
  assert.equal(recovered, 0);
  assert.equal(received.query, prompt);
  assert.equal(received.model, 'selected-test-model');
  assert.equal(received.ctx.provider, 'selected-test-provider');
  assert.deepEqual(received.ctx.fileIds, []);
  assert.ok(received.extraSystem.includes(original));
  assert.ok(received.extraSystem.includes('URL aportada por el usuario en su mensaje anterior'));
  assert.ok(received.maxRuntimeMs >= require('../src/services/agent-harness/tools/transcribe-url-tool').toolTimeoutMs(process.env));
});
