'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ADVISORIES, PATCHES, applyImageSizePatch, sha256 } = require('../scripts/image-size-security-patch.cjs');

const installedPackage = path.dirname(require.resolve('image-size/package.json'));
const backendModules = path.resolve(__dirname, '../node_modules');

function fixture(t, copies = ['image-size']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-image-size-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nodeModules = path.join(dir, 'node_modules'); fs.mkdirSync(nodeModules);
  for (const name of copies) {
    const destination = path.join(nodeModules, name);
    fs.cpSync(installedPackage, destination, { recursive: true });
    // Tests reproduce the official original bytes even after postinstall ran.
    for (const patch of PATCHES) {
      const target = path.join(destination, patch.file); let source = fs.readFileSync(target);
      if (sha256(source) === patch.afterSha256) source = Buffer.from(source.toString('utf8').replace(patch.after, patch.before));
      assert.equal(sha256(source), patch.beforeSha256, `fixture upstream hash: ${patch.file}`);
      fs.writeFileSync(target, source);
    }
  }
  return { dir, nodeModules, packagePath: path.join(nodeModules, copies[0]) };
}

function uint32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function box(name, payload = Buffer.alloc(0), size = payload.length + 8) {
  return Buffer.concat([uint32(size), Buffer.from(name), payload]);
}
function icns(entries = [['is32', 8]], fileLength) {
  const content = Buffer.concat(entries.map(([type, length]) => Buffer.concat([Buffer.from(type), uint32(length)])));
  return Buffer.concat([Buffer.from('icns'), uint32(fileLength ?? content.length + 8), content]);
}
function jxl({ partial = false, zero = false, size } = {}) {
  const stream = Buffer.from([0xff, 0x0a, 0x01, 0x00]);
  const payload = partial ? Buffer.concat([uint32(0), stream]) : stream;
  return Buffer.concat([
    box('JXL ', Buffer.from([13, 10, 135, 10])),
    box('ftyp', Buffer.concat([Buffer.from('jxl '), uint32(0), Buffer.from('jxl ')])),
    box(partial ? 'jxlp' : 'jxlc', payload, zero ? 0 : size ?? payload.length + 8),
  ]);
}
function heif(brand = 'avif', zero = false) {
  const ispe = box('ispe', Buffer.concat([uint32(0), uint32(17), uint32(23)]), zero ? 0 : 20);
  return Buffer.concat([
    box('ftyp', Buffer.concat([Buffer.from(brand), uint32(0)])),
    box('meta', Buffer.concat([uint32(0), box('iprp', box('ipco', ispe))])),
  ]);
}

// The historical parsers deliberately hang on two tiny inputs. Never execute
// them in the test runner: start a deadline AFTER the child loads the parser,
// bound its heap, kill it, and await its exit before continuing.
function parseChild(packagePath, inputs, { deadlineMs = 1200, files = false } = {}) {
  return new Promise((resolve, reject) => {
    const code = `const imageSize = require(process.argv[1]);
      const cases = JSON.parse(process.argv[2]);
      process.stdout.write('READY\\n');
      const results = cases.map(value => { try {
        return { value: imageSize(${files ? 'value' : "Buffer.from(value, 'base64')"}) };
      } catch (error) { return { error: error.name }; } });
      process.stdout.write(JSON.stringify(results));`;
    const child = spawn(process.execPath, ['--max-old-space-size=128', '-e', code, packagePath,
      JSON.stringify(files ? inputs : inputs.map((buffer) => buffer.toString('base64')))], {
      env: { PATH: process.env.PATH, NODE_PATH: backendModules }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let timedOut = false; let deadline;
    const startup = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('image-size child did not start')); }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!deadline && stdout.startsWith('READY\n')) {
        clearTimeout(startup);
        deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, deadlineMs);
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (error) => { clearTimeout(startup); clearTimeout(deadline); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(startup); clearTimeout(deadline);
      if (timedOut) return resolve({ timedOut, signal });
      if (status !== 0) return reject(new Error(`image-size child exited ${status}/${signal}: ${stderr}`));
      try { resolve({ timedOut: false, results: JSON.parse(stdout.slice('READY\n'.length)) }); } catch (error) { reject(error); }
    });
  });
}

