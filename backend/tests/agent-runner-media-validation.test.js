'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateMediaOutput, hasVerifiedMediaBytes } = require('../src/services/agent-runner/media-validation');
const { persistOutputs, getLatestConversationArtifact, mimeToExt } = require('../src/services/agent-runner/artifacts');
const { needsVerification } = require('../src/services/agent-runner/verify');
const { collectValidOutputs } = require('../src/services/agent-runner');

const metadata = { ok: true, decoded: true, duration_seconds: 1.2,
  sha256: crypto.createHash('sha256').update('fixture bytes').digest('hex'),
  streams: [{ type: 'video', codec: 'h264' }, { type: 'audio', codec: 'aac' }] };
function transport(result = metadata) {
  return { putFile: async () => {}, exec: async (command) => {
    if (command.startsWith('rm -f')) return { exitCode: 0 };
    assert.match(command, /^python3 -I -c /, 'verification is isolated from model-written Python modules');
    return { exitCode: 0, stdout: JSON.stringify(result) };
  } };
}
function output(name = 'clip.mp4') { return { name, buffer: Buffer.from('fixture bytes'), valid: true }; }

test('media proof is bound to exact verified bytes and format, not model JSON', async () => {
  const item = output();
  item.validation = { passed: true, media: metadata };
  assert.equal(hasVerifiedMediaBytes(item), false);
  const result = await validateMediaOutput(transport(), item);
  assert.equal(result.ok, true);
  item.validation = result.validation;
  assert.equal(hasVerifiedMediaBytes(item), true);
  item.buffer[0] ^= 1;
  assert.equal(hasVerifiedMediaBytes(item), false);
  item.buffer[0] ^= 1;
  item.name = 'clip.mp3';
  assert.equal(hasVerifiedMediaBytes(item), false);
});

test('malformed evidence, undecoded media and missing reader fail closed', async () => {
  for (const result of [{ ...metadata, decoded: false }, { ...metadata, duration_seconds: NaN },
    { ...metadata, streams: [] }, { ...metadata, sha256: 'wrong-bytes' }, { ...metadata, streams: [{ type: 'video', codec: 'Bearer secret' }] },
    { ok: false, reason: 'raw secret-like internal message' }]) {
    const validated = await validateMediaOutput(transport(result), output());
    assert.equal(validated.ok, false);
    assert.equal(validated.reason, 'media_reader_unavailable');
  }
  assert.equal((await validateMediaOutput({}, output())).ok, false);
});

test('Stop during media validation propagates instead of becoming an invalid output', async () => {
  for (const operation of ['putFile', 'exec']) {
    const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
    const sandbox = transport();
    sandbox[operation] = async () => { throw cancelled; };
    await assert.rejects(validateMediaOutput(sandbox, output()), (error) => error === cancelled);
    await assert.rejects(collectValidOutputs({ ...sandbox, collectOutputs: async () => [output()] }), (error) => error === cancelled);
  }
});

test('Stop after a validator finishes prevents final collection and chat persistence', async (t) => {
  const controller = new AbortController();
  const validator = require('../src/services/agent-runner/media-validation');
  const original = validator.validateMediaOutput;
  const runnerPath = require.resolve('../src/services/agent-runner');
  const cached = require.cache[runnerPath];
  validator.validateMediaOutput = async () => {
    controller.abort('user_stop');
    return { ok: true, validation: { passed: true, media: metadata } };
  };
  delete require.cache[runnerPath];
  const { runAgentRunnerForChat } = require('../src/services/agent-runner');
  validator.validateMediaOutput = original;
  t.after(() => { require.cache[runnerPath] = cached; });
  let calls = 0, saved = 0;
  const events = [];
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    const message = calls === 1 ? { content: null, tool_calls: [{ id: 'write-media', type: 'function', function: {
      name: 'execute_python', arguments: JSON.stringify({ code: "from pathlib import Path\nPath('outputs/clip.mp4').write_bytes(b'cancel-only-test')" }),
    } }] } : { content: 'Conversión terminada.' };
    return { choices: [{ message }] };
  } } } };
  await assert.rejects(runAgentRunnerForChat({ instruction: 'Convierte el MP3 a MP4', attachedFiles: [],
    client, model: 'test', driver: 'local', signal: controller.signal, maxIterations: 3,
    onEvent: (event) => events.push(event), saveArtifact: () => { saved += 1; return {}; },
  }), (error) => error.name === 'AbortError');
  assert.equal(saved, 0);
  assert.equal(calls, 2);
  assert.equal(events.some((event) => event.type === 'outputs' && event.count > 0), false);
  assert.equal(events.filter((event) => event.type === 'cancelled').length, 1);
});

