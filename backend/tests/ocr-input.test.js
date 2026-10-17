'use strict';

// ocr-input: every image the user sends becomes upright PNG/JPEG pages
// (HEIC/HEIF via heif-dec, BMP via ffmpeg, every TIFF page, EXIF, OSD), the
// local tessdata is found without the CDN, and the pixel primitives behind
// the new OCR variants (Sauvola, CLAHE, Laplacian blur metric) behave.
// Binaries are faked; nothing touches the network or the uploads dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');

const ocrInput = require('../src/services/ocr-input');

function tmpDir(t, prefix = 'ocr-input-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function silentLogger() {
  const lines = [];
  return { lines, warn: (...args) => lines.push(args.join(' ')), log() {}, info() {} };
}

async function solidPng(width, height, value = 255) {
  return sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } }).png().toBuffer();
}

/**
 * Fake binaries. `bins` maps a binary name to a handler (args, opts) →
 * result; unknown binaries behave like a missing executable (ENOENT).
 */
function fakeExec(bins = {}) {
  const calls = [];
  const exec = async (bin, args = [], opts = {}) => {
    calls.push({ bin, args, opts });
    const handler = bins[bin];
    if (!handler) return { code: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: 'ENOENT' };
    const out = await handler(args, opts);
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, error: null, ...out };
  };
  exec.calls = calls;
  return exec;
}

function heifDecWriting(pngs) {
  return async (args) => {
    if (args[0] === '--version') return { stdout: 'heif-dec  libheif version: 1.18.2' };
    const out = args[args.length - 1];
    const dir = path.dirname(out);
    if (pngs.length === 1) fs.writeFileSync(out, pngs[0]);
    else pngs.forEach((png, i) => fs.writeFileSync(path.join(dir, `out-${i + 1}.png`), png));
    return {};
  };
}

function ffmpegWriting(png) {
  return async (args) => {
    if (args.includes('-version')) return { stdout: 'ffmpeg version 8.1.2 Copyright' };
    fs.writeFileSync(args[args.length - 1], png);
    return {};
  };
}

function osdTesseract(stdout) {
  return async (args) => {
    if (args[0] === '--version') return { stdout: 'tesseract 5.5.2\n leptonica-1.85.0' };
    return { stdout };
  };
}

// Minimal uncompressed 8-bit greyscale multi-page TIFF (one IFD per page).
function makeTiff(pages) {
  let pos = 8;
  const layout = pages.map((p) => {
    const dataOffset = pos;
    pos += p.width * p.height;
    if (pos % 2) pos += 1;
    const ifdOffset = pos;
    pos += 2 + 9 * 12 + 4;
    return { ...p, dataOffset, ifdOffset };
  });
  const buf = Buffer.alloc(pos);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(layout[0].ifdOffset, 4);
  layout.forEach((p, i) => {
    buf.fill(p.value, p.dataOffset, p.dataOffset + p.width * p.height);
    let o = p.ifdOffset;
    buf.writeUInt16LE(9, o); o += 2;
    const entry = (tag, type, value) => {
      buf.writeUInt16LE(tag, o); buf.writeUInt16LE(type, o + 2); buf.writeUInt32LE(1, o + 4);
      if (type === 3) buf.writeUInt16LE(value, o + 8); else buf.writeUInt32LE(value, o + 8);
      o += 12;
    };
    entry(256, 4, p.width); entry(257, 4, p.height); entry(258, 3, 8); entry(259, 3, 1); entry(262, 3, 1);
    entry(273, 4, p.dataOffset); entry(277, 3, 1); entry(278, 4, p.height); entry(279, 4, p.width * p.height);
    buf.writeUInt32LE(i + 1 < layout.length ? layout[i + 1].ifdOffset : 0, o);
  });
  return buf;
}

// Minimal 24-bit BMP (bottom-up rows padded to 4 bytes).
function makeBmp(width, height, value = 0) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * height, 34);
  buf.fill(value, 54);
  return buf;
}

function isoBox(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function ispeBox(width, height) {
  const body = Buffer.alloc(12);
  body.writeUInt32BE(width, 4);
  body.writeUInt32BE(height, 8);
  return isoBox('ispe', body);
}

// ftyp + meta (iprp/ipco with one `ispe` per image item) + mdat. `sizes:
// null` leaves the meta box out (sizes unknown).
function heicBytes(brand = 'heic', { sizes = [[2000, 1000]] } = {}) {
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, 'latin1'), Buffer.from([0, 0, 0, 0]),
    Buffer.from(`mif1${brand}`, 'latin1'),
  ]);
  const meta = sizes
    ? isoBox('meta', Buffer.alloc(4),
      isoBox('hdlr', Buffer.alloc(8), Buffer.from('pict', 'latin1'), Buffer.alloc(13)),
      isoBox('iprp', isoBox('ipco', ...sizes.map(([w, h]) => ispeBox(w, h)))))
    : Buffer.alloc(0);
  return Buffer.concat([ftyp, meta, isoBox('mdat', Buffer.alloc(64))]);
}

function baseEnv(t, extra = {}) {
  const tmp = tmpDir(t);
  const empty = tmpDir(t, 'ocr-input-notess-');
  return {
    tmp,
    env: {
      PATH: process.env.PATH,
      SIRAGPT_OCR_TMP_DIR: tmp,
      SIRAGPT_TESSDATA_DIR: empty,
      SIRAGPT_TESSDATA_CACHE_DIR: path.join(tmp, 'cache'),
      ...extra,
    },
  };
}