test('official ICNS zero-entry reproduces bounded hang before fix, rejects after fix', async (t) => {
  const f = fixture(t); const hostile = icns([['is32', 0]]);
  assert.equal(hostile.length, 16);
  const before = await parseChild(f.packagePath, [hostile], { deadlineMs: 100 });
  assert.deepEqual(before, { timedOut: true, signal: 'SIGKILL' });
  applyImageSizePatch(f);
  assert.deepEqual(await parseChild(f.packagePath, [hostile]), { timedOut: false, results: [{ error: 'TypeError' }] });
});

test('matched zero-size JXL partial box reproduces bounded hang; legal EOF box works after fix', async (t) => {
  const f = fixture(t); const bytes = jxl({ partial: true, zero: true }); assert.ok(bytes.length < 100);
  assert.deepEqual(await parseChild(f.packagePath, [bytes], { deadlineMs: 100 }), { timedOut: true, signal: 'SIGKILL' });
  applyImageSizePatch(f);
  assert.deepEqual(await parseChild(f.packagePath, [bytes]), { timedOut: false, results: [{ value: { width: 8, height: 8, type: 'jxl' } }] });
});

test('valid ICNS, AVIF/HEIC/HEIF and JXL dimensions are byte-for-byte equivalent to upstream results', async (t) => {
  const f = fixture(t);
  const inputs = [icns(), icns([['is32', 8], ['icp5', 8]]), icns([['is32', 600000]], 600008),
    heif('avif'), heif('heic'), heif('mif1'), jxl(), jxl({ partial: true })];
  const before = await parseChild(f.packagePath, inputs);
  assert.ok(before.results.every((result) => result.value?.width > 0 && result.value?.height > 0));
  applyImageSizePatch(f);
  assert.deepEqual(await parseChild(f.packagePath, inputs), before);
});

test('common real encoded PNG/JPEG/WebP/GIF/TIFF/AVIF files retain dimensions and formats', async (t) => {
  const f = fixture(t); const sharp = require('sharp'); const files = [];
  for (const format of ['png', 'jpeg', 'webp', 'gif', 'tiff', 'avif']) {
    const file = path.join(f.dir, `image.${format}`);
    await sharp({ create: { width: 17, height: 23, channels: 3, background: '#19aacc' } }).toFormat(format).toFile(file);
    files.push(file);
  }
  const before = await parseChild(f.packagePath, files, { files: true });
  assert.ok(before.results.every((result) => result.value?.width === 17 && result.value?.height === 23));
  applyImageSizePatch(f);
  assert.deepEqual(await parseChild(f.packagePath, files, { files: true }), before);
});

test('zero-to-EOF BMFF boxes are accepted without dropping supported formats', async (t) => {
  const f = fixture(t); applyImageSizePatch(f);
  const parsed = await parseChild(f.packagePath, [heif('avif', true), heif('heic', true), jxl({ zero: true })]);
  assert.deepEqual(parsed.results, [{ value: { height: 23, width: 17, type: 'avif' } },
    { value: { height: 23, width: 17, type: 'heic' } }, { value: { width: 8, height: 8, type: 'jxl' } }]);
});

test('malformed ICNS entries and JXL boxes reject promptly after patch', async (t) => {
  const f = fixture(t); applyImageSizePatch(f);
  const malformed = [icns([['is32', 0]]), icns([['is32', 1]]), icns([['is32', 7]]),
    icns([['is32', 17]]), icns([['is32', 8]], 12), icns([['is32', 8]]).subarray(0, 13),
    jxl({ partial: true, size: 1 }), jxl({ partial: true, size: 7 }), jxl({ partial: true, size: 0xffffffff })];
  const parsed = await parseChild(f.packagePath, malformed);
  assert.equal(parsed.timedOut, false); assert.ok(parsed.results.every((result) => result.error));
});

