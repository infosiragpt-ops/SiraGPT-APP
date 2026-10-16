'use strict';

// archive-media-expander (contract C3): the audio, video and photos of a ZIP
// upload (WhatsApp «Exportar chat») become child File rows of the same user,
// queued through the caller's scheduler and linked by
// DocumentAnalysis.metadata.archiveParent. Zip-slip, zip bombs (ratio, lying
// headers, CRC), caps, disk reserve and idempotency are covered. Offline:
// Prisma is an in-memory fake, archives are built with pizzip in a temp dir.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const PizZip = require('pizzip');
const sharp = require('sharp');

const expander = require('../src/services/archive-media-expander');

const {
  expandArchiveMedia, stampArchiveParent, isArchiveCandidate, classifyMember, looksLikeCodeArchive,
  parseWhatsAppAttachments, parseUnzipVerbose, childFilenameFor, displayNameFor,
} = expander;

const USER = 'user_luis';
const PARENT = 'cparent0000000000000000001';
const MB = 1024 * 1024;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sira-archive-'));
}

function fakePrisma({ parentName = 'WhatsApp Chat con Ana.zip', deleted = false, parentMetadata = null } = {}) {
  const files = new Map();
  const analyses = new Map();
  let seq = 0;
  files.set(PARENT, { id: PARENT, userId: USER, filename: 'files-1-zip.zip', originalName: parentName, deletedAt: deleted ? new Date() : null });
  if (parentMetadata) analyses.set(PARENT, { userId: USER, fileId: PARENT, status: 'ready', metadata: parentMetadata });
  const matches = (row, where) => Object.entries(where || {}).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
  return {
    files,
    analyses,
    file: {
      async create({ data }) {
        seq += 1;
        const row = { id: `cchild${String(seq).padStart(4, '0')}`, deletedAt: null, ...data };
        files.set(row.id, row);
        return row;
      },
      async findFirst({ where }) {
        for (const row of files.values()) if (matches(row, where)) return row;
        return null;
      },
    },
    documentAnalysis: {
      async findUnique({ where: { fileId } }) { return analyses.get(fileId) || null; },
      async upsert({ where: { fileId }, create, update }) {
        const existing = analyses.get(fileId);
        const row = existing ? { ...existing, ...update } : { ...create };
        analyses.set(fileId, row);
        return row;
      },
    },
  };
}

// Magic bytes by extension (the real detector is exercised in its own test).
async function fakeDetect(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map = { opus: 'audio/ogg', mp4: 'video/mp4', jpg: 'image/jpeg', webp: 'image/webp', wav: 'audio/wav' };
  return map[ext] ? { mime: map[ext], source: 'magic-bytes' } : { mime: null, source: 'fallback' };
}

function silentLogger() {
  const lines = [];
  return { lines, warn: (m) => lines.push(String(m)), info: (m) => lines.push(String(m)), log: (m) => lines.push(String(m)) };
}

const ANDROID_LINE = '03/10/26, 15:00 - Ana Quispe: PTT-20261003-WA0012.opus (archivo adjunto)';
const IOS_LINE = '‎[3/10/26, 15:01:12] Luis: ‎<adjunto: 00000013-AUDIO-2026-10-03-15-01-00.opus>';

