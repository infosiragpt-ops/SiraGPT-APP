'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const PptxGenJS = require('pptxgenjs');

// Inject a renderer failure at the sandbox boundary, keeping the actual PPTX
// edit and artifact-persistence path. Load the runner only after the factory is
// replaced because it captures createSandbox when the module is initialized.
const sandboxModule = require('../src/services/doc-agent/sandbox');
const createSandbox = sandboxModule.createSandbox;
let renderResult = { ok: false, error: 'forced render failure' };
let renderCalls = 0;
sandboxModule.createSandbox = async (options) => {
  const sandbox = await createSandbox(options);
  const exec = sandbox.exec.bind(sandbox);
  sandbox.exec = (command, opts) => {
    const text = String(command);
    if (text.includes('sira_office.py render --args-file')) {
      renderCalls += 1;
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(renderResult) });
    }
    if (text.includes('soffice --headless --convert-to png')) {
      renderCalls += 1;
      return Promise.resolve({ exitCode: 1, stderr: 'forced render failure' });
    }
    return exec(command, opts);
  };
  return sandbox;
};
let runAgentRunnerForChat;
try {
  ({ runAgentRunnerForChat } = require('../src/services/agent-runner'));
} finally {
  sandboxModule.createSandbox = createSandbox;
}

async function sourceDeck() {
  const deck = new PptxGenJS();
  deck.addSlide().addText('Portada', { x: 1, y: 1, w: 5, h: 1 });
  return deck.write('nodebuffer');
}

for (const { instruction, failure } of [
  { instruction: 'ponlas todas de color azul', failure: { ok: false, error: 'forced render failure' } },
  { instruction: 'agrega una diapositiva de gracias', failure: { ok: true, skipped: true, reason: 'renderer_unavailable' } },
]) {
  test(`the ${instruction} fast path never delivers a PPTX when its preview fails`, async () => {
    renderResult = failure;
    renderCalls = 0;
    const saved = [];
    const result = await runAgentRunnerForChat({
      attachedFiles: [{ name: 'origen.pptx', buffer: await sourceDeck() }],
      instruction,
      client: { chat: { completions: { create: async () => { throw new Error('unexpected model call'); } } } },
      driver: 'local',
      saveArtifact: (artifact) => {
        saved.push(artifact);
        return { id: 'saved', filename: artifact.filename, downloadUrl: '/saved' };
      },
    });
    assert.equal(result.ok, false);
    assert.ok(renderCalls > 0, 'the real fast path must reach its preview tool');
    assert.equal(result.stoppedReason, 'verification_failed');
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(saved, []);
  });
}
