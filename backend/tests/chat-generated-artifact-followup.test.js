'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-chat-followup-'));
process.env.AGENT_ARTIFACT_DIR = artifactDir;

const objectStorage = require('../src/services/object-storage');
const { saveArtifact, INTERNAL } = require('../src/services/agents/task-tools');
const { resolveChatGeneratedArtifactFollowup } = require('../src/services/agents/generated-artifact-followup');
const { runAgenticChat } = require('../src/services/agentic-chat-stream');
const PRODUCTION_GOAL = 'Sin crear ni modificar archivos: abre los dos archivos que acabas de entregar con pyreadstat.read_sav y openpyxl. Informa las dimensiones de la matriz P01–P20, cuántos de los 400 valores difieren y si el SAV conserva 20 etiquetas de variables. Si no puedes acceder a uno, dilo explícitamente; no deduzcas el resultado de tu respuesta anterior.';

function deliveredMessage(id, artifacts) {
  return {
    id,
    content: '```agent-task-state\n' + JSON.stringify({ artifacts, done: true, finalText: 'Archivos listos.' }) + '\n```\n\nArchivos listos.',
  };
}

function chatPrisma(userId, chatId, messages) {
  return {
    generatedArtifact: { findMany: async () => [] },
    chat: { findFirst: async ({ where }) =>
      where.id === chatId && where.userId === userId && userId === 'owner' ? { id: chatId } : null },
    message: { findMany: async ({ where }) => {
      assert.equal(where.chatId, chatId);
      assert.equal(where.role, 'ASSISTANT');
      return messages;
    } },
  };
}

function artifactPair() {
  const base = { ownerUserId: 'owner', chatId: 'chat-a', validation: { passed: true } };
  const sav = saveArtifact({ ...base, filename: 'datos.sav', base64: Buffer.from('400 equal values').toString('base64') });
  const xlsx = saveArtifact({ ...base, filename: 'datos.xlsx', base64: Buffer.from('400 equal values').toString('base64') });
  return [sav, xlsx];
}

test('normal chat recovers only the last validated SAV/XLSX delivery for its owner', async () => {
  const [sav, xlsx] = artifactPair();
  const invalid = saveArtifact({ filename: 'invalid.xlsx', base64: Buffer.from('bad').toString('base64'), ownerUserId: 'owner', chatId: 'chat-a', validation: { passed: false } });
  const foreign = saveArtifact({ filename: 'foreign.sav', base64: Buffer.from('bad').toString('base64'), ownerUserId: 'other', chatId: 'chat-a', validation: { passed: true } });
  const wrongChat = saveArtifact({ filename: 'wrong.xlsx', base64: Buffer.from('bad').toString('base64'), ownerUserId: 'owner', chatId: 'chat-b', validation: { passed: true } });
  const message = deliveredMessage('delivery', [sav, xlsx, invalid, foreign, wrongChat]);
  const prisma = chatPrisma('owner', 'chat-a', [deliveredMessage('later-text', []), message]);
  const goal = PRODUCTION_GOAL;
  const refs = await resolveChatGeneratedArtifactFollowup(prisma, { userId: 'owner', chatId: 'chat-a', goal, providedFileIds: [] });
  assert.deepEqual(refs.map(({ id }) => id), [sav.id, xlsx.id]);
  assert.deepEqual(await resolveChatGeneratedArtifactFollowup(prisma, { userId: 'other', chatId: 'chat-a', goal }), []);
  assert.deepEqual(await resolveChatGeneratedArtifactFollowup(prisma, { userId: 'owner', chatId: 'chat-a', goal, providedFileIds: ['new-upload'] }), []);
  const newer = deliveredMessage('newer', [xlsx]);
  const latestOnly = await resolveChatGeneratedArtifactFollowup(chatPrisma('owner', 'chat-a', [newer, message]), {
    userId: 'owner', chatId: 'chat-a', goal,
  });
  assert.deepEqual(latestOnly.map(({ id }) => id), [xlsx.id], 'do not borrow SAV from an older delivery');
});