test('all hoisted, scoped and nested copies must be patched and verified; rerun is idempotent', (t) => {
  const f = fixture(t, ['image-size', 'pptxgenjs/node_modules/image-size', '@fixture/pkg/node_modules/image-size']);
  assert.throws(() => applyImageSizePatch({ ...f, verify: true }), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  const applied = applyImageSizePatch(f);
  assert.equal(applied.copies.length, 3); assert.equal(applied.patchedFiles, 6); assert.deepEqual(applied.advisories, ADVISORIES);
  const verified = applyImageSizePatch({ ...f, verify: true }); assert.equal(verified.verified, true); assert.equal(verified.patchedFiles, 0);
  assert.deepEqual(applyImageSizePatch(f), verified);
  for (const copy of verified.copies) for (const file of copy.files)
    assert.equal(sha256(fs.readFileSync(path.join(f.nodeModules, copy.path, file.file))), file.sha256);
});

test('unexpected version in any nested copy aborts before writing a known copy', (t) => {
  const f = fixture(t, ['image-size', 'z/node_modules/image-size']);
  const manifest = path.join(f.nodeModules, 'z/node_modules/image-size/package.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'image-size', version: '2.0.2' }));
  assert.throws(() => applyImageSizePatch(f), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  assert.equal(sha256(fs.readFileSync(path.join(f.packagePath, PATCHES[0].file))), PATCHES[0].beforeSha256);
});

test('unexpected source in any copy aborts before writing otherwise valid files', (t) => {
  const f = fixture(t, ['image-size', 'z/node_modules/image-size']);
  fs.appendFileSync(path.join(f.nodeModules, 'z/node_modules/image-size', PATCHES[1].file), '\n// unexpected drift');
  assert.throws(() => applyImageSizePatch(f), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  for (const patch of PATCHES) assert.equal(sha256(fs.readFileSync(path.join(f.packagePath, patch.file))), patch.beforeSha256);
});

test('a nested image-size copy cannot evade verification by removing or renaming its manifest', (t) => {
  const f = fixture(t, ['image-size', 'z/node_modules/image-size']);
  const manifest = path.join(f.nodeModules, 'z/node_modules/image-size/package.json');
  fs.unlinkSync(manifest);
  assert.throws(() => applyImageSizePatch(f), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  fs.writeFileSync(manifest, JSON.stringify({ name: 'other-package', version: '1.2.1' }));
  assert.throws(() => applyImageSizePatch(f), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  assert.equal(sha256(fs.readFileSync(path.join(f.packagePath, PATCHES[0].file))), PATCHES[0].beforeSha256);
});

test('missing patched file prevents installation verification', (t) => {
  const f = fixture(t); fs.unlinkSync(path.join(f.packagePath, PATCHES[1].file));
  assert.throws(() => applyImageSizePatch(f));
  assert.equal(sha256(fs.readFileSync(path.join(f.packagePath, PATCHES[0].file))), PATCHES[0].beforeSha256);
  assert.throws(() => applyImageSizePatch({ ...f, verify: true }));
});

test('tampering after patch and absent installations cannot produce verified evidence', (t) => {
  const f = fixture(t); applyImageSizePatch(f);
  fs.appendFileSync(path.join(f.packagePath, PATCHES[0].file), '\n// drift');
  assert.throws(() => applyImageSizePatch({ ...f, verify: true }), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  assert.throws(() => applyImageSizePatch(f), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  const empty = path.join(f.dir, 'empty'); fs.mkdirSync(empty);
  assert.throws(() => applyImageSizePatch({ nodeModules: empty }), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
});

test('target file and parent directory symlinks cannot patch outside their package', (t) => {
  const f = fixture(t); const patch = PATCHES[0]; const target = path.join(f.packagePath, patch.file);
  const outside = path.join(f.dir, 'outside.js'); fs.copyFileSync(target, outside); fs.unlinkSync(target); fs.symlinkSync(outside, target);
  assert.throws(() => applyImageSizePatch(f), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  fs.unlinkSync(target); fs.copyFileSync(outside, target);
  const types = path.join(f.packagePath, 'dist/types'); const externalTypes = path.join(f.dir, 'external-types');
  fs.renameSync(types, externalTypes); fs.symlinkSync(externalTypes, types);
  assert.throws(() => applyImageSizePatch(f), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
  assert.equal(sha256(fs.readFileSync(outside)), patch.beforeSha256);
  assert.equal(sha256(fs.readFileSync(path.join(externalTypes, 'utils.js'))), patch.beforeSha256);
});

test('dependency symlink outside the isolated tree fails closed', (t) => {
  const f = fixture(t); const outside = path.join(f.dir, 'shared'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.nodeModules, 'shared'));
  assert.throws(() => applyImageSizePatch(f), { code: 'IMAGE_SIZE_PATCH_UNVERIFIED' });
});
