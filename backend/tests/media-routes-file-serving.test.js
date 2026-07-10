const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const {
  buildRouteTestApp,
  mockResolvedModule,
  reloadModule,
} = require('./http-test-utils');

function binaryParser(res, cb) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('media route file serving', () => {
  let tmpDir;
  let oldUploadDir;
  let restoreDatabase;
  let restoreFal;
  let restoreElevenLabs;
  let videoApp;
  let elevenLabsApp;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-media-routes-'));
    fs.mkdirSync(path.join(tmpDir, 'videos'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'videos', 'video_test.mp4'), Buffer.from('0123456789'));
    fs.writeFileSync(path.join(tmpDir, 'audio', 'tts_test.mp3'), Buffer.from('audio-bytes'));

    oldUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = tmpDir;

    restoreDatabase = mockResolvedModule(require.resolve('../src/config/database'), {
      apiUsage: { aggregate: async () => ({ _sum: { tokens: 0 } }), create: async () => ({}) },
    });
    restoreFal = mockResolvedModule(require.resolve('@fal-ai/client'), {
      fal: {
        config() {},
        storage: { upload: async () => 'https://example.invalid/uploaded-image.png' },
        subscribe: async () => ({ data: { video: { url: 'https://example.invalid/video.mp4' } } }),
      },
    });
    restoreElevenLabs = mockResolvedModule(require.resolve('@elevenlabs/elevenlabs-js'), {
      ElevenLabsClient: class {},
    });

    videoApp = buildRouteTestApp('/api/video', reloadModule('../src/routes/video'));
    elevenLabsApp = buildRouteTestApp('/api/elevenlabs', reloadModule('../src/routes/elevenlabs'));
  });

  after(() => {
    restoreElevenLabs();
    restoreFal();
    restoreDatabase();
    if (oldUploadDir === undefined) {
      delete process.env.UPLOAD_DIR;
    } else {
      process.env.UPLOAD_DIR = oldUploadDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('downloads generated videos from the confined upload directory', async () => {
    const res = await request(videoApp)
      .get('/api/video/download/video_test.mp4')
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="video_test.mp4"');
    assert.equal(res.body.toString(), '0123456789');
  });

  test('streams valid video ranges and rejects unsatisfiable ranges', async () => {
    const partial = await request(videoApp)
      .get('/api/video/watch/video_test.mp4')
      .set('Range', 'bytes=2-5')
      .buffer(true)
      .parse(binaryParser)
      .expect(206);

    assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
    assert.equal(partial.body.toString(), '2345');

    const invalid = await request(videoApp)
      .get('/api/video/watch/video_test.mp4')
      .set('Range', 'bytes=99-100')
      .expect(416);

    assert.equal(invalid.headers['content-range'], 'bytes */10');
  });

  test('rejects unsafe media filenames before touching the filesystem', async () => {
    await request(videoApp).get('/api/video/download/not-video.txt').expect(400);
    await request(elevenLabsApp).get('/api/elevenlabs/audio/not-audio.txt').expect(400);
  });

  test('serves generated ElevenLabs audio with safe inline metadata', async () => {
    const res = await request(elevenLabsApp)
      .get('/api/elevenlabs/audio/tts_test.mp3')
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.equal(res.headers['content-disposition'], 'inline; filename="tts_test.mp3"');
    assert.equal(res.body.toString(), 'audio-bytes');
  });
});
