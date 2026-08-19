'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const runtime = require('../src/services/agents/media-inspection-runtime');

function makeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  process.nextTick(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  });
  return child;
}

test('media kinds are derived from trusted file metadata, not caller paths', () => {
  assert.deepEqual([...runtime.mediaKindsFor({ originalName: 'clip.MP4', mimeType: 'video/mp4' })].sort(), ['audio', 'video']);
  assert.deepEqual([...runtime.mediaKindsFor({ originalName: 'voice.wav', mimeType: 'audio/wav' })], ['audio']);
  assert.deepEqual([...runtime.mediaKindsFor({ originalName: 'notes.txt', mimeType: 'text/plain' })], []);
});

test('owner-scoped resolver materializes only the authenticated user file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-media-resolver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mediaPath = path.join(dir, 'owned.mp4');
  fs.writeFileSync(mediaPath, Buffer.from('owned-media'));
  const queries = [];
  let cleanupCalls = 0;
  const record = {
    id: 'file-owned',
    userId: 'user-a',
    originalName: 'owned.mp4',
    filename: 'stored.mp4',
    mimeType: 'video/mp4',
    size: 11,
    path: mediaPath,
  };
  const ctx = {
    userId: 'user-a',
    fileIds: ['file-owned'],
    prisma: {
      file: {
        async findFirst({ where }) { queries.push(where); return record; },
        async findMany({ where }) { queries.push(where); return [record]; },
      },
    },
    objectStorage: {
      async toLocalTemp(ref) {
        assert.equal(ref, mediaPath);
        return { path: ref, cleanup: async () => { cleanupCalls += 1; } };
      },
    },
  };

  const resolved = await runtime.resolveOwnedMediaSource({ fileId: 'file-owned', allowedKinds: ['video'] }, ctx);
  assert.equal(resolved.source.fileId, 'file-owned');
  assert.equal(resolved.source.filename, 'owned.mp4');
  assert.equal(Object.hasOwn(resolved.source, 'path'), false);
  assert.deepEqual(queries[0], { userId: 'user-a', deletedAt: null, id: 'file-owned' });
  await resolved.cleanup();
  assert.equal(cleanupCalls, 1);
});

test('resolver rejects unauthenticated, missing, unsupported, and oversized sources', async () => {
  await assert.rejects(
    runtime.resolveOwnedMediaSource({}, {}),
    (error) => error.code === 'MEDIA_USER_REQUIRED',
  );

  const baseCtx = {
    userId: 'user-a',
    fileIds: ['file-a'],
    prisma: {
      file: {
        async findFirst() { return null; },
        async findMany() { return []; },
      },
    },
  };
  await assert.rejects(
    runtime.resolveOwnedMediaSource({ fileId: 'file-other' }, baseCtx),
    (error) => error.code === 'MEDIA_FILE_NOT_FOUND',
  );

  const unsupported = {
    ...baseCtx,
    prisma: {
      file: {
        async findFirst() {
          return { id: 'file-a', path: '/not/read', size: 1, mimeType: 'text/plain', originalName: 'a.txt' };
        },
        async findMany() { return []; },
      },
    },
  };
  await assert.rejects(
    runtime.resolveOwnedMediaSource({ fileId: 'file-a', allowedKinds: ['audio'] }, unsupported),
    (error) => error.code === 'MEDIA_TYPE_UNSUPPORTED',
  );

  const oversized = {
    ...baseCtx,
    prisma: {
      file: {
        async findFirst() {
          return { id: 'file-a', path: '/not/read', size: 51, mimeType: 'audio/wav', originalName: 'a.wav' };
        },
        async findMany() { return []; },
      },
    },
  };
  await assert.rejects(
    runtime.resolveOwnedMediaSource({ fileId: 'file-a', maxSourceBytes: 50 }, oversized),
    (error) => error.code === 'MEDIA_SOURCE_TOO_LARGE',
  );
});

test('attachment resolution skips non-media files while preserving attachment order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-media-attachments-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audioPath = path.join(dir, 'voice.wav');
  fs.writeFileSync(audioPath, 'audio');
  const records = [
    { id: 'doc', path: path.join(dir, 'doc.txt'), size: 1, mimeType: 'text/plain', originalName: 'doc.txt' },
    { id: 'audio', path: audioPath, size: 5, mimeType: 'audio/wav', originalName: 'voice.wav' },
  ];
  const resolved = await runtime.resolveOwnedMediaSource({ allowedKinds: ['audio'] }, {
    userId: 'user-a',
    fileIds: ['doc', 'audio'],
    prisma: { file: { async findFirst() { return null; }, async findMany() { return records; } } },
    objectStorage: { async toLocalTemp(ref) { return { path: ref, cleanup: async () => {} }; } },
  });
  assert.equal(resolved.source.fileId, 'audio');
  await resolved.cleanup();
});

test('fixed process runner disables shell and captures bounded output', async () => {
  let invocation;
  const result = await runtime.runProcess('ffprobe', ['-of', 'json', 'owned-file'], {
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return makeChild({ stdout: '{"ok":true}' });
    },
  });
  assert.equal(result.stdout.toString(), '{"ok":true}');
  assert.equal(invocation.command, 'ffprobe');
  assert.deepEqual(invocation.args, ['-of', 'json', 'owned-file']);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('fixed process runner terminates failed and overlong processes', async () => {
  await assert.rejects(
    runtime.runProcess('ffmpeg', [], { spawnImpl: () => makeChild({ stderr: 'bad media', code: 2 }) }),
    (error) => error.code === 'MEDIA_PROCESS_FAILED' && error.exitCode === 2,
  );

  let child;
  await assert.rejects(
    runtime.runProcess('ffmpeg', [], {
      timeoutMs: 10,
      spawnImpl() {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.kill = () => { child.killed = true; };
        return child;
      },
    }),
    (error) => error.code === 'MEDIA_PROCESS_TIMEOUT',
  );
  assert.equal(child.killed, true);
});

test('automatic frame timestamps are deterministic, bounded, and deduplicated', () => {
  assert.deepEqual(runtime.buildFrameTimestamps({ count: 3, durationSeconds: 40 }), [10, 20, 30]);
  assert.deepEqual(runtime.buildFrameTimestamps({ timestamps: [3, 3, 99, -1], durationSeconds: 10 }), [3, 9.99]);
  assert.equal(runtime.buildFrameTimestamps({ count: 99, durationSeconds: 100 }).length, 6);
});
