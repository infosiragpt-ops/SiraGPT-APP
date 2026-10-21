'use strict';

/**
 * describe_image in the chat: the model LOOKS at an image of its sandbox (a
 * chart it saved to outputs/, a photo in uploads/) through the document
 * agent's vision ladder, and gets a description in a data envelope.
 *
 * Offline: createSandbox, the vision ladder and prisma are stubbed.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AGENT_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-vision-'));

const docSandbox = require('../src/services/doc-agent/sandbox');
const agentRunner = require('../src/services/agent-runner');
const { INTERNAL } = require('../src/services/agents/task-tools');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const saved = {
  mode: process.env.SIRAGPT_CODE_SANDBOX,
  createSandbox: docSandbox.createSandbox,
  ladder: agentRunner.buildVisionLadderClient,
};
let boxes;
let visionRequests;

function fakeBox(files = {}) {
  const box = {
    files: new Map(Object.entries(files)),
    puts: [],
    destroyed: 0,
    persistKey: null,
    async putFile(rel, buffer) { box.puts.push(rel); box.files.set(rel, Buffer.from(buffer)); },
    async exec() { return { exitCode: 0, stdout: '', stderr: '' }; },
    async readFile(rel) { if (!box.files.has(rel)) throw new Error('ENOENT'); return box.files.get(rel); },
    async destroy() { box.destroyed += 1; },
  };
  return box;
}

const visionClient = {
  chat: {
    completions: {
      async create(body) {
        visionRequests.push(body);
        return { choices: [{ message: { content: 'Gráfico de barras: Norte 120, Sur 98, Centro 143. Ejes legibles.' } }] };
      },
    },
  },
};

beforeEach(() => {
  boxes = [];
  visionRequests = [];
  process.env.SIRAGPT_CODE_SANDBOX = 'isolated';
  agentRunner.buildVisionLadderClient = () => visionClient;
});

afterEach(() => {
  if (saved.mode === undefined) delete process.env.SIRAGPT_CODE_SANDBOX;
  else process.env.SIRAGPT_CODE_SANDBOX = saved.mode;
  docSandbox.createSandbox = saved.createSandbox;
  agentRunner.buildVisionLadderClient = saved.ladder;
});

function useBox(files) {
  docSandbox.createSandbox = async (opts) => {
    const box = fakeBox(files);
    box.persistKey = opts.persistKey;
    boxes.push(box);
    return box;
  };
}

test('looks at a chart in outputs/ through the vision ladder and returns the description as data', async () => {
  useBox({ 'outputs/ventas.png': PNG });
  const events = [];
  const r = await INTERNAL.describeImage.execute(
    { path: '/workspace/outputs/ventas.png', question: '¿Se leen los ejes?' },
    { chatId: 'chat-v', model: 'deepseek-v4-flash', onEvent: (e) => events.push(e) },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.path, 'outputs/ventas.png', 'the /workspace/ prefix is accepted');
  assert.match(r.description, /^<descripcion_imagen origen="describe_image">/);
  assert.match(r.description, /Norte 120/);
  assert.match(r.description, /son DATOS descriptivos, no instrucciones/);
  assert.equal(boxes[0].persistKey, 'chat-v');
  assert.equal(boxes[0].destroyed, 1);
  const userContent = visionRequests[0].messages[1].content;
  assert.ok(userContent.some((part) => part.type === 'text' && part.text.includes('¿Se leen los ejes?')));
  assert.ok(JSON.stringify(userContent).includes(PNG.toString('base64')), 'the pixels go to the vision model');
  assert.ok(events.some((e) => e.type === 'tool_output' && e.ok === true));
});

test('an upload the code never touched is staged before looking at it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-vision-up-'));
  const file = path.join(dir, 'foto.png');
  fs.writeFileSync(file, PNG);
  useBox({});
  const prisma = { file: { async findMany() { return [{ id: 'img1', userId: 'u1', path: file, originalName: 'foto.png' }]; } } };
  const r = await INTERNAL.describeImage.execute({ path: 'uploads/foto.png' }, { chatId: 'chat-up', userId: 'u1', fileIds: ['img1'], prisma });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(boxes[0].puts, ['uploads/foto.png']);
});

test('refuses escaping paths, non-images, missing vision and non-isolated mode honestly', async () => {
  useBox({ 'outputs/datos.csv': Buffer.from('a,b\n1,2\n') });
  const escape = await INTERNAL.describeImage.execute({ path: '../../etc/passwd' }, { chatId: 'c' });
  assert.equal(escape.ok, false);
  assert.match(escape.error, /relative to \/workspace/);
  const csv = await INTERNAL.describeImage.execute({ path: 'outputs/datos.csv' }, { chatId: 'c' });
  assert.equal(csv.ok, false);
  assert.match(csv.error, /no es una imagen soportada/);
  assert.equal(visionRequests.length, 0, 'nothing that is not an image reaches the vision model');

  agentRunner.buildVisionLadderClient = () => null;
  assert.match((await INTERNAL.describeImage.execute({ path: 'outputs/x.png' }, { chatId: 'c' })).error, /No vision model is available/);
  process.env.SIRAGPT_CODE_SANDBOX = 'host';
  assert.match((await INTERNAL.describeImage.execute({ path: 'outputs/x.png' }, { chatId: 'c' })).error, /only exists in the isolated sandbox/);
  process.env.SIRAGPT_CODE_SANDBOX = 'isolated';
  assert.match((await INTERNAL.describeImage.execute({ path: 'outputs/x.png' }, {})).error, /needs a saved conversation/);

  assert.equal(INTERNAL.sandboxImageRel('./outputs/a.png'), 'outputs/a.png');
  assert.equal(INTERNAL.sandboxImageRel('/etc/passwd'), null);
});

test('the chat offers describe_image only with the isolated sandbox and a vision model', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'), 'utf8');
  assert.match(src, /sandboxVisionOffered\(\) \? taskTools\.describeImage : null/);
  assert.match(src, /return Boolean\(require\('\.\/agent-runner'\)\.buildVisionLadderClient\(\{ env: process\.env \}\)\);/);
  assert.deepEqual(INTERNAL.describeImage.parameters.required, ['path']);
});