test.beforeEach(() => ocrInput.resetProbeCache());

test('format sniffing reads magic bytes; mime/name only break ties', () => {
  const s = ocrInput.sniffImageFormat;
  assert.equal(s(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(s(Buffer.from('89504e470d0a1a0a', 'hex')), 'png');
  assert.equal(s(Buffer.from('GIF89a......')), 'gif');
  assert.equal(s(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(s(Buffer.from('II*\0\x08\0\0\0', 'latin1')), 'tiff');
  assert.equal(s(Buffer.from('MM\0*\0\0\0\x08', 'latin1')), 'tiff');
  assert.equal(s(Buffer.from('BM\0\0\0\0', 'latin1')), 'bmp');
  assert.equal(s(heicBytes('heic')), 'heic');
  assert.equal(s(heicBytes('heix')), 'heic');
  assert.equal(s(heicBytes('avif')), 'avif');
  assert.equal(s(Buffer.from('<?xml version="1.0"?><svg xmlns="x">', 'latin1')), 'svg');
  assert.equal(s(Buffer.from('%PDF-1.7')), 'pdf');
  assert.equal(s(Buffer.from([0, 0, 1, 0, 1, 0])), 'ico');
  assert.equal(s(Buffer.from('????'), { name: 'IMG_0001.HEIC' }), 'heic');
  assert.equal(s(Buffer.from('????'), { mime: 'image/bmp' }), 'bmp');
  assert.equal(s(Buffer.from('????')), 'unknown');
  // A lying mime never beats the bytes.
  assert.equal(s(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { mime: 'image/heic', name: 'x.heic' }), 'jpeg');
});

test('a clean PNG passes through byte-identical (today’s behaviour for the common case)', async (t) => {
  const { env } = baseEnv(t);
  const png = await solidPng(800, 300);
  const exec = fakeExec();
  const r = await ocrInput.normalizeImageInput(png, { env, exec, logger: silentLogger() });
  assert.equal(r.ok, true);
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].buffer, png);
  assert.equal(r.pages[0].source, 'original');
  assert.equal(r.pages[0].mime, 'image/png');
  assert.equal(r.pages[0].rotation, 0);
  assert.equal(r.format, 'png');
});

test('EXIF orientation is applied once and reported', async (t) => {
  const { env } = baseEnv(t);
  const jpeg = await sharp({ create: { width: 600, height: 200, channels: 3, background: 'white' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const r = await ocrInput.normalizeImageInput(jpeg, { env, exec: fakeExec(), logger: silentLogger() });
  assert.equal(r.ok, true);
  const page = r.pages[0];
  assert.equal(page.rotation, 90);
  assert.equal(page.exifOrientation, 6);
  assert.deepEqual([page.width, page.height], [200, 600]);
  assert.ok(r.warnings.includes('exif_rotated'));
  const meta = await sharp(page.buffer).metadata();
  assert.ok(!meta.orientation || meta.orientation === 1, 'output carries no orientation to re-apply');
});

test('every page of a multi-page TIFF is read, with a cap that is reported', async (t) => {
  const { env } = baseEnv(t);
  const tiff = makeTiff([{ width: 320, height: 200, value: 255 }, { width: 320, height: 200, value: 128 }, { width: 200, height: 320, value: 0 }]);
  const all = await ocrInput.normalizeImageInput(tiff, { env, exec: fakeExec(), logger: silentLogger() });
  assert.equal(all.ok, true);
  assert.equal(all.format, 'tiff');
  assert.equal(all.totalPages, 3);
  assert.equal(all.pages.length, 3);
  assert.deepEqual(all.pages.map((p) => p.source), ['sharp:tiff#1', 'sharp:tiff#2', 'sharp:tiff#3']);
  assert.deepEqual([all.pages[2].width, all.pages[2].height], [200, 320]);
  const stats = await sharp(all.pages[1].buffer).stats();
  assert.equal(Math.round(stats.channels[0].mean), 128, 'page 2 is really page 2');

  const capped = await ocrInput.normalizeImageInput(tiff, { env, exec: fakeExec(), logger: silentLogger(), maxPages: 2 });
  assert.equal(capped.pages.length, 2);
  assert.equal(capped.totalPages, 3);
  assert.equal(capped.truncatedPages, 1);
  assert.ok(capped.warnings.includes('page_cap'));
});

test('a TIFF page that cannot be decoded keeps its number; the pages after it keep theirs', async (t) => {
  const { env } = baseEnv(t);
  const tiff = makeTiff([
    { width: 320, height: 200, value: 255 },
    { width: 320, height: 200, value: 128 },
    { width: 320, height: 200, value: 64 },
    { width: 320, height: 200, value: 0 },
  ]);
  // Page 2 (index 1) fails to decode, as a corrupt strip would.
  const sharpImpl = (input, options) => {
    if (options && options.page === 1) throw new Error('VipsTiff: read error');
    return sharp(input, options);
  };
  const r = await ocrInput.normalizeImageInput(tiff, { env, exec: fakeExec(), logger: silentLogger(), sharpImpl, osd: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pages.map((p) => p.page), [1, 3, 4]);
  assert.deepEqual(r.pages.map((p) => p.source), ['sharp:tiff#1', 'sharp:tiff#3', 'sharp:tiff#4']);
  assert.deepEqual(r.unreadablePages, [{ page: 2, error: 'decode_failed' }]);
  assert.equal(r.truncatedPages, 0, 'an unreadable page is not a cap');
  assert.ok(r.warnings.includes('page_decode_failed'));
  assert.ok(!r.warnings.includes('page_cap'));
  const stats = await sharp(r.pages[1].buffer).stats();
  assert.equal(Math.round(stats.channels[0].mean), 64, 'page 3 is really page 3');

  // A cap after the failure still counts only the pages past the cap.
  const capped = await ocrInput.normalizeImageInput(tiff, { env, exec: fakeExec(), logger: silentLogger(), sharpImpl, osd: false, maxPages: 3 });
  assert.deepEqual(capped.pages.map((p) => p.page), [1, 3]);
  assert.deepEqual(capped.unreadablePages, [{ page: 2, error: 'decode_failed' }]);
  assert.equal(capped.truncatedPages, 1);

  // Page 1 failing no longer throws the whole TIFF away.
  const firstBad = (input, options) => {
    if (options && options.page === 0) throw new Error('VipsTiff: read error');
    return sharp(input, options);
  };
  const r2 = await ocrInput.normalizeImageInput(tiff, { env, exec: fakeExec(), logger: silentLogger(), sharpImpl: firstBad, osd: false });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.pages.map((p) => p.page), [2, 3, 4]);
  assert.deepEqual(r2.unreadablePages, [{ page: 1, error: 'decode_failed' }]);
});

test('HEIC goes through heif-dec into a private temp dir that is always removed', async (t) => {
  const { env, tmp } = baseEnv(t);
  const decoded = await solidPng(2000, 1000);
  const exec = fakeExec({ 'heif-dec': heifDecWriting([decoded]) });
  const r = await ocrInput.normalizeImageInput(heicBytes(), { env, exec, logger: silentLogger(), mime: 'image/heic' });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'heic');
  assert.equal(r.pages[0].source, 'heif-dec');
  assert.equal(r.pages[0].mime, 'image/jpeg', 'a 2 MP photo travels as JPEG, not raw HEIC');
  assert.deepEqual([r.pages[0].width, r.pages[0].height], [2000, 1000]);
  const decodeCall = exec.calls.find((c) => c.bin === 'heif-dec' && c.args[0] !== '--version');
  assert.ok(decodeCall.args[1].endsWith('out.png'));
  assert.ok(decodeCall.opts.timeoutMs > 0, 'bounded');
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('sira-ocr-')), [], 'temp files cleaned');
});

test('HEIC with several top-level images becomes several pages', async (t) => {
  const { env } = baseEnv(t);
  const exec = fakeExec({ 'heif-dec': heifDecWriting([await solidPng(400, 300, 10), await solidPng(400, 300, 200)]) });
  const r = await ocrInput.normalizeImageInput(heicBytes(), { env, exec, logger: silentLogger() });
  assert.equal(r.ok, true);
  assert.equal(r.pages.length, 2);
  const means = await Promise.all(r.pages.map(async (p) => Math.round((await sharp(p.buffer).stats()).channels[0].mean)));
  assert.deepEqual(means, [10, 200], 'out-1 before out-2');
});

test('HEIC without heif-dec falls back to ffmpeg, warns once, and reports it', async (t) => {
  const { env } = baseEnv(t);
  const logger = silentLogger();
  const exec = fakeExec({ ffmpeg: ffmpegWriting(await solidPng(500, 400)) });
  const first = await ocrInput.normalizeImageInput(heicBytes(), { env, exec, logger });
  const second = await ocrInput.normalizeImageInput(heicBytes(), { env, exec, logger });
  assert.equal(first.ok, true);
  assert.equal(first.pages[0].source, 'ffmpeg');
  assert.ok(first.warnings.includes('heif_decoder_missing'));
  assert.ok(first.warnings.includes('heic_decoded_by_ffmpeg'));
  assert.equal(second.ok, true);
  assert.equal(logger.lines.filter((l) => /heif-dec/.test(l)).length, 1, 'one WARN line per process');
  // heif-dec and heif-convert were each probed once (memoised).
  assert.equal(exec.calls.filter((c) => c.bin === 'heif-dec').length, 1);
  assert.equal(exec.calls.filter((c) => c.bin === 'heif-convert').length, 1);
});

test('HEIC with no decoder at all fails typed (the caller keeps the raw input)', async (t) => {
  const { env } = baseEnv(t);
  const r = await ocrInput.normalizeImageInput(heicBytes(), { env, exec: fakeExec(), logger: silentLogger() });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'heic_decode_failed');
  assert.equal(r.format, 'heic');
  assert.deepEqual(r.pages, []);
});

test('a decoder that hangs is bounded: its timeout counts as a failure', async (t) => {
  const { env } = baseEnv(t);
  const exec = fakeExec({
    'heif-dec': async (args) => (args[0] === '--version' ? { stdout: 'libheif 1.18' } : { code: null, timedOut: true, error: 'timeout' }),
  });
  const r = await ocrInput.normalizeImageInput(heicBytes(), { env, exec, logger: silentLogger() });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'heic_decode_failed');
});