test('normal chat follow-up forces byte reading via selected model and R2, without exposing internal ids', async (t) => {
  const [sav, xlsx] = artifactPair();
  const bytes = new Map([[sav.id, fs.readFileSync(sav.path)], [xlsx.id, fs.readFileSync(xlsx.path)]]);
  const originalToLocalTemp = objectStorage.toLocalTemp;
  t.after(() => { objectStorage.toLocalTemp = originalToLocalTemp; });
  for (const artifact of [sav, xlsx]) {
    const metadataPath = INTERNAL.metadataPathFor(artifact.id);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.storageRef = `mock://${artifact.id}`;
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    fs.rmSync(artifact.path);
  }
  objectStorage.toLocalTemp = async (ref) => {
    const id = ref.split('/').at(-1);
    const hydrated = path.join(artifactDir, `hydrated-${id}${id === sav.id ? '.sav' : '.xlsx'}`);
    fs.writeFileSync(hydrated, bytes.get(id));
    return { path: hydrated, cleanup: async () => fs.rmSync(hydrated, { force: true }) };
  };

  const response = new PassThrough();
  const frames = [];
  response.on('data', (chunk) => frames.push(chunk.toString()));
  response.flushHeaders = () => {};
  response.setHeader = () => {};
  let calls = 0;
  const choices = [];
  const modelPrompts = [];
  const openai = { chat: { completions: { create: async (args) => {
    choices.push(args.tool_choice);
    modelPrompts.push(JSON.stringify(args.messages));
    calls += 1;
    if (calls === 1) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'read-pair', type: 'function', function: { name: 'python_exec', arguments: JSON.stringify({ source: 'from pathlib import Path\nitems = list(ARTIFACT_FILES.values())\nassert len(items) == 2\nvalues = [Path(item["path"]).read_bytes() for item in items]\nprint("400/400=" + str(values[0] == values[1]).lower())' }) } }] } }] };
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: `Comprobé 400/400 valores; coinciden. ${sav.id}`, confidence: 'high' }) } }] } }] };
  } } } };
  const result = await runAgenticChat({
    openai,
    model: 'grok-4.7',
    provider: 'xAI',
    userQuery: PRODUCTION_GOAL,
    history: [
      { role: 'user', content: 'Crea los dos archivos.' },
      { role: 'assistant', ...deliveredMessage('delivery', [sav, xlsx]) },
      { role: 'assistant', content: `Se guardó en /app/uploads/agent-artifacts/${sav.id}-datos.sav` },
    ],
    res: response,
    maxSteps: 3,
    selection: { decision: { intent: 'data_analysis' }, signals: { hasFiles: false } },
    toolContext: { userId: 'owner', chatId: 'chat-a', fileIds: [], prisma: chatPrisma('owner', 'chat-a', [deliveredMessage('delivery', [sav, xlsx])]) },
  });
  assert.equal(choices[0]?.function?.name, 'python_exec');
  assert.ok(result.steps.some((step) => step.actions?.some((action) => action.tool === 'python_exec' && action.observation?.ok === true)));
  assert.match(result.finalAnswer, /400\/400/);
  assert.doesNotMatch(result.finalAnswer, new RegExp(`${sav.id}|${xlsx.id}|\/app\/uploads\/agent-artifacts`));
  assert.doesNotMatch(frames.join(''), new RegExp(`${sav.id}|${xlsx.id}|hydrated-`));
  assert.doesNotMatch(modelPrompts.join(''), new RegExp(`${sav.id}|${xlsx.id}|\/app\/uploads\/agent-artifacts|agent-task-state`));
});

test('normal chat never claims equality when the byte-reading tool is unavailable', async () => {
  const [sav, xlsx] = artifactPair();
  const response = new PassThrough();
  response.on('data', () => {});
  response.flushHeaders = () => {};
  response.setHeader = () => {};
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
      id: 'finish-without-read', type: 'function', function: {
        name: 'finalize', arguments: JSON.stringify({ answer: `Los 400 valores coinciden. ${sav.id}`, confidence: 'high' }),
      },
    }] } }],
  }) } } };
  const result = await runAgenticChat({
    openai, model: 'grok-4.7', provider: 'xAI',
    userQuery: PRODUCTION_GOAL,
    res: response, maxSteps: 3,
    toolsOverride: [{ name: 'read_file', description: 'not the artifact tool', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: false }) }],
    toolContext: { userId: 'owner', chatId: 'chat-a', fileIds: [], prisma: chatPrisma('owner', 'chat-a', [deliveredMessage('delivery', [sav, xlsx])]) },
  });
  assert.equal(result.stoppedReason, 'generated_artifact_read_failed');
  assert.match(result.finalAnswer, /No pude abrir y verificar/);
  assert.doesNotMatch(result.finalAnswer, /Los 400 valores coinciden|[a-f0-9]{16}/i);
});

test('normal chat does not borrow an older SAV when the latest delivery contains only XLSX', async () => {
  const [sav, xlsx] = artifactPair();
  const response = new PassThrough();
  response.on('data', () => {});
  response.flushHeaders = () => {};
  response.setHeader = () => {};
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
      id: 'finish-without-sav', type: 'function', function: {
        name: 'finalize', arguments: JSON.stringify({ answer: 'Los 400 valores coinciden.', confidence: 'high' }),
      },
    }] } }],
  }) } } };
  const result = await runAgenticChat({
    openai, model: 'grok-4.7', provider: 'xAI',
    userQuery: PRODUCTION_GOAL,
    res: response, maxSteps: 3,
    toolsOverride: [{ name: 'read_file', description: 'not the artifact tool', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: false }) }],
    toolContext: { userId: 'owner', chatId: 'chat-a', fileIds: [], prisma: chatPrisma('owner', 'chat-a', [deliveredMessage('latest', [xlsx]), deliveredMessage('older', [sav, xlsx])]) },
  });
  assert.equal(result.stoppedReason, 'generated_artifact_read_failed');
  assert.match(result.finalAnswer, /no contiene \.sav/i);
  assert.doesNotMatch(result.finalAnswer, /Los 400 valores coinciden/);
});
