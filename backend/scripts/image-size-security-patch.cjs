'use strict';

// Reviewed local fix for image-size 1.2.1. Keep its version and MIT license:
// npm audit still reports the original advisory; verify the actual bytes.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const VERSION = '1.2.1';
const ADVISORIES = Object.freeze(['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq']);
const PATCHES = Object.freeze([
  {
    file: 'dist/types/utils.js',
    beforeSha256: 'e9faf86abcc962a5fc2488a4c3c9d8dc915aa22a0dd6a7bad6556cd9a326c349',
    afterSha256: 'e0b7c528061ea4f84fcefa819d1a9bbfbc4bbd26b299377f77a57e4ad6681272',
    before: `function readBox(input, offset) {
    if (input.length - offset < 4)
        return;
    const boxSize = (0, exports.readUInt32BE)(input, offset);
    if (input.length - offset < boxSize)
        return;`,
    after: `function readBox(input, offset) {
    // SiraGPT security patch: a returned box must advance its caller's cursor.
    if (!Number.isInteger(offset) || offset < 0 || input.length - offset < 8)
        return;
    const declaredSize = (0, exports.readUInt32BE)(input, offset);
    // ISO BMFF size zero denotes the final box extending to end of input.
    // Resolve it to a positive size instead of returning a zero-sized box.
    const boxSize = declaredSize === 0 ? input.length - offset : declaredSize;
    if (boxSize < 8 || input.length - offset < boxSize)
        return;`,
  },
  {
    file: 'dist/types/icns.js',
    beforeSha256: '5e6a097fca237b0bb3b68a1be920e39a3846c0018d8917658b5ed88590a710e8',
    afterSha256: 'e21f991efefc1704fda39e5a65b746fbaaeeb69c9b942a1c3bdec581b032dfd3',
    before: `function readImageHeader(input, imageOffset) {
    const imageLengthOffset = imageOffset + ENTRY_LENGTH_OFFSET;
    return [
        (0, utils_1.toUTF8String)(input, imageOffset, imageLengthOffset),
        (0, utils_1.readUInt32BE)(input, imageLengthOffset),
    ];
}`,
    after: `function readImageHeader(input, imageOffset) {
    // SiraGPT security patch: reject truncated/non-advancing ICNS entries.
    const fileLength = (0, utils_1.readUInt32BE)(input, FILE_LENGTH_OFFSET);
    if (!Number.isInteger(imageOffset) || imageOffset < SIZE_HEADER
        || imageOffset + SIZE_HEADER > input.length || imageOffset + SIZE_HEADER > fileLength)
        throw new TypeError('Invalid ICNS entry');
    const imageLengthOffset = imageOffset + ENTRY_LENGTH_OFFSET;
    const entryLength = (0, utils_1.readUInt32BE)(input, imageLengthOffset);
    if (entryLength < SIZE_HEADER || imageOffset + entryLength > fileLength)
        throw new TypeError('Invalid ICNS entry');
    return [
        (0, utils_1.toUTF8String)(input, imageOffset, imageLengthOffset),
        entryLength,
    ];
}`,
  },
]);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function fail(message) {
  const error = new Error(`[image-size-security-patch] ${message}`);
  error.code = 'IMAGE_SIZE_PATCH_UNVERIFIED';
  return error;
}
function transform(source, patch) {
  if (sha256(source) !== patch.beforeSha256) throw fail(`unexpected upstream bytes: ${patch.file}`);
  const text = source.toString('utf8');
  if (text.split(patch.before).length !== 2) throw fail(`patch anchor is not unique: ${patch.file}`);
  return Buffer.from(text.replace(patch.before, patch.after));
}

function collectCopies(nodeModules) {
  const root = fs.realpathSync(nodeModules); const copies = []; const seen = new Set();
  const inside = (target) => target === root || target.startsWith(root + path.sep);
  function visitPackage(candidate) {
    const real = fs.realpathSync(candidate);
    // Do not silently patch a shared/symlinked installation outside this tree.
    if (!inside(real)) throw fail('dependency points outside the isolated node_modules tree');
    if (seen.has(real)) return;
    seen.add(real);
    const manifest = path.join(real, 'package.json');
    if (path.basename(candidate) === 'image-size' && !fs.existsSync(manifest))
      throw fail('image-size manifest is missing');
    if (fs.existsSync(manifest)) {
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (path.basename(candidate) === 'image-size' && data.name !== 'image-size')
        throw fail('image-size manifest identity changed');
      if (data.name === 'image-size') {
        if (data.version !== VERSION) throw fail('unexpected image-size version; review the security patch');
        copies.push(real);
      }
    }
    visitModules(path.join(real, 'node_modules'));
  }
  function visitModules(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const candidate = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(candidate, { withFileTypes: true }))
          if (scoped.isDirectory() || scoped.isSymbolicLink()) visitPackage(path.join(candidate, scoped.name));
      } else visitPackage(candidate);
    }
  }
  visitModules(root);
  if (!copies.length) throw fail('no image-size installation found');
  return { root, copies: copies.sort() };
}

function applyImageSizePatch({ nodeModules = path.resolve(__dirname, '../node_modules'), verify = false } = {}) {
  const { root, copies } = collectCopies(nodeModules); const pending = []; const report = [];
  // Validate EVERY copy and file before writing anything. Unknown versions,
  // tampering and missing files must fail closed, including --verify mode.
  for (const copy of copies) {
    const files = [];
    for (const patch of PATCHES) {
      const target = path.join(copy, patch.file);
      if (fs.lstatSync(target).isSymbolicLink()) throw fail('patched file cannot be a symlink');
      if (!fs.realpathSync(target).startsWith(copy + path.sep)) throw fail('patched file points outside its package');
      const source = fs.readFileSync(target); const digest = sha256(source);
      if (digest !== patch.afterSha256) {
        if (verify) throw fail(`unpatched or unknown bytes: ${patch.file}`);
        const updated = transform(source, patch);
        if (sha256(updated) !== patch.afterSha256) throw fail(`unexpected patched digest: ${patch.file}`);
        pending.push({ target, updated });
      }
      files.push({ file: patch.file, sha256: patch.afterSha256 });
    }
    report.push({ path: path.relative(root, copy), version: VERSION, files });
  }
  for (const { target, updated } of pending) fs.writeFileSync(target, updated);
  // Read back all bytes: a successful lifecycle command is not proof by itself.
  for (const copy of copies) for (const patch of PATCHES)
    if (sha256(fs.readFileSync(path.join(copy, patch.file))) !== patch.afterSha256) throw fail('post-patch verification failed');
  return { package: 'image-size', version: VERSION, advisories: ADVISORIES, verified: true, patchedFiles: pending.length, copies: report };
}

if (require.main === module) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--verify')) throw fail('unsupported argument');
    console.log(JSON.stringify(applyImageSizePatch({ verify: process.argv.includes('--verify') })));
  } catch (error) {
    console.error(error?.code === 'IMAGE_SIZE_PATCH_UNVERIFIED' ? error.message : '[image-size-security-patch] verification failed');
    process.exitCode = 1;
  }
}
module.exports = { ADVISORIES, PATCHES, VERSION, applyImageSizePatch, sha256, transform };