test('BMP goes through ffmpeg (no sharp loader); input path is passed as file: to block protocol tricks', async (t) => {
  const { env, tmp } = baseEnv(t);
  const bmpPath = path.join(tmp, 'scan.bmp');
  fs.writeFileSync(bmpPath, makeBmp(40, 20));
  const exec = fakeExec({ ffmpeg: ffmpegWriting(await solidPng(400, 200)) });
  const r = await ocrInput.normalizeImageInput(bmpPath, { env, exec, logger: silentLogger() });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'bmp');
  assert.equal(r.pages[0].source, 'ffmpeg');
  assert.equal(r.pages[0].mime, 'image/png');
  const call = exec.calls.find((c) => c.bin === 'ffmpeg' && c.args.includes('-i'));
  assert.equal(call.args[call.args.indexOf('-i') + 1], `file:${bmpPath}`);
  assert.ok(call.args.includes('-frames:v'));
});

test('decompression bomb: an ffmpeg-only image over the pixel cap is refused before ffmpeg decodes it', async (t) => {
  const { env } = baseEnv(t);
  const ffmpeg = ffmpegWriting(await solidPng(400, 200));
  // ffprobe reads the declared size (a few-KB RLE file can declare 16000×16000).
  const huge = fakeExec({ ffmpeg, ffprobe: async () => ({ stdout: '16000,16000\n' }) });
  const r = await ocrInput.normalizeImageInput(makeBmp(40, 20), { env, exec: huge, logger: silentLogger(), osd: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_too_large');
  assert.equal(huge.calls.filter((c) => c.bin === 'ffmpeg' && c.args.includes('-i')).length, 0, 'never decoded');
  const probeCall = huge.calls.find((c) => c.bin === 'ffprobe');
  assert.equal(probeCall.args[probeCall.args.indexOf('-max_pixels') + 1], '150000000', 'ffprobe itself is bounded');
  assert.ok(probeCall.opts.timeoutMs > 0);

  // ffprobe refused the frame itself (it decodes to learn some sizes).
  ocrInput.resetProbeCache();
  const refused = fakeExec({ ffmpeg, ffprobe: async () => ({ stdout: '0,0\n', stderr: '[IMGUTILS @ 0x1] Picture size 16000x16000 exceeds specified max pixel count 150000000' }) });
  const r2 = await ocrInput.normalizeImageInput(makeBmp(40, 20), { env, exec: refused, logger: silentLogger(), osd: false });
  assert.equal(r2.error, 'image_too_large');
  assert.equal(refused.calls.filter((c) => c.bin === 'ffmpeg' && c.args.includes('-i')).length, 0);

  // No ffprobe: ffmpeg still decodes under -max_pixels (an INPUT option,
  // before -i) and its refusal maps to image_too_large.
  ocrInput.resetProbeCache();
  const noProbe = fakeExec({
    ffmpeg: async (args) => (args.includes('-version')
      ? { stdout: 'ffmpeg version 8.1.2' }
      : { code: 69, stderr: 'Picture size 16000x16000 exceeds specified max pixel count 150000000' }),
  });
  const r3 = await ocrInput.normalizeImageInput(makeBmp(40, 20), { env, exec: noProbe, logger: silentLogger(), osd: false });
  assert.equal(r3.error, 'image_too_large');
  const decode = noProbe.calls.find((c) => c.bin === 'ffmpeg' && c.args.includes('-i'));
  assert.ok(decode.args.indexOf('-max_pixels') > -1 && decode.args.indexOf('-max_pixels') < decode.args.indexOf('-i'));
  assert.equal(decode.args[decode.args.indexOf('-max_pixels') + 1], '150000000');

  // Within the cap the decode runs as before.
  ocrInput.resetProbeCache();
  const fine = fakeExec({ ffmpeg, ffprobe: async () => ({ stdout: '400,200\n' }) });
  const r4 = await ocrInput.normalizeImageInput(makeBmp(40, 20), { env, exec: fine, logger: silentLogger(), osd: false });
  assert.equal(r4.ok, true);
  assert.equal(r4.pages[0].source, 'ffmpeg');
});

test('decompression bomb: HEIC sizes come from ispe before heif-dec; unknown sizes go to ffmpeg under -max_pixels', async (t) => {
  const { env } = baseEnv(t);
  const decodedPng = await solidPng(400, 300);
  const decoders = () => fakeExec({ 'heif-dec': heifDecWriting([decodedPng]), ffmpeg: ffmpegWriting(decodedPng) });
  // A grid whose full image (its own ispe) is 16000×16000, tiles 512×512.
  const bomb = decoders();
  const r = await ocrInput.normalizeImageInput(heicBytes('heic', { sizes: [[512, 512], [512, 512], [16000, 16000]] }), { env, exec: bomb, logger: silentLogger(), osd: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_too_large');
  assert.deepEqual(bomb.calls.filter((c) => c.args[0] !== '--version' && !c.args.includes('-version')), [], 'no decoder ran');

  // Sizes unreadable: heif-dec (no pixel limit) is skipped, ffmpeg decodes.
  ocrInput.resetProbeCache();
  const unknown = decoders();
  const r2 = await ocrInput.normalizeImageInput(heicBytes('heic', { sizes: null }), { env, exec: unknown, logger: silentLogger(), osd: false });
  assert.equal(r2.ok, true);
  assert.equal(r2.pages[0].source, 'ffmpeg');
  assert.ok(r2.warnings.includes('heif_size_unknown'));
  assert.equal(unknown.calls.filter((c) => c.bin === 'heif-dec' && c.args[0] !== '--version').length, 0);
  assert.ok(unknown.calls.find((c) => c.bin === 'ffmpeg' && c.args.includes('-i')).args.includes('-max_pixels'));

  // A normal iPhone photo (12 MP grid) still goes through heif-dec.
  ocrInput.resetProbeCache();
  const photo = decoders();
  const r3 = await ocrInput.normalizeImageInput(heicBytes('heic', { sizes: [[512, 512], [4032, 3024]] }), { env, exec: photo, logger: silentLogger(), osd: false });
  assert.equal(r3.ok, true);
  assert.equal(r3.pages[0].source, 'heif-dec');
  assert.deepEqual(await ocrInput._internals.readHeifImageSize(path.join(tmpDir(t), 'missing.heic')), null);
});

test('decompression bomb with the real ffprobe/ffmpeg: refused before the decode (skipped when not installed)', async (t) => {
  const probe = spawnSync('ffprobe', ['-hide_banner', '-version']);
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-version']);
  if (probe.error || probe.status !== 0 || ff.error || ff.status !== 0) { t.skip('ffmpeg/ffprobe not installed'); return; }
  const { env } = baseEnv(t, { SIRAGPT_OCR_INPUT_MAX_PIXELS: '1000000' });
  const calls = [];
  const exec = (bin, args, opts) => { calls.push({ bin, args }); return ocrInput.runCommand(bin, args, opts); };
  const r = await ocrInput.normalizeImageInput(makeBmp(1200, 1000, 90), { env, exec, logger: silentLogger(), osd: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'image_too_large');
  assert.equal(calls.filter((c) => c.bin === 'ffmpeg' && c.args.includes('-i')).length, 0, 'ffmpeg never decoded it');
  ocrInput.resetProbeCache();
});

test('BMP with the real ffmpeg (skipped when ffmpeg is not installed)', async (t) => {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-version']);
  if (probe.error || probe.status !== 0) { t.skip('ffmpeg not installed'); return; }
  const { env } = baseEnv(t);
  const r = await ocrInput.normalizeImageInput(makeBmp(64, 32, 90), { env, logger: silentLogger(), osd: false });
  assert.equal(r.ok, true);
  assert.equal(r.pages[0].source, 'ffmpeg');
  assert.deepEqual([r.pages[0].width, r.pages[0].height], [64, 32]);
});

test('OSD: a confident sideways verdict rotates the page and keeps the original for the fallback', async (t) => {
  const tess = tmpDir(t, 'ocr-input-tess-');
  fs.writeFileSync(path.join(tess, 'osd.traineddata'), 'x');
  fs.writeFileSync(path.join(tess, 'spa.traineddata'), 'x');
  const { env } = baseEnv(t, { SIRAGPT_TESSDATA_DIR: tess });
  const exec = fakeExec({ tesseract: osdTesseract('Page number: 0\nOrientation in degrees: 270\nRotate: 90\nOrientation confidence: 15.20\nScript: Latin\nScript confidence: 3.1\n') });
  const png = await solidPng(400, 200);
  const r = await ocrInput.normalizeImageInput(png, { env, exec, logger: silentLogger() });
  assert.equal(r.ok, true);
  const page = r.pages[0];
  assert.equal(page.rotation, 90);
  assert.deepEqual([page.width, page.height], [200, 400]);
  assert.deepEqual(page.osd, { rotate: 90, confidence: 15.2 });
  assert.equal(page.orientationHint, undefined);
  assert.equal(page.preRotation.buffer, png);
  assert.ok(r.warnings.includes('osd_rotated_90'));
  const meta = await sharp(page.buffer).metadata();
  assert.deepEqual([meta.width, meta.height], [200, 400]);
  const call = exec.calls.find((c) => c.bin === 'tesseract' && c.args.includes('--psm'));
  assert.deepEqual(call.args, ['--tessdata-dir', tess, 'stdin', 'stdout', '--psm', '0', '-l', 'osd']);
  assert.ok(Buffer.isBuffer(call.opts.input));
  assert.equal(call.opts.env.OMP_THREAD_LIMIT, '1');
});

test('OSD: a mid-confidence verdict (the old threshold rotated at 2) stays upright and is only a hint', async (t) => {
  // Tesseract calls ~15 "reasonably confident"; a sparse photo's 90° guess
  // at 6 must not turn the input of an image that read fine upright.
  const tess = tmpDir(t, 'ocr-input-tess-');
  fs.writeFileSync(path.join(tess, 'osd.traineddata'), 'x');
  const { env } = baseEnv(t, { SIRAGPT_TESSDATA_DIR: tess });
  const png = await solidPng(400, 200);
  const exec = fakeExec({ tesseract: osdTesseract('Rotate: 90\nOrientation confidence: 6.20\n') });
  const r = await ocrInput.normalizeImageInput(png, { env, exec, logger: silentLogger() });
  const page = r.pages[0];
  assert.equal(page.buffer, png, 'the page is not rotated');
  assert.equal(page.rotation, 0);
  assert.equal(page.preRotation, undefined);
  assert.deepEqual(page.orientationHint, { rotate: 90, confidence: 6.2 });
  assert.ok(!r.warnings.some((w) => w.startsWith('osd_rotated')));
  assert.equal(page.source, 'original');

  // The threshold stays tunable.
  ocrInput.resetProbeCache();
  const tuned = await ocrInput.normalizeImageInput(png, {
    env: { ...env, SIRAGPT_OCR_OSD_MIN_CONFIDENCE: '5' }, exec, logger: silentLogger(),
  });
  assert.equal(tuned.pages[0].rotation, 90);
  assert.equal(ocrInput.inputConfig({}).osdMinConfidence, 14);
  assert.equal(ocrInput.inputConfig({}).osdHintConfidence, 2);
});

test('OSD: a low-confidence verdict, a disabled switch or missing osd data leave the page alone', async (t) => {
  const tess = tmpDir(t, 'ocr-input-tess-');
  fs.writeFileSync(path.join(tess, 'osd.traineddata'), 'x');
  const { env } = baseEnv(t, { SIRAGPT_TESSDATA_DIR: tess });
  const png = await solidPng(400, 200);
  const weak = fakeExec({ tesseract: osdTesseract('Rotate: 180\nOrientation confidence: 0.40\n') });
  const r1 = await ocrInput.normalizeImageInput(png, { env, exec: weak, logger: silentLogger() });
  assert.equal(r1.pages[0].rotation, 0);
  assert.equal(r1.pages[0].buffer, png);
  assert.equal(r1.pages[0].osd.rotate, 180);
  assert.equal(r1.pages[0].orientationHint, undefined, 'below the hint level: not even a hypothesis');

  ocrInput.resetProbeCache();
  const off = fakeExec({ tesseract: osdTesseract('Rotate: 90\nOrientation confidence: 9\n') });
  const r2 = await ocrInput.normalizeImageInput(png, { env: { ...env, SIRAGPT_OCR_OSD: '0' }, exec: off, logger: silentLogger() });
  assert.equal(r2.pages[0].rotation, 0);
  assert.equal(off.calls.length, 0, 'OSD switched off: no process at all');

  ocrInput.resetProbeCache();
  const noData = baseEnv(t);
  const logger = silentLogger();
  const exec3 = fakeExec({ tesseract: osdTesseract('Rotate: 90\nOrientation confidence: 9\n') });
  const r3 = await ocrInput.normalizeImageInput(png, { env: noData.env, exec: exec3, logger });
  if (!fs.existsSync('/usr/share/tessdata/osd.traineddata')) {
    assert.equal(r3.pages[0].rotation, 0);
    assert.ok(logger.lines.some((l) => /orientation detection off/.test(l)));
  }
});

test('typed failures: pdf, empty, too large, aborted, garbage', async (t) => {
  const { env } = baseEnv(t);
  const opts = { env, exec: fakeExec(), logger: silentLogger() };
  assert.equal((await ocrInput.normalizeImageInput(Buffer.from('%PDF-1.4 hello'), opts)).error, 'not_an_image');
  assert.equal((await ocrInput.normalizeImageInput(Buffer.alloc(0), opts)).error, 'empty_input');
  assert.equal((await ocrInput.normalizeImageInput(null, opts)).error, 'invalid_input');
  assert.equal((await ocrInput.normalizeImageInput('/no/such/file.png', opts)).error, 'input_missing');
  const big = Buffer.alloc(1_200_000, 1);
  big.write('BM', 0, 'latin1');
  assert.equal((await ocrInput.normalizeImageInput(big, { ...opts, env: { ...env, SIRAGPT_OCR_INPUT_MAX_BYTES: '1048576' } })).error, 'input_too_large');
  const controller = new AbortController();
  controller.abort();
  assert.equal((await ocrInput.normalizeImageInput(await solidPng(10, 10), { ...opts, signal: controller.signal })).error, 'aborted');
  assert.equal((await ocrInput.normalizeImageInput(Buffer.from('definitely not an image'), opts)).ok, false);
});

test('a complete JPEG with data after its EOI (Samsung SEFT, Motion Photo MP4) passes through untouched', async (t) => {
  const { env } = baseEnv(t);
  const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const withTrailer = Buffer.concat([jpeg, Buffer.from('SEFH', 'latin1'), Buffer.alloc(4096, 7), Buffer.from('SEFT', 'latin1')]);
  const r = await ocrInput.normalizeImageInput(withTrailer, { env, exec: fakeExec(), logger: silentLogger(), osd: false });
  assert.equal(r.ok, true);
  assert.equal(r.pages[0].buffer, withTrailer, 'byte-identical pass-through');
  assert.equal(r.pages[0].source, 'original');
  assert.ok(!r.warnings.includes('truncated_image_repaired'));
  const motion = Buffer.concat([jpeg, Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(2048, 1)]);
  const m = await ocrInput.normalizeImageInput(motion, { env, exec: fakeExec(), logger: silentLogger(), osd: false });
  assert.equal(m.pages[0].buffer, motion);

  const { jpegCompleteness, pngCompleteness, looksTruncated } = ocrInput._internals;
  const progressive = await sharp({ create: { width: 640, height: 480, channels: 3, background: 'red' } })
    .jpeg({ progressive: true }).withMetadata().toBuffer();
  assert.equal(jpegCompleteness(progressive), 'complete');
  assert.equal(jpegCompleteness(progressive.slice(0, progressive.length - 200)), 'truncated');
  assert.equal(jpegCompleteness(Buffer.from('not a jpeg at all')), 'unknown');
  const png = await solidPng(300, 200);
  assert.equal(pngCompleteness(Buffer.concat([png, Buffer.alloc(512, 9)])), 'complete');
  assert.equal(pngCompleteness(png.slice(0, png.length - 20)), 'truncated');
  assert.equal(looksTruncated('png', Buffer.concat([png, Buffer.alloc(512, 9)])), false);
  assert.equal(looksTruncated('jpeg', withTrailer), false);
});

test('a truncated JPEG is repaired (decoded tolerant, re-encoded) instead of failing downstream', async (t) => {
  const { env } = baseEnv(t);
  const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const cut = jpeg.slice(0, Math.floor(jpeg.length * 0.7));
  const r = await ocrInput.normalizeImageInput(cut, { env, exec: fakeExec(), logger: silentLogger() });
  assert.equal(r.ok, true);
  assert.notEqual(r.pages[0].buffer, cut);
  assert.ok(r.warnings.includes('truncated_image_repaired'));
  await sharp(r.pages[0].buffer).png().toBuffer(); // a clean image downstream
});

test('an explicit SIRAGPT_OCR_INPUT_MAX_SIDE still bounds the long side', async (t) => {
  const { env } = baseEnv(t, { SIRAGPT_OCR_INPUT_MAX_SIDE: '2000' });
  const png = await solidPng(5000, 1000);
  const r = await ocrInput.normalizeImageInput(png, { env, exec: fakeExec(), logger: silentLogger() });
  assert.equal(r.ok, true);
  assert.deepEqual([r.pages[0].width, r.pages[0].height], [2000, 400]);
});

test('a long scroll capture (1080×14000, 15 MP) passes through at native resolution', async (t) => {
  // The tiled pass reads small glyphs from the normalised page: a long-side
  // cap of 6000 px used to shrink this to 463×6000 (43 %).
  const { env } = baseEnv(t);
  const png = await sharp({ create: { width: 1080, height: 14000, channels: 3, background: 'white' } }).png().toBuffer();
  const r = await ocrInput.normalizeImageInput(png, { env, exec: fakeExec(), logger: silentLogger(), osd: false });
  assert.equal(r.ok, true);
  assert.equal(r.pages[0].buffer, png, 'byte-identical');
  assert.equal(r.pages[0].source, 'original');
  assert.deepEqual([r.pages[0].width, r.pages[0].height], [1080, 14000]);
  assert.deepEqual(r.warnings, []);
});

test('pages are bounded by area: scaled by sqrt(cap/area), never below the short-side floor', async (t) => {
  const { env } = baseEnv(t, { SIRAGPT_OCR_INPUT_MAX_AREA: '4000000' });
  const photo = await solidPng(4000, 3000);
  const r = await ocrInput.normalizeImageInput(photo, { env, exec: fakeExec(), logger: silentLogger(), osd: false });
  const { width, height } = r.pages[0];
  assert.ok(width * height <= 4_000_000, `${width}×${height} within the cap`);
  assert.ok(width >= 2300 && height >= 1720, `${width}×${height} keeps the aspect, not a long-side cut`);

  // A narrow capture over the area cap keeps a readable short side
  // (1200 px floor; this one is already narrower, so it is left as is).
  const narrow = await solidPng(1000, 8000);
  const n = await ocrInput.normalizeImageInput(narrow, { env, exec: fakeExec(), logger: silentLogger(), osd: false });
  assert.equal(n.pages[0].buffer, narrow);

  const { fitScale } = ocrInput._internals;
  assert.equal(fitScale(1080, 14000, ocrInput.inputConfig({})), 1);
  assert.ok(Math.abs(fitScale(10000, 10000, { maxArea: 50_000_000, minShortSide: 1200 }) - Math.sqrt(0.5)) < 1e-9);
  assert.equal(fitScale(3000, 30000, { maxArea: 4_000_000, minShortSide: 1200 }), 0.4, 'floor: short side 1200');
  assert.equal(fitScale(1000, 90000, { maxArea: 50_000_000, minShortSide: 1200 }), 65000 / 90000, 'encoder ceiling');
});

test('toVisionImage: provider-safe copy only when needed', async () => {
  const small = await solidPng(800, 600);
  const same = await ocrInput.toVisionImage(small, { mime: 'image/png' });
  assert.equal(same.buffer, small);
  assert.equal(same.resized, false);
  const big = await solidPng(5000, 1500);
  const fitted = await ocrInput.toVisionImage(big, { mime: 'image/png' });
  assert.equal(fitted.resized, true);
  assert.ok(Math.max(fitted.width, fitted.height) <= 3072);
  assert.equal(fitted.mime, 'image/jpeg');
  const tiffLike = await ocrInput.toVisionImage({ buffer: small, mime: 'image/tiff' });
  assert.equal(tiffLike.resized, true, 'a non PNG/JPEG mime is always re-encoded');
  const bad = await ocrInput.toVisionImage(Buffer.from('nope'), { mime: 'image/png' });
  assert.equal(bad.error, 'vision_prepare_failed');
});

test('local tessdata: used only when EVERY language is there; a writable cache dir otherwise', (t) => {
  const tess = tmpDir(t, 'ocr-input-tess-');
  fs.writeFileSync(path.join(tess, 'spa.traineddata'), 'x');
  fs.writeFileSync(path.join(tess, 'eng.traineddata'), 'x');
  const env = { SIRAGPT_TESSDATA_DIR: tess };
  ocrInput.resetProbeCache();
  assert.deepEqual(ocrInput.resolveLocalTessdata('spa+eng', { env }), { dir: tess, languages: ['spa', 'eng'] });
  assert.equal(ocrInput.resolveLocalTessdata('spa+por', { env }), null);
  assert.equal(ocrInput.resolveLocalTessdata('spa', { env: { ...env, SIRAGPT_OCR_LOCAL_TESSDATA: '0' } }), null);
  assert.deepEqual(ocrInput.probeTessdata({ env }).languages, ['eng', 'spa']);

  ocrInput.resetProbeCache();
  const cache = path.join(tmpDir(t), 'nested', 'cache');
  assert.equal(ocrInput.tessdataCacheDir({ env: { SIRAGPT_TESSDATA_CACHE_DIR: cache } }), cache);
  assert.ok(fs.statSync(cache).isDirectory());
  ocrInput.resetProbeCache();
});

test('capability probes are memoised and report what is missing', async () => {
  ocrInput.resetProbeCache();
  const exec = fakeExec({
    'heif-convert': async () => ({ stdout: 'heif-convert libheif version: 1.12.0' }),
    ffmpeg: async () => ({ stdout: 'ffmpeg version 8.1.2 Copyright (c)' }),
  });
  const caps = await ocrInput.getOcrInputCapabilities({ exec, env: { SIRAGPT_OCR_OSD: '0', SIRAGPT_TESSDATA_CACHE_DIR: path.join(os.tmpdir(), 'ocr-input-caps-cache') } });
  assert.equal(caps.heif.available, true);
  assert.equal(caps.heif.bin, 'heif-convert');
  assert.equal(caps.ffmpeg.version, '8.1.2');
  assert.equal(caps.tesseractCli.available, false);
  assert.equal(caps.osd.available, false);
  await ocrInput.getOcrInputCapabilities({ exec, env: { SIRAGPT_OCR_OSD: '0' } });
  assert.equal(exec.calls.filter((c) => c.bin === 'ffmpeg').length, 1, 'memoised');
  fs.rmSync(path.join(os.tmpdir(), 'ocr-input-caps-cache'), { recursive: true, force: true });
  ocrInput.resetProbeCache();
});

test('parseOsd reads the native tesseract OSD report', () => {
  assert.deepEqual(ocrInput.parseOsd('Page number: 0\nOrientation in degrees: 180\nRotate: 180\nOrientation confidence: 12.5\nScript: Latin\n'), {
    rotate: 180, confidence: 12.5, script: 'Latin',
  });
  assert.equal(ocrInput.parseOsd('Too few characters. Skipping this page'), null);
  assert.equal(ocrInput.parseOsd('Rotate: 45'), null);
});

test('runCommand: stdin, timeout (SIGKILL), abort and a missing binary — never throws', async () => {
  const echo = await ocrInput.runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: Buffer.from('hola'), timeoutMs: 10_000 });
  assert.equal(echo.code, 0);
  assert.equal(echo.stdout, 'hola');

  const t0 = Date.now();
  const slow = await ocrInput.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - t0 < 10_000);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const aborted = await ocrInput.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 20_000, signal: controller.signal });
  assert.equal(aborted.aborted, true);

  const missing = await ocrInput.runCommand('/definitely/not/a/binary-ocr', []);
  assert.equal(missing.error, 'ENOENT');
});