async function whatsappZip(dir, { extra = null } = {}) {
  const zip = new PizZip();
  zip.file('_chat.txt', [
    '03/10/26, 14:59 - Los mensajes y las llamadas están cifrados de extremo a extremo.',
    ANDROID_LINE,
    IOS_LINE,
    '03/10/26, 15:02 - Ana Quispe: IMG-20261003-WA0003.jpg (archivo adjunto)',
    '03/10/26, 15:03 - Ana Quispe: ¿Lo escuchaste?',
  ].join('\n'));
  const media = {
    'PTT-20261003-WA0012.opus': Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(6000)]),
    '00000013-AUDIO-2026-10-03-15-01-00.opus': Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(5000)]),
    'VID-20261003-WA0004.mp4': crypto.randomBytes(9000),
    'IMG-20261003-WA0003.jpg': await sharp({ create: { width: 160, height: 120, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).jpeg().toBuffer(),
  };
  for (const [name, data] of Object.entries(media)) zip.file(name, data);
  zip.file('notas.docx', Buffer.from('not media'));
  zip.file('__MACOSX/._PTT-20261003-WA0012.opus', crypto.randomBytes(4000));
  zip.file('../evil.opus', crypto.randomBytes(4000));
  if (extra) extra(zip);
  const file = path.join(dir, 'files-1-zip.zip');
  fs.writeFileSync(file, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { file, media };
}

function baseArgs(dir, prisma, file, over = {}) {
  const userDir = path.join(dir, 'uploads', USER);
  return {
    prisma,
    userId: USER,
    parent: { id: PARENT, originalName: 'WhatsApp Chat con Ana.zip', mimeType: 'application/zip', path: file },
    userDir,
    detectMime: fakeDetect,
    limits: { minImageBytes: 1, freeSpaceReserveBytes: 0 },
    logger: silentLogger(),
    ...over,
  };
}

describe('expandArchiveMedia · WhatsApp «Exportar chat»', () => {
  test('media and photos become owned child files, scheduled and linked to the archive', async () => {
    const dir = tmpDir();
    try {
      const { file, media } = await whatsappZip(dir);
      const prisma = fakePrisma({ parentMetadata: { originalName: 'WhatsApp Chat con Ana.zip', analyzedAt: 'x' } });
      const scheduled = [];
      const args = baseArgs(dir, prisma, file, { schedule: async (child, row) => scheduled.push({ child, row }) });
      const result = await expandArchiveMedia(args);

      assert.equal(result.ok, true);
      assert.equal(result.whatsapp, true);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.skipped, { unsafe_path: 1 });
      assert.deepEqual(result.children.map((c) => [c.kind, c.member]), [
        ['media', 'PTT-20261003-WA0012.opus'],
        ['media', '00000013-AUDIO-2026-10-03-15-01-00.opus'],
        ['media', 'VID-20261003-WA0004.mp4'],
        ['image', 'IMG-20261003-WA0003.jpg'],
      ]);

      const resolvedDir = path.resolve(args.userDir);
      for (const child of result.children) {
        const row = prisma.files.get(child.fileId);
        assert.equal(row.userId, USER);
        assert.match(row.filename, new RegExp(`^archive-${PARENT}-\\d{4}-[0-9a-f]{10}\\.(opus|mp4|jpg)$`));
        assert.equal(path.dirname(row.path), resolvedDir, 'under the uploads convention <UPLOAD_DIR>/<userId>/<filename>');
        assert.equal(row.path, path.join(resolvedDir, row.filename));
        assert.deepEqual(fs.readFileSync(row.path), media[child.member], 'exact bytes');
        assert.equal(row.originalName, child.member);
        assert.equal(row.size, media[child.member].length);
        assert.equal(row.processingStage, child.kind === 'media' ? 'uploaded' : 'extracting');
        assert.equal(row.extractedText, null);
      }
      assert.equal(prisma.files.get(result.children[0].fileId).mimeType, 'audio/ogg');
      assert.equal(prisma.files.get(result.children[2].fileId).mimeType, 'video/mp4');
      assert.equal(prisma.files.get(result.children[3].fileId).mimeType, 'image/jpeg');

      // Scheduler: same shape as a multer file, plus the link.
      assert.equal(scheduled.length, 4);
      const first = scheduled[0];
      assert.equal(first.row.id, result.children[0].fileId);
      assert.deepEqual(Object.keys(first.child).sort(), ['archiveParent', 'fieldname', 'filename', 'mimetype', 'originalname', 'path', 'size']);
      assert.equal(first.child.fieldname, 'files');

      // DocumentAnalysis.metadata.archiveParent (+ WhatsApp sender and time).
      const ptt = prisma.analyses.get(result.children[0].fileId);
      assert.equal(ptt.status, 'pending');
      assert.deepEqual(ptt.metadata.archiveParent, {
        fileId: PARENT, name: 'WhatsApp Chat con Ana.zip', member: 'PTT-20261003-WA0012.opus',
        index: ptt.metadata.archiveParent.index, kind: 'media',
        whatsapp: { at: '03/10/26, 15:00', sender: 'Ana Quispe' },
      });
      assert.deepEqual(prisma.analyses.get(result.children[1].fileId).metadata.archiveParent.whatsapp, { at: '3/10/26, 15:01:12', sender: 'Luis' });
      assert.equal(prisma.analyses.get(result.children[2].fileId).metadata.archiveParent.whatsapp, undefined);

      // Parent: existing analysis metadata is kept, the expansion is added.
      const parentMeta = prisma.analyses.get(PARENT).metadata;
      assert.equal(parentMeta.analyzedAt, 'x');
      assert.equal(parentMeta.archiveExpansion.media, 3);
      assert.equal(parentMeta.archiveExpansion.images, 1);
      assert.equal(parentMeta.archiveExpansion.whatsapp, true);
      assert.deepEqual(parentMeta.archiveExpansion.children.map((c) => c.fileId), result.children.map((c) => c.fileId));

      // No partial files, no traversal, no names or contents in the log.
      const left = fs.readdirSync(resolvedDir);
      assert.equal(left.filter((n) => n.endsWith('.part')).length, 0);
      assert.equal(left.length, 4);
      assert.equal(fs.existsSync(path.join(dir, 'uploads', 'evil.opus')), false);
      assert.equal(args.logger.lines.length, 1);
      assert.match(args.logger.lines[0], new RegExp(`^\\[archive-media\\] parent=${PARENT} ok=true media=3 images=1`));
      assert.ok(!/PTT-|Ana|WhatsApp/.test(args.logger.lines[0]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('idempotent: a second pass reuses the rows and schedules nothing', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const prisma = fakePrisma();
      const first = await expandArchiveMedia(baseArgs(dir, prisma, file, { schedule: async () => {} }));
      const rows = prisma.files.size;
      let scheduled = 0;
      const second = await expandArchiveMedia(baseArgs(dir, prisma, file, { schedule: async () => { scheduled += 1; } }));
      assert.equal(second.ok, true);
      assert.equal(prisma.files.size, rows);
      assert.equal(scheduled, 0);
      assert.ok(second.children.every((c) => c.reused));
      assert.deepEqual(second.children.map((c) => c.fileId), first.children.map((c) => c.fileId));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('caps of count, images and total bytes; media first', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const counted = await expandArchiveMedia(baseArgs(dir, fakePrisma(), file, { limits: { minImageBytes: 1, freeSpaceReserveBytes: 0, maxMembers: 2 } }));
      assert.deepEqual(counted.children.map((c) => c.kind), ['media', 'media']);
      assert.equal(counted.truncated, true);
      assert.equal(counted.skipped.count_cap, 2);

      const noImages = await expandArchiveMedia(baseArgs(dir, fakePrisma(), file, { userDir: path.join(dir, 'u2'), limits: { minImageBytes: 1, freeSpaceReserveBytes: 0, maxImages: 0 } }));
      assert.equal(noImages.children.filter((c) => c.kind === 'image').length, 0);

      const bytes = await expandArchiveMedia(baseArgs(dir, fakePrisma(), file, { userDir: path.join(dir, 'u3'), limits: { minImageBytes: 1, freeSpaceReserveBytes: 0, maxBytes: 7_000 } }));
      assert.equal(bytes.children.length, 1);
      assert.ok(bytes.skipped.total_cap >= 1);

      const sticker = await expandArchiveMedia(baseArgs(dir, fakePrisma(), file, { userDir: path.join(dir, 'u4'), limits: { freeSpaceReserveBytes: 0, minImageBytes: 1024 * 1024 } }));
      assert.equal(sticker.skipped.too_small, 1, 'tiny pictures (stickers, icons) are not OCR jobs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the disk reserve is never eaten', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const prisma = fakePrisma();
      const result = await expandArchiveMedia(baseArgs(dir, prisma, file, { limits: { freeSpaceReserveBytes: Number.MAX_SAFE_INTEGER } }));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'disk_space');
      assert.equal(prisma.files.size, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('zip bombs and damaged members', () => {
  function centralDirOffsets(buf) {
    const offsets = [];
    for (let i = 0; i < buf.length - 4; i += 1) if (buf.readUInt32LE(i) === 0x02014b50) offsets.push(i);
    return offsets;
  }

  test('a suspicious compression ratio is refused before anything is written', async () => {
    const dir = tmpDir();
    try {
      const zip = new PizZip();
      zip.file('silencio.wav', Buffer.alloc(3 * MB, 0));
      const file = path.join(dir, 'bomba.zip');
      fs.writeFileSync(file, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
      const prisma = fakePrisma();
      const result = await expandArchiveMedia(baseArgs(dir, prisma, file));
      assert.deepEqual(result.skipped, { suspicious_ratio: 1 });
      assert.equal(result.children.length, 0);
      assert.equal(fs.existsSync(path.join(dir, 'uploads', USER)) ? fs.readdirSync(path.join(dir, 'uploads', USER)).length : 0, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a header that lies about the size, or a wrong CRC, never leaves a file behind', async () => {
    const dir = tmpDir();
    try {
      const zip = new PizZip();
      zip.file('nota.opus', crypto.randomBytes(5000));
      const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      const [central] = centralDirOffsets(buf);

      const lying = Buffer.from(buf);
      lying.writeUInt32LE(3000, central + 24); // uncompressed size
      const lyingFile = path.join(dir, 'miente.zip');
      fs.writeFileSync(lyingFile, lying);
      const r1 = await expandArchiveMedia(baseArgs(dir, fakePrisma(), lyingFile));
      assert.deepEqual(r1.skipped, { size_mismatch: 1 });
      assert.equal(r1.children.length, 0);

      if (typeof zlib.crc32 === 'function') {
        const badCrc = Buffer.from(buf);
        badCrc.writeUInt32LE((badCrc.readUInt32LE(central + 16) ^ 0xffffffff) >>> 0, central + 16);
        const crcFile = path.join(dir, 'crc.zip');
        fs.writeFileSync(crcFile, badCrc);
        const r2 = await expandArchiveMedia(baseArgs(dir, fakePrisma(), crcFile));
        assert.deepEqual(r2.skipped, { crc_mismatch: 1 });
      }
      const userDir = path.join(dir, 'uploads', USER);
      assert.deepEqual(fs.existsSync(userDir) ? fs.readdirSync(userDir) : [], []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('magic bytes decide: a fake photo is dropped, a real one and a WAV are kept (real detector)', async () => {
    const dir = tmpDir();
    try {
      const wav = Buffer.alloc(44 + 8000);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + 8000, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
      crypto.randomBytes(8000).copy(wav, 44);
      const zip = new PizZip();
      zip.file('grabacion.wav', wav);
      zip.file('foto.jpg', await sharp({ create: { width: 64, height: 64, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).jpeg().toBuffer());
      zip.file('falsa.jpg', crypto.randomBytes(3000));
      const file = path.join(dir, 'mixto.zip');
      fs.writeFileSync(file, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
      const args = baseArgs(dir, fakePrisma(), file);
      delete args.detectMime; // the module's own file-type detection
      const result = await expandArchiveMedia(args);
      assert.deepEqual(result.children.map((c) => [c.member, c.mimeType]).sort(), [['foto.jpg', 'image/jpeg'], ['grabacion.wav', result.children.find((c) => c.member === 'grabacion.wav').mimeType]]);
      assert.match(result.children.find((c) => c.member === 'grabacion.wav').mimeType, /^audio\//);
      assert.equal((result.skipped.type_mismatch || 0) + (result.skipped.rejected_by_policy || 0), 1);
      assert.equal(fs.readdirSync(path.join(dir, 'uploads', USER)).length, 2, 'the rejected member is removed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('refusals and degradations', () => {
  test('not a zip, switched off, parent gone, missing or unreadable archive', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const pdf = await expandArchiveMedia({ ...baseArgs(dir, fakePrisma(), file), parent: { id: PARENT, originalName: 'informe.pdf', path: file } });
      assert.equal(pdf.reason, 'not_archive');
      const off = await expandArchiveMedia(baseArgs(dir, fakePrisma(), file, { env: { SIRAGPT_ARCHIVE_MEDIA: '0' } }));
      assert.equal(off.reason, 'disabled');
      const gone = await expandArchiveMedia(baseArgs(dir, fakePrisma({ deleted: true }), file));
      assert.equal(gone.reason, 'parent_not_found');
      const missing = await expandArchiveMedia(baseArgs(dir, fakePrisma(), path.join(dir, 'no-existe.zip')));
      assert.equal(missing.reason, 'archive_missing');
      const junk = path.join(dir, 'roto.zip');
      fs.writeFileSync(junk, crypto.randomBytes(500));
      const broken = await expandArchiveMedia(baseArgs(dir, fakePrisma(), junk));
      assert.equal(broken.reason, 'archive_unreadable');
      assert.equal((await expandArchiveMedia({ logger: silentLogger() })).reason, 'no_database');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a source-code archive is left alone (its pictures are icons)', async () => {
    const dir = tmpDir();
    try {
      const zip = new PizZip();
      zip.file('app/package.json', '{"name":"x"}');
      zip.file('app/src/index.js', 'console.log(1)');
      zip.file('app/assets/logo.png', await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } }).png().toBuffer());
      zip.file('app/assets/click.wav', crypto.randomBytes(5000));
      const file = path.join(dir, 'proyecto.zip');
      fs.writeFileSync(file, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
      const prisma = fakePrisma();
      const result = await expandArchiveMedia(baseArgs(dir, prisma, file));
      assert.equal(result.ok, true);
      assert.equal(result.reason, 'code_archive');
      assert.equal(prisma.files.size, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cancellable, and a scheduler failure never undoes the child', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const controller = new AbortController();
      controller.abort();
      const aborted = await expandArchiveMedia(baseArgs(dir, fakePrisma(), file, { signal: controller.signal }));
      assert.equal(aborted.ok, false);
      assert.equal(aborted.reason, 'aborted');
      assert.equal(aborted.children.length, 0);

      const prisma = fakePrisma();
      const args = baseArgs(dir, prisma, file, { schedule: async () => { throw Object.assign(new Error('redis down'), { code: 'ECONNREFUSED' }); } });
      const result = await expandArchiveMedia(args);
      assert.equal(result.ok, true);
      assert.equal(result.children.length, 4);
      assert.ok(args.logger.lines.some((l) => /schedule failed for child .* \(ECONNREFUSED\)/.test(l)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const HAS_UNZIP = (() => { try { return spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0; } catch (_) { return false; } })();

  test('archives above the pizzip threshold stream through unzip -v / unzip -p', { skip: HAS_UNZIP ? false : 'unzip not installed' }, async () => {
    const dir = tmpDir();
    try {
      const { file, media } = await whatsappZip(dir);
      const prisma = fakePrisma();
      const result = await expandArchiveMedia(baseArgs(dir, prisma, file, { limits: { minImageBytes: 1, freeSpaceReserveBytes: 0, pizzipMaxBytes: 1 } }));
      assert.equal(result.ok, true);
      assert.equal(result.whatsapp, true);
      assert.deepEqual(result.children.map((c) => c.member), ['PTT-20261003-WA0012.opus', '00000013-AUDIO-2026-10-03-15-01-00.opus', 'VID-20261003-WA0004.mp4', 'IMG-20261003-WA0003.jpg']);
      for (const child of result.children) assert.deepEqual(fs.readFileSync(prisma.files.get(child.fileId).path), media[child.member]);
      assert.deepEqual(prisma.analyses.get(result.children[0].fileId).metadata.archiveParent.whatsapp, { at: '03/10/26, 15:00', sender: 'Ana Quispe' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without unzip, a large archive degrades with one warning', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const args = baseArgs(dir, fakePrisma(), file, { unzipBin: 'definitely-no-unzip-here', limits: { pizzipMaxBytes: 1, freeSpaceReserveBytes: 0 } });
      const result = await expandArchiveMedia(args);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'unzip_missing');
      assert.ok(args.logger.lines.some((l) => /unzip not available/.test(l)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pure helpers', () => {
  test('classifyMember', () => {
    assert.equal(classifyMember('PTT-20261003-WA0012.opus').kind, 'media');
    assert.equal(classifyMember('PRIVATE/AVCHD/BDMV/STREAM/00001.MTS').kind, 'media');
    assert.equal(classifyMember('src/util.mts').kind, null, 'TypeScript module');
    assert.equal(classifyMember('src/app.ts').kind, null);
    assert.equal(classifyMember('song.mid').kind, null);
    assert.equal(classifyMember('fotos/IMG_0001.HEIC').kind, 'image');
    assert.equal(classifyMember('logo.svg').kind, null, 'active content');
    assert.equal(classifyMember('WhatsApp Chat - Ana/_chat.txt').kind, 'chat');
    assert.equal(classifyMember('Chat de WhatsApp con Ana.txt').kind, 'chat');
    assert.equal(classifyMember('README').kind, null);
  });

  test('isArchiveCandidate, looksLikeCodeArchive, names', () => {
    assert.equal(isArchiveCandidate({ originalName: 'chat.ZIP', mimeType: 'application/octet-stream' }), true);
    assert.equal(isArchiveCandidate({ originalname: 'informe.docx', mimetype: 'application/zip' }), false);
    assert.equal(isArchiveCandidate({ originalName: 'sin-extension', mimeType: 'application/x-zip-compressed' }), true);
    assert.equal(looksLikeCodeArchive([{ name: 'a/.git/HEAD' }]), true);
    assert.equal(looksLikeCodeArchive([{ name: 'x/node_modules/a/package.json' }, { name: 'IMG-1.jpg' }]), false);
    assert.equal(childFilenameFor(PARENT, 3, 'a/PTT.opus', 'opus'), childFilenameFor(PARENT, 3, 'a/PTT.opus', 'opus'));
    assert.notEqual(childFilenameFor(PARENT, 3, 'a/PTT.opus', 'opus'), childFilenameFor(PARENT, 4, 'b/PTT.opus', 'opus'));
    assert.match(childFilenameFor('../../etc', 1, 'x', 'exe;rm'), /^archive-etc-0001-[0-9a-f]{10}$/);
    assert.equal(displayNameFor('carpeta/nota\u0001de "voz".opus', 0, 'opus'), 'nota_de _voz_.opus');
    assert.equal(displayNameFor('dir/', 2, 'jpg'), 'archivo-3.jpg');
  });

  test('parseWhatsAppAttachments reads Android and iOS exports', () => {
    const refs = parseWhatsAppAttachments([
      ANDROID_LINE,
      IOS_LINE,
      '10/3/26, 3:05 p. m. - Ana: VID-20261003-WA0004.mp4 (file attached)',
      'texto suelto IMG-20261003-WA0003.jpg sin cabecera',
    ].join('\r\n'), ['PTT-20261003-WA0012.opus', '00000013-AUDIO-2026-10-03-15-01-00.opus', 'VID-20261003-WA0004.mp4', 'IMG-20261003-WA0003.jpg']);
    assert.deepEqual(Object.fromEntries(refs), {
      'PTT-20261003-WA0012.opus': { at: '03/10/26, 15:00', sender: 'Ana Quispe' },
      '00000013-AUDIO-2026-10-03-15-01-00.opus': { at: '3/10/26, 15:01:12', sender: 'Luis' },
      'VID-20261003-WA0004.mp4': { at: '10/3/26, 3:05 p. m.', sender: 'Ana' },
    });
  });

  test('parseUnzipVerbose', () => {
    const out = [
      'Archive:  t.zip',
      ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name',
      '--------  ------  ------- ---- ---------- ----- --------  ----',
      '    5000  Defl:N       22 100% 2026-10-16 15:29 acc63e2e  ../evil.opus',
      '       4  Defl:N        6 -50% 2026-10-16 15:29 6fa0f988  WhatsApp Chat/_chat.txt',
      '       0  Stored        0   0% 2026-10-16 15:29 00000000  dir/',
      '--------          -------  ---                            -------',
      '    5004               28  99%                            3 files',
    ].join('\n');
    assert.deepEqual(parseUnzipVerbose(out).map((e) => [e.name, e.size, e.compressedSize, e.crc32, e.isDir]), [
      ['../evil.opus', 5000, 22, 0xacc63e2e, false],
      ['WhatsApp Chat/_chat.txt', 4, 6, 0x6fa0f988, false],
      ['dir/', 0, 0, 0, true],
    ]);
  });

  test('stampArchiveParent merges into the analysis and refuses another user\'s row', async () => {
    const prisma = fakePrisma();
    prisma.analyses.set('cimg', { userId: USER, fileId: 'cimg', status: 'ready', metadata: { summaryLang: 'es' } });
    assert.equal(await stampArchiveParent(prisma, { fileId: 'cimg', userId: USER, archiveParent: { fileId: PARENT } }), true);
    assert.deepEqual(prisma.analyses.get('cimg').metadata, { summaryLang: 'es', archiveParent: { fileId: PARENT } });
    assert.equal(prisma.analyses.get('cimg').status, 'ready', 'never downgrades a finished analysis');
    prisma.analyses.set('cother', { userId: 'someone_else', fileId: 'cother', metadata: {} });
    assert.equal(await stampArchiveParent(prisma, { fileId: 'cother', userId: USER, archiveParent: { fileId: PARENT } }), false);
    assert.equal(await stampArchiveParent(null, { fileId: 'x', userId: USER, archiveParent: {} }), false);
  });
});

test('routes/files.js expands archives after the analysis and before the R2 offload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'files.js'), 'utf8');
  const block = src.slice(src.indexOf('function schedulePostExtractEnrichment('), src.indexOf('async function expandArchiveMembers('));
  const analysis = block.indexOf('documentIntelligence.analyzeFile(');
  const stamp = block.indexOf('archiveMediaExpander.stampArchiveParent(prismaClient');
  const expand = block.indexOf('await expandArchiveMembers({ file, userId, prismaClient, fileRecord });');
  const offload = block.indexOf('await persistUploadBinary({ file, userId, thumbnailPath })');
  assert.ok(analysis > 0 && stamp > analysis && expand > stamp && offload > expand, 'analysis → re-stamp → expand → offload');
  assert.match(src, /schedule: \(child, row\) => scheduleFileAfterFastUpload\(child, userId, prismaClient, row\),/);
  assert.match(src, /userDir: upload\.resolveUserUploadDir\(userId\),/);
  assert.match(src, /if \(file\.archiveParent\) \{/);
});
