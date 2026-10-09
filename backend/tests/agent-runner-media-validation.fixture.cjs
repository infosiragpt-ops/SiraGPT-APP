'use strict';

// Mandatory real FFmpeg acceptance, executed on the CI validator shard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox } = require('../src/services/doc-agent/sandbox');
const { collectValidOutputs, runAgentRunner } = require('../src/services/agent-runner');
const { hasVerifiedMediaBytes, validateMediaOutput } = require('../src/services/agent-runner/media-validation');
const { persistOutputs } = require('../src/services/agent-runner/artifacts');

test('real sandbox decodes audio/video before delivery and rejects disguised bytes', async (t) => {
  const sandbox = await createSandbox({ driver: 'local' });
  t.after(() => sandbox.destroy());
  const command = 'ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i sine=frequency=440:duration=1 -c:a libmp3lame /workspace/outputs/audio.mp3'
    + ' && ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i color=c=blue:s=64x64:r=25 -t 1 -c:v libx264 /workspace/outputs/clip.mp4';
  const made = await sandbox.exec(command, { timeoutMs: 20000 });
  assert.equal(made.exitCode, 0, made.stderr);
  await sandbox.putFile('outputs/forged.mp4', Buffer.from('not video, even if the model says validated'));
  // A staged module must not be trusted: the delivery verifier runs packaged
  // source with Python isolated mode, so this forged helper cannot approve.
  await sandbox.putFile('tmp/sira_convert.py', Buffer.from('raise RuntimeError("model replaced helper")'));
  const items = await collectValidOutputs(sandbox);
  assert.equal(items.length, 3);
  for (const name of ['audio.mp3', 'clip.mp4']) {
    const item = items.find((row) => row.name === name);
    assert.equal(item.valid, true, JSON.stringify(item.validation));
    assert.equal(hasVerifiedMediaBytes(item), true);
    assert.equal(item.validation.media.decoded, true);
  }
  const forged = items.find((row) => row.name === 'forged.mp4');
  assert.equal(forged.valid, false);
  assert.equal(forged.validation.reason, 'media_unreadable');
  // Replacing the validator input with another decodable file must not mint
  // proof for the original Node buffer. The expected digest crosses the RPC.
  const clip = items.find((row) => row.name === 'clip.mp4');
  const changed = await sandbox.exec('ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i color=c=red:s=64x64:r=25 -t 1 -c:v libx264 /workspace/tmp/other.mp4', { timeoutMs: 10000 });
  assert.equal(changed.exitCode, 0, changed.stderr);
  const replacement = await sandbox.readFile('tmp/other.mp4');
  const tampered = await validateMediaOutput({ ...sandbox, putFile: (name) => sandbox.putFile(name, replacement) }, { name: clip.name, buffer: clip.buffer });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'media_unreadable');
  const saved = [];
  const artifacts = await persistOutputs({ outputs: items, saveArtifact: (args) => {
    saved.push(args);
    return { id: args.filename, filename: args.filename, mime: args.mime, downloadUrl: `/test/${args.filename}` };
  } });
  assert.equal(artifacts.length, 2);
  assert.deepEqual(saved.map((row) => row.mime).sort(), ['audio/mpeg', 'video/mp4']);
});

test('full AgentRunner stages the converter and delivers a real playable MP4 without an Office preview loop', async () => {
  const sourceSandbox = await createSandbox({ driver: 'local' });
  let source;
  try {
    const generated = await sourceSandbox.exec('ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i sine=frequency=440:duration=1 -c:a libmp3lame /workspace/outputs/source.mp3', { timeoutMs: 10000 });
    assert.equal(generated.exitCode, 0, generated.stderr);
    source = await sourceSandbox.readFile('outputs/source.mp3');
  } finally { await sourceSandbox.destroy(); }
  let calls = 0;
  const client = { chat: { completions: { create: async (request) => {
    calls += 1;
    assert.ok(calls <= 2, `a media-only mutation must not get stuck requesting an Office render: ${JSON.stringify(request.messages.slice(-3))}`);
    if (calls === 1) {
      const toolCall = { id: 'convert-real-media', type: 'function', function: {
        name: 'execute_python', arguments: JSON.stringify({
          code: "import json\nfrom sira_convert import convert\nprint(json.dumps(convert('uploads/source.mp3', 'outputs/result.mp4')))" }),
      } };
      return { choices: [{ message: { content: null, tool_calls: [toolCall] } }] };
    }
    return { choices: [{ message: { content: 'Convertí el audio a MP4 con un fondo fijo.' } }] };
  } } } };
  const run = await runAgentRunner({ files: [{ name: 'source.mp3', buffer: source }],
    instruction: 'Convierte este MP3 a MP4 con un fondo fijo, conserva el audio.',
    client, model: 'test', driver: 'local', maxIterations: 4, persistMemory: false });
  assert.equal(run.stoppedReason, 'final');
  assert.equal(run.outputs.length, 1);
  const output = run.outputs[0];
  assert.equal(output.name, 'result.mp4');
  assert.equal(output.valid, true, JSON.stringify(output.validation));
  assert.equal(hasVerifiedMediaBytes(output), true);
  assert.ok(output.validation.media.streams.some((stream) => stream.type === 'video' && stream.codec === 'h264'));
  assert.ok(output.validation.media.streams.some((stream) => stream.type === 'audio' && stream.codec === 'aac'));
  assert.equal(run.steps.some((step) => step.tool === 'render_preview'), false);
  const artifacts = await persistOutputs({ outputs: run.outputs, saveArtifact: (args) => ({
    id: 'full-run-real-media', filename: args.filename, mime: args.mime, downloadUrl: '/test/real-media.mp4',
  }) });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].mime, 'video/mp4');
});