test('collection refuses unreadable media; persistence cannot mint its own verification', async () => {
  const events = [];
  const items = [output()];
  const sandbox = { ...transport({ ok: false, reason: 'media_unreadable' }), collectOutputs: async () => items };
  const collected = await collectValidOutputs(sandbox, (event) => events.push(event));
  assert.equal(collected[0].valid, false);
  assert.equal(collected[0].validation.passed, false);
  assert.equal(events[0].reason, 'media_unreadable');
  const forged = output();
  forged.validation = { passed: true, media: metadata };
  const persisted = await persistOutputs({ outputs: [forged], saveArtifact: () => { throw new Error('must not save'); },
    onEvent: (event) => events.push(event) });
  assert.deepEqual(persisted, []);
  assert.equal(events.at(-1).reason, 'media_unverified');
});

test('verified media persists with playable MIME and decoder evidence', async () => {
  for (const [extension, mime, streams] of [['mp4', 'video/mp4', metadata.streams],
    ['mp3', 'audio/mpeg', [{ type: 'audio', codec: 'mp3' }]]]) {
    const item = output(`file.${extension}`);
    const validated = await validateMediaOutput(transport({ ...metadata, streams }), item);
    item.validation = validated.validation;
    let saved;
    const persisted = await persistOutputs({ outputs: [item], saveArtifact: (args) => {
      saved = args;
      return { id: extension, filename: args.filename, mime: args.mime, downloadUrl: `/test/${extension}` };
    } });
    assert.equal(persisted.length, 1);
    assert.equal(saved.mime, mime);
    assert.equal(saved.validation.scope, 'full_media_decode');
    assert.equal(mimeToExt(mime), extension);
  }
});

const mutation = (files) => ({ tool: 'execute_python', ok: true, mutated: true, changedOutputs: files });
test('only exclusive media mutations skip impossible Office rendering', () => {
  for (const strict of [true, false]) {
    assert.equal(needsVerification([mutation(['outputs/a.mp3', 'outputs/b.mp4'])], { strict }).needed, false);
    assert.equal(needsVerification([mutation(['outputs/a.mp4', 'outputs/readme.md'])], { strict }).needed, true);
    assert.equal(needsVerification([{ tool: 'execute_python', ok: true }], { strict }).needed, true);
  }
  for (const steps of [[mutation(['outputs/deck.pptx', 'outputs/a.mp4'])],
    [mutation(['outputs/deck.pptx']), mutation(['outputs/a.mp3'])],
    [mutation(['outputs/a.mp3']), mutation(['outputs/deck.pptx'])]]) {
    assert.equal(needsVerification(steps, { strict: true }).reason, 'missing_visual_verify');
  }
});

test('conversion followup selects source bytes instead of an older target-format artifact', async () => {
  const rows = ['docx', 'pdf', 'mp4', 'mp3'].map((format) => ({ id: format, filename: `original.${format}` }));
  const prisma = { generatedArtifact: { findMany: async () => rows } };
  for (const [instruction, expected] of [['convierte el PDF a Word', 'pdf'],
    ['pasa el Word a PDF', 'docx'], ['convierte el MP3 a MP4', 'mp3'], ['convierte el MP4 a MP3', 'mp4'],
    ['convierte original.pdf a Word', 'pdf']]) {
    const source = await getLatestConversationArtifact(prisma, { userId: 'u', chatId: 'c', instruction });
    assert.equal(source?.id, expected, instruction);
  }
  const reverseOrder = await getLatestConversationArtifact({ generatedArtifact: { findMany: async () => [
    { id: 'recent-pdf', filename: 'recent.pdf' }, { id: 'word-source', filename: 'document.docx' },
  ] } }, { userId: 'u', chatId: 'c', instruction: 'Convierte a PDF el Word' });
  assert.equal(reverseOrder.id, 'word-source');
});

test('destination-only conversion keeps the most recent source identity', async () => {
  const rows = [{ id: 'new-workbook', filename: 'ventas.xlsx' }, { id: 'old-word', filename: 'informe.docx' }];
  const prisma = { generatedArtifact: { findMany: async () => rows } };
  for (const instruction of ['convierte esto a PDF', 'pasa esto a Word']) {
    const source = await getLatestConversationArtifact(prisma, { userId: 'u', chatId: 'c', instruction });
    assert.equal(source.id, 'new-workbook');
  }
});