test('Sauvola binarisation follows uneven lighting a global threshold cannot', async () => {
  const W = 200;
  const H = 60;
  const data = Buffer.alloc(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const light = 90 + Math.round((x / W) * 150); // dark left → bright right
      const ink = (x % 50 >= 20 && x % 50 < 30 && y >= 20 && y < 40) ? 120 : 0;
      data[y * W + x] = Math.max(0, light - ink);
    }
  }
  const out = await ocrInput.sauvolaBinarize(data, W, H, { radius: 12 });
  assert.equal(out[30 * W + 25], 0, 'ink in the dark half');
  assert.equal(out[30 * W + 175], 0, 'ink in the bright half');
  assert.equal(out[5 * W + 10], 255, 'background in the dark half');
  assert.equal(out[5 * W + 190], 255, 'background in the bright half');
});

test('CLAHE stretches a low-contrast image; the Laplacian sees edges, not flat fields', async () => {
  const W = 256;
  const H = 128;
  const flat = Buffer.alloc(W * H, 120);
  // A faded 100…140 gradient (a 40-level range) comes out wider; CLAHE's
  // clip limit keeps it from blowing up noise.
  const lowContrast = Buffer.alloc(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) lowContrast[y * W + x] = 100 + Math.round((40 * x) / W);
  const eq = await ocrInput.claheGray(lowContrast, W, H, { tilesX: 4, tilesY: 2 });
  let min = 255;
  let max = 0;
  for (const v of eq) { if (v < min) min = v; if (v > max) max = v; }
  assert.ok(max - min > 55, `range widened (${min}…${max})`);
  assert.equal(eq.length, W * H);
  assert.equal((await ocrInput.laplacianVariance(flat, W, H)).variance, 0);
  const checker = Buffer.alloc(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) checker[y * W + x] = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
  assert.ok((await ocrInput.laplacianVariance(checker, W, H)).variance > 1000);
});

test('measureBlur flags a blurred picture and not a crisp one', async () => {
  const W = 512;
  const H = 256;
  const raw = Buffer.alloc(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) raw[y * W + x] = ((x >> 2) + (y >> 3)) % 2 ? 230 : 20;
  const crisp = await sharp(raw, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  const blurred = await sharp(crisp).blur(8).png().toBuffer();
  const a = await ocrInput.measureBlur(crisp);
  const b = await ocrInput.measureBlur(blurred);
  assert.equal(a.ok, true);
  assert.equal(a.blurry, false);
  assert.equal(b.blurry, true);
  assert.ok(a.variance > b.variance * 10);
  assert.equal((await ocrInput.measureBlur(Buffer.from('nope'))).ok, false);
});
