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
const chunkedUploads = require('../src/services/chunked-upload-store');

const {
  expandArchiveMedia, resumeArchiveExpansions, stampArchiveParent, isArchiveCandidate, classifyMember, looksLikeCodeArchive,
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
  // Only the JSON path filter the resume uses ({ path, equals }).
  const jsonPathMatches = (metadata, filter) => {
    if (!filter || !Array.isArray(filter.path)) return true;
    let value = metadata;
    for (const key of filter.path) value = value && typeof value === 'object' ? value[key] : undefined;
    return value === filter.equals;
  };
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
      // Like Prisma: with `select`, only the selected columns come back.
      async findFirst({ where, select }) {
        for (const row of files.values()) {
          if (!matches(row, where)) continue;
          if (!select) return row;
          return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k] === undefined ? null : row[k]]));
        }
        return null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of files.values()) if (matches(row, where)) { Object.assign(row, data); count += 1; }
        return { count };
      },
      async delete({ where: { id } }) {
        const row = files.get(id);
        files.delete(id);
        return row;
      },
    },
    documentAnalysis: {
      async findUnique({ where: { fileId } }) { return analyses.get(fileId) || null; },
      // A snapshot, like rows read from the database.
      async findMany({ where = {}, take } = {}) {
        const rows = [];
        for (const row of analyses.values()) {
          if (!jsonPathMatches(row.metadata, where.metadata)) continue;
          rows.push(structuredClone(row));
        }
        return typeof take === 'number' ? rows.slice(0, take) : rows;
      },
      // Atomic, like one UPDATE … WHERE: the resume's compare-and-set claim.
      async updateMany({ where = {}, data }) {
        let count = 0;
        for (const [fileId, row] of analyses) {
          if ((where.fileId !== undefined && row.fileId !== where.fileId) || (where.userId !== undefined && row.userId !== where.userId)) continue;
          if (!jsonPathMatches(row.metadata, where.metadata)) continue;
          analyses.set(fileId, { ...row, ...data });
          count += 1;
        }
        return { count };
      },
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
// Members are checked while still `<filename>.part`.
async function fakeDetect(filePath) {
  const ext = path.extname(String(filePath).replace(/\.part$/, '')).slice(1).toLowerCase();
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
      assert.equal(parentMeta.archiveExpansion.state, 'done');
      assert.equal(parentMeta.archiveExpansion.media, 3);
      assert.equal(parentMeta.archiveExpansion.images, 1);
      assert.equal(parentMeta.archiveExpansion.whatsapp, true);
      assert.deepEqual(parentMeta.archiveExpansion.children.map((c) => c.fileId), result.children.map((c) => c.fileId));

      // No partial files, no traversal, no names or contents in the log.
      const left = fs.readdirSync(resolvedDir).filter((n) => n !== '.parts');
      assert.equal(left.filter((n) => n.endsWith('.part')).length, 0);
      assert.equal(left.length, 4);
      assert.deepEqual(fs.readdirSync(path.join(resolvedDir, '.parts')), []);
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
      assert.deepEqual(fs.existsSync(userDir) ? fs.readdirSync(userDir).filter((n) => n !== '.parts') : [], []);
      assert.deepEqual(fs.existsSync(path.join(userDir, '.parts')) ? fs.readdirSync(path.join(userDir, '.parts')) : [], []);
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
      assert.equal(fs.readdirSync(path.join(dir, 'uploads', USER)).filter((n) => n !== '.parts').length, 2, 'the rejected member is removed');
      assert.deepEqual(fs.readdirSync(path.join(dir, 'uploads', USER, '.parts')), []);
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

describe('restarts: nothing orphaned, the expansion resumes', () => {
  // The real pizzip reader, except that member `at` (the first by default)
  // stalls half-written until released: the state of the disk at that moment
  // is what a deploy (the process killed) leaves behind.
  function stallMember(at = 1) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const started = new Promise((resolve) => { reached = resolve; });
    let calls = 0;
    const readerFactory = async (zipPath) => {
      const real = await expander.openPizzipReader(zipPath);
      return {
        ...real,
        async extract(entry, dest, opts) {
          calls += 1;
          if (calls !== at) return real.extract(entry, dest, opts);
          fs.writeFileSync(dest, Buffer.from('OggS half written'));
          reached(dest);
          await gate;
          throw Object.assign(new Error('killed'), { code: 'EPIPE' });
        },
      };
    };
    return { readerFactory, started, release };
  }

  test('a restart mid-member leaves only a partial in .parts, which the chunked-upload sweeper reclaims', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const prisma = fakePrisma();
      const stall = stallMember();
      const args = baseArgs(dir, prisma, file, { readerFactory: stall.readerFactory });
      const run = expandArchiveMedia(args);
      const partial = await stall.started;

      const userDir = path.resolve(args.userDir);
      assert.equal(path.dirname(partial), path.join(userDir, '.parts'));
      assert.match(path.basename(partial), new RegExp(`^archive-${PARENT}-\\d{4}-[0-9a-f]{10}\\.opus\\.part$`));
      assert.ok(!/^[a-f0-9]{32}\.part$/.test(path.basename(partial)), 'never a chunked-upload id');
      assert.deepEqual(fs.readdirSync(userDir), ['.parts'], 'nothing in the upload folder');
      assert.equal(prisma.analyses.get(PARENT).metadata.archiveExpansion.state, 'running', 'resumable marker');

      // The process is gone; the existing sweeper reclaims the partial.
      const swept = await chunkedUploads.sweepAllChunkedUploads(path.join(dir, 'uploads'), { maxAgeMs: 0, now: Date.now() + 1000 });
      assert.equal(swept.removed, 1);
      assert.equal(fs.existsSync(partial), false);

      stall.release();
      await run;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the File row is created before the member enters the upload folder', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const prisma = fakePrisma();
      const create = prisma.file.create;
      const seen = [];
      prisma.file.create = async (input) => {
        const { data } = input;
        seen.push({
          atTarget: fs.existsSync(data.path),
          atPartial: fs.existsSync(path.join(path.dirname(data.path), '.parts', `${data.filename}.part`)),
        });
        return create(input);
      };
      const result = await expandArchiveMedia(baseArgs(dir, prisma, file));
      assert.equal(result.children.length, 4);
      assert.deepEqual(seen, Array(4).fill({ atTarget: false, atPartial: true }));
      for (const child of result.children) assert.ok(fs.existsSync(prisma.files.get(child.fileId).path));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed rename removes the new row and the partial', async () => {
    const dir = tmpDir();
    try {
      const zip = new PizZip();
      zip.file('nota.opus', Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(5000)]));
      const file = path.join(dir, 'nota.zip');
      fs.writeFileSync(file, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
      const prisma = fakePrisma();
      const args = baseArgs(dir, prisma, file);
      // Something that is not ours already sits at the target name.
      const blocker = path.join(args.userDir, childFilenameFor(PARENT, 0, 'nota.opus', 'opus'));
      fs.mkdirSync(path.join(blocker, 'ocupado'), { recursive: true });
      const result = await expandArchiveMedia(args);
      assert.deepEqual(result.children, []);
      assert.deepEqual(result.skipped, { extract_failed: 1 });
      assert.deepEqual([...prisma.files.keys()], [PARENT], 'no row without its file');
      assert.deepEqual(fs.readdirSync(path.join(args.userDir, '.parts')), []);
      assert.ok(fs.existsSync(path.join(blocker, 'ocupado')), 'the blocker is left alone');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resumeArchiveExpansions finishes an interrupted expansion: reuses, repairs and creates', async () => {
    const dir = tmpDir();
    try {
      const { file, media } = await whatsappZip(dir);
      const prisma = fakePrisma();
      prisma.files.get(PARENT).path = file;
      const firstChildren = [];
      const first = await expandArchiveMedia(baseArgs(dir, prisma, file, { schedule: async (child) => { firstChildren.push(child); } }));
      assert.equal(firstChildren.length, 4);
      assert.ok(firstChildren.every((child) => !('repaired' in child)), 'a first run repairs nothing');
      const [lost, kept, gone1, gone2] = first.children.map((c) => prisma.files.get(c.fileId));
      // As a restart leaves it: a row whose rename never happened (the media
      // worker already failed it: no file), a finished member, two members
      // never reached, the marker still running.
      fs.rmSync(lost.path);
      Object.assign(lost, { processingStage: 'failed', processingError: 'El archivo no está en el disco.' });
      kept.processingStage = 'ready';
      for (const row of [gone1, gone2]) { fs.rmSync(row.path); prisma.files.delete(row.id); }
      prisma.analyses.set(PARENT, { userId: USER, fileId: PARENT, status: 'ready', metadata: { archiveExpansion: { state: 'running', at: new Date(0).toISOString() } } });

      const scheduled = [];
      const rowsScheduled = new Map();
      const childrenScheduled = new Map();
      const args = baseArgs(dir, prisma, file);
      const summary = await resumeArchiveExpansions({
        prisma, resolveUserDir: () => args.userDir, detectMime: fakeDetect, limits: args.limits, logger: silentLogger(),
        schedule: async (child, row) => { scheduled.push(row.id); rowsScheduled.set(row.id, { ...row }); childrenScheduled.set(row.id, { ...child }); },
      });
      assert.deepEqual(summary, { ok: true, found: 1, resumed: 1, retry: 0, abandoned: 0, skipped: 0, recent: 0 });

      const marker = prisma.analyses.get(PARENT).metadata.archiveExpansion;
      assert.equal(marker.state, 'done');
      assert.equal(marker.attempt, 1);
      assert.equal(marker.media, 3);
      assert.equal(marker.images, 1);
      const byMember = new Map([...prisma.files.values()].filter((r) => r.id !== PARENT).map((r) => [r.originalName, r]));
      assert.equal(byMember.size, 4, 'no duplicate rows');
      assert.equal(byMember.get(lost.originalName).id, lost.id, 'the empty row is filled in place');
      assert.equal(byMember.get(kept.originalName).id, kept.id);
      for (const row of byMember.values()) assert.deepEqual(fs.readFileSync(row.path), media[row.originalName]);
      assert.ok(scheduled.includes(lost.id));
      assert.ok(!scheduled.includes(kept.id), 'a finished member is not queued twice');
      assert.equal(scheduled.length, 3);
      // The repaired row reaches schedule(file, row) like a created one: the
      // caller's wiring uses row.userId (scheduleFileAfterFastUpload).
      const repairedRow = rowsScheduled.get(lost.id);
      assert.equal(repairedRow.userId, USER);
      assert.equal(repairedRow.filename, lost.filename);
      assert.equal(repairedRow.originalName, 'PTT-20261003-WA0012.opus');
      assert.equal(repairedRow.mimeType, 'audio/ogg');
      assert.equal(repairedRow.processingStage, 'uploaded');
      for (const row of rowsScheduled.values()) assert.equal(row.userId, USER);
      // Only the repaired child says so: the media queue may still keep the
      // failed job of the hours its file was missing (files.js retries it).
      assert.equal(childrenScheduled.get(lost.id).repaired, true);
      for (const [id, child] of childrenScheduled) if (id !== lost.id) assert.ok(!('repaired' in child), 'a created child is not repaired');
      // …and starts over: a failed stage would keep the media queue away.
      assert.equal(prisma.files.get(lost.id).processingStage, 'uploaded');
      assert.equal(prisma.files.get(lost.id).processingError, null);
      assert.equal(prisma.files.get(kept.id).processingStage, 'ready', 'a reused row is left alone');

      // Nothing left to resume.
      const again = await resumeArchiveExpansions({ prisma, resolveUserDir: () => args.userDir, minAgeMs: 0, logger: silentLogger() });
      assert.equal(again.found, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('on a tight disk, a resume charges only what is not on disk yet', async () => {
    const dir = tmpDir();
    const statfs = fs.promises.statfs;
    try {
      const zip = new PizZip();
      const media = {};
      for (let i = 0; i < 4; i += 1) {
        media[`PTT-${i}.opus`] = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(20_000)]);
        zip.file(`PTT-${i}.opus`, media[`PTT-${i}.opus`]);
      }
      const file = path.join(dir, 'chat.zip');
      fs.writeFileSync(file, zip.generate({ type: 'nodebuffer', compression: 'STORE' }));
      const prisma = fakePrisma();
      prisma.files.get(PARENT).path = file;
      const args = baseArgs(dir, prisma, file, { limits: { minImageBytes: 1, freeSpaceReserveBytes: MB } });
      const total = Object.values(media).reduce((sum, b) => sum + b.length, 0);
      // A volume that holds exactly the reserve plus this archive's members:
      // what the user folder (and its partials) already use is gone.
      const used = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true })
        .reduce((sum, e) => sum + (e.isDirectory() ? used(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0) : 0);
      fs.promises.statfs = async () => ({ bavail: MB + total - used(args.userDir), bsize: 1 });

      const first = await expandArchiveMedia(args);
      assert.equal(first.children.length, 4, 'the whole archive fits at upload time');
      // A restart after two members, the third half-inflated in .parts.
      const [, , third, fourth] = first.children.map((c) => prisma.files.get(c.fileId));
      for (const row of [third, fourth]) { fs.rmSync(row.path); prisma.files.delete(row.id); }
      fs.writeFileSync(path.join(args.userDir, '.parts', `${third.filename}.part`), media[third.originalName].subarray(0, 9_000));
      prisma.analyses.set(PARENT, { userId: USER, fileId: PARENT, status: 'ready', metadata: { archiveExpansion: { state: 'running', at: new Date(0).toISOString() } } });

      const summary = await resumeArchiveExpansions({ prisma, resolveUserDir: () => args.userDir, detectMime: fakeDetect, limits: args.limits, minAgeMs: 0, logger: silentLogger() });
      assert.equal(summary.resumed, 1);
      const marker = prisma.analyses.get(PARENT).metadata.archiveExpansion;
      assert.equal(marker.state, 'done');
      assert.equal(marker.media, 4, 'the missing members still fit');
      assert.deepEqual(marker.skipped, {});
      assert.equal(marker.truncated, false);
      for (const row of [...prisma.files.values()].filter((r) => r.id !== PARENT)) {
        assert.deepEqual(fs.readFileSync(row.path), media[row.originalName]);
      }
    } finally {
      fs.promises.statfs = statfs;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('on a tight disk, members already done cost nothing, even when their file went to R2', async () => {
    const dir = tmpDir();
    const statfs = fs.promises.statfs;
    try {
      const zip = new PizZip();
      const media = {};
      for (let i = 0; i < 4; i += 1) {
        media[`PTT-${i}.opus`] = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(20_000)]);
        zip.file(`PTT-${i}.opus`, media[`PTT-${i}.opus`]);
      }
      const file = path.join(dir, 'chat.zip');
      fs.writeFileSync(file, zip.generate({ type: 'nodebuffer', compression: 'STORE' }));
      const prisma = fakePrisma();
      prisma.files.get(PARENT).path = file;
      const args = baseArgs(dir, prisma, file, { limits: { minImageBytes: 1, freeSpaceReserveBytes: MB } });
      const first = await expandArchiveMedia(args);
      assert.equal(first.children.length, 4);
      // Two members finished and were offloaded (row → r2 ref, local file
      // gone); a restart before the other two were reached.
      const rows = first.children.map((c) => prisma.files.get(c.fileId));
      for (const row of rows.slice(0, 2)) { fs.rmSync(row.path); row.path = `r2://uploads/${USER}/${row.filename}`; }
      for (const row of rows.slice(2)) { fs.rmSync(row.path); prisma.files.delete(row.id); }
      prisma.analyses.set(PARENT, { userId: USER, fileId: PARENT, status: 'ready', metadata: { archiveExpansion: { state: 'running', at: new Date(0).toISOString() } } });
      // The volume holds the reserve plus exactly the two missing members.
      const missing = rows.slice(2).reduce((sum, row) => sum + media[row.originalName].length, 0);
      fs.promises.statfs = async () => ({ bavail: MB + missing, bsize: 1 });

      const summary = await resumeArchiveExpansions({ prisma, resolveUserDir: () => args.userDir, detectMime: fakeDetect, limits: args.limits, minAgeMs: 0, logger: silentLogger() });
      assert.equal(summary.resumed, 1);
      const marker = prisma.analyses.get(PARENT).metadata.archiveExpansion;
      assert.equal(marker.state, 'done');
      assert.deepEqual(marker.skipped, {}, 'nothing dropped as disk_space');
      assert.equal(marker.media, 4);
      assert.equal(marker.truncated, false);
      for (const row of rows.slice(0, 2)) assert.match(prisma.files.get(row.id).path, /^r2:\/\//, 'offloaded rows are left alone');
      const local = [...prisma.files.values()].filter((r) => r.id !== PARENT && !String(r.path).startsWith('r2://'));
      assert.equal(local.length, 2);
      for (const row of local) assert.deepEqual(fs.readFileSync(row.path), media[row.originalName]);
    } finally {
      fs.promises.statfs = statfs;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a resume never brings back a child the user deleted', async () => {
    const dir = tmpDir();
    const stall = stallMember(3);
    const controller = new AbortController();
    let run = null;
    try {
      const { file, media } = await whatsappZip(dir);
      const prisma = fakePrisma();
      prisma.files.get(PARENT).path = file;
      const args = baseArgs(dir, prisma, file, { readerFactory: stall.readerFactory, signal: controller.signal });
      run = expandArchiveMedia(args);
      await stall.started;

      // Two children exist; the running marker already lists their members.
      const made = [...prisma.files.values()].filter((r) => r.id !== PARENT);
      assert.equal(made.length, 2);
      const marker = prisma.analyses.get(PARENT).metadata.archiveExpansion;
      assert.equal(marker.state, 'running');
      assert.deepEqual(marker.processed, made.map((r) => prisma.analyses.get(r.id).metadata.archiveParent.index).sort((a, b) => a - b));

      // The user deletes one (row and binary, like DELETE /api/files/:id),
      // then a shutdown stops the run: it stays resumable.
      const deleted = made[1];
      prisma.files.delete(deleted.id);
      fs.rmSync(deleted.path);
      controller.abort();
      stall.release();
      assert.equal((await run).reason, 'aborted');
      const stopped = prisma.analyses.get(PARENT).metadata.archiveExpansion;
      assert.equal(stopped.state, 'running');
      assert.deepEqual(stopped.processed, marker.processed);

      const scheduled = [];
      const summary = await resumeArchiveExpansions({
        prisma, resolveUserDir: () => args.userDir, detectMime: fakeDetect, limits: args.limits, minAgeMs: 0, logger: silentLogger(),
        schedule: async (child, row) => scheduled.push(row.originalName),
      });
      assert.equal(summary.resumed, 1);
      const after = prisma.analyses.get(PARENT).metadata.archiveExpansion;
      assert.equal(after.state, 'done');
      assert.deepEqual(after.skipped, { unsafe_path: 1, deleted_by_user: 1 }, '`../evil.opus` is refused on every pass');
      const rows = [...prisma.files.values()].filter((r) => r.id !== PARENT);
      assert.equal(rows.length, 3);
      assert.ok(!rows.some((r) => r.originalName === deleted.originalName), 'the deleted child does not come back');
      assert.equal(fs.existsSync(deleted.path), false);
      assert.deepEqual(scheduled.sort(), rows.filter((r) => r.id !== made[0].id).map((r) => r.originalName).sort(), 'only the members never reached are queued');
      for (const row of rows) assert.deepEqual(fs.readFileSync(row.path), media[row.originalName]);
    } finally {
      // A failed assertion must not leave the run holding the parent.
      controller.abort();
      stall.release();
      if (run) await run;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a database that does not answer during a resume leaves it running: never abandoned, no second row, no deleted child back', async () => {
    const poolTimeout = () => Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' });
    // As a restart leaves it: every child made, then `drop` removed (never
    // reached, or deleted by the user), the marker running with `processed`.
    const interrupted = async (dir, { drop, processed }) => {
      const { file, media } = await whatsappZip(dir);
      const prisma = fakePrisma();
      prisma.files.get(PARENT).path = file;
      const args = baseArgs(dir, prisma, file);
      const rows = (await expandArchiveMedia(args)).children.map((c) => prisma.files.get(c.fileId));
      for (const i of drop) { fs.rmSync(rows[i].path); prisma.files.delete(rows[i].id); }
      const index = (i) => prisma.analyses.get(rows[i].id).metadata.archiveParent.index;
      prisma.analyses.set(PARENT, {
        userId: USER, fileId: PARENT, status: 'ready',
        metadata: { archiveExpansion: { state: 'running', at: new Date(0).toISOString(), processed: processed.map(index) } },
      });
      return { prisma, args, rows, media };
    };
    const resume = (prisma, args, scheduled) => resumeArchiveExpansions({
      prisma, resolveUserDir: () => args.userDir, detectMime: fakeDetect, limits: args.limits, minAgeMs: 0, logger: silentLogger(),
      schedule: async (child, row) => { scheduled.push(row.originalName); },
    });
    const children = (prisma) => [...prisma.files.values()].filter((r) => r.id !== PARENT);
    const retried = { ok: true, found: 1, resumed: 0, retry: 1, abandoned: 0, skipped: 0, recent: 0 };
    const finished = { ok: true, found: 1, resumed: 1, retry: 0, abandoned: 0, skipped: 0, recent: 0 };

    // 1. The parent's own lookup times out: not «parent gone».
    {
      const dir = tmpDir();
      try {
        const { prisma, args, rows, media } = await interrupted(dir, { drop: [2, 3], processed: [0, 1] });
        const findFirst = prisma.file.findFirst;
        let failed = 0;
        prisma.file.findFirst = async (q) => {
          if (q.where.id === PARENT && failed === 0) { failed += 1; throw poolTimeout(); }
          return findFirst(q);
        };
        const scheduled = [];
        assert.deepEqual(await resume(prisma, args, scheduled), retried);
        const marker = prisma.analyses.get(PARENT).metadata.archiveExpansion;
        assert.deepEqual([marker.state, marker.attempt, marker.reason], ['running', 1, undefined], 'still resumable, one attempt spent');
        assert.equal(children(prisma).length, 2);
        assert.deepEqual(await resume(prisma, args, scheduled), finished);
        assert.equal(prisma.analyses.get(PARENT).metadata.archiveExpansion.state, 'done');
        assert.equal(children(prisma).length, 4);
        assert.deepEqual(scheduled.sort(), [rows[2].originalName, rows[3].originalName].sort());
        for (const row of children(prisma)) assert.deepEqual(fs.readFileSync(row.path), media[row.originalName]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    // 2. A member's lookup times out, in the disk budget or in the loop:
    // its row exists (not yet in `processed`), so nothing may be created
    // for it. Members before it go on; the rest wait for a later pass.
    for (const failOnCall of [1, 2]) {
      const dir = tmpDir();
      try {
        const { prisma, args, rows, media } = await interrupted(dir, { drop: [0, 3], processed: [1] });
        const findFirst = prisma.file.findFirst;
        let calls = 0;
        prisma.file.findFirst = async (q) => {
          if (q.where.filename === rows[2].filename && ++calls === failOnCall) throw poolTimeout();
          return findFirst(q);
        };
        const scheduled = [];
        assert.deepEqual(await resume(prisma, args, scheduled), retried, `lookup ${failOnCall}`);
        const marker = prisma.analyses.get(PARENT).metadata.archiveExpansion;
        assert.equal(marker.state, 'running');
        assert.equal(children(prisma).filter((r) => r.filename === rows[2].filename).length, 1, 'no second row for it');
        assert.deepEqual(await resume(prisma, args, scheduled), finished);
        const made = children(prisma);
        assert.equal(made.length, 4);
        assert.equal(new Set(made.map((r) => r.filename)).size, 4, 'no duplicate rows');
        assert.equal(made.find((r) => r.filename === rows[2].filename).id, rows[2].id);
        assert.deepEqual(scheduled.sort(), [rows[0].originalName, rows[3].originalName].sort(), 'each missing member queued once');
        for (const row of made) assert.deepEqual(fs.readFileSync(row.path), media[row.originalName]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    // 3. The marker cannot be read back after the claim: without its
    // `processed`, the child the user deleted would come back.
    {
      const dir = tmpDir();
      try {
        const { prisma, args, rows } = await interrupted(dir, { drop: [1, 3], processed: [0, 1, 2] });
        const findUnique = prisma.documentAnalysis.findUnique;
        let failed = 0;
        prisma.documentAnalysis.findUnique = async (q) => {
          // readExpansionMarker selects the metadata alone.
          if (q.where.fileId === PARENT && q.select && !q.select.userId && failed === 0) { failed += 1; throw poolTimeout(); }
          return findUnique(q);
        };
        const scheduled = [];
        assert.deepEqual(await resume(prisma, args, scheduled), retried);
        assert.equal(prisma.analyses.get(PARENT).metadata.archiveExpansion.state, 'running');
        assert.equal(children(prisma).length, 2);
        assert.deepEqual(await resume(prisma, args, scheduled), finished);
        const marker = prisma.analyses.get(PARENT).metadata.archiveExpansion;
        assert.equal(marker.state, 'done');
        assert.equal(marker.skipped.deleted_by_user, 1);
        assert.ok(!children(prisma).some((r) => r.filename === rows[1].filename), 'the deleted child does not come back');
        assert.deepEqual(scheduled, [rows[3].originalName]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('resume skips recent and live runs, gives up on lost archives and after maxAttempts', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const userDir = path.join(dir, 'uploads', USER);
      const running = (extra = {}) => ({ userId: USER, fileId: PARENT, status: 'ready', metadata: { archiveExpansion: { state: 'running', ...extra } } });
      const resume = (prisma, over = {}) => resumeArchiveExpansions({ prisma, resolveUserDir: () => userDir, detectMime: fakeDetect, limits: { minImageBytes: 1, freeSpaceReserveBytes: 0 }, logger: silentLogger(), ...over });

      // Recent: may belong to a live run in another process.
      const recent = fakePrisma();
      recent.files.get(PARENT).path = file;
      recent.analyses.set(PARENT, running({ at: new Date().toISOString() }));
      const recentSummary = await resume(recent);
      assert.deepEqual([recentSummary.skipped, recentSummary.recent], [1, 1]);
      assert.equal(recent.files.size, 1);

      // No start time: not a marker this module writes, never a live run.
      const noAt = fakePrisma();
      noAt.files.get(PARENT).path = file;
      noAt.analyses.set(PARENT, running());
      assert.equal((await resume(noAt)).abandoned, 1);
      assert.equal(noAt.analyses.get(PARENT).metadata.archiveExpansion.reason, 'invalid_marker');
      assert.equal(noAt.files.size, 1);

      // Archive gone (offloaded or deleted from disk): abandoned, not retried forever.
      const lostZip = fakePrisma();
      lostZip.files.get(PARENT).path = path.join(dir, 'no-existe.zip');
      lostZip.analyses.set(PARENT, running({ at: new Date(0).toISOString() }));
      assert.equal((await resume(lostZip, { minAgeMs: 0 })).abandoned, 1);
      assert.deepEqual([lostZip.analyses.get(PARENT).metadata.archiveExpansion.state, lostZip.analyses.get(PARENT).metadata.archiveExpansion.reason], ['abandoned', 'archive_missing']);

      // A run that keeps killing the process: counted before each attempt.
      const looping = fakePrisma();
      looping.files.get(PARENT).path = file;
      looping.analyses.set(PARENT, running({ at: new Date(0).toISOString(), attempt: 3 }));
      assert.equal((await resume(looping, { minAgeMs: 0 })).abandoned, 1);
      assert.equal(looping.analyses.get(PARENT).metadata.archiveExpansion.reason, 'max_attempts');
      assert.equal(looping.files.size, 1);

      // A live run in this process is never raced.
      const live = fakePrisma();
      live.files.get(PARENT).path = file;
      const stall = stallMember();
      const run = expandArchiveMedia(baseArgs(dir, live, file, { readerFactory: stall.readerFactory }));
      await stall.started;
      assert.equal(live.analyses.get(PARENT).metadata.archiveExpansion.state, 'running');
      assert.equal((await resume(live, { minAgeMs: 0 })).skipped, 1);
      assert.equal((await expandArchiveMedia(baseArgs(dir, live, file))).reason, 'already_running');
      stall.release();
      const finished = await run;
      assert.equal(finished.ok, true);
      assert.equal(live.analyses.get(PARENT).metadata.archiveExpansion.state, 'done');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test('two processes resuming the same parent at once: one claims it, nothing is made or queued twice', async () => {
    const dir = tmpDir();
    // A second copy of the module stands for another process: its own
    // in-process guard, the same database.
    const key = require.resolve('../src/services/archive-media-expander');
    const original = require.cache[key];
    delete require.cache[key];
    const other = require(key);
    require.cache[key] = original;
    try {
      assert.notEqual(other.resumeArchiveExpansions, resumeArchiveExpansions);
      const { file, media } = await whatsappZip(dir);
      const prisma = fakePrisma();
      prisma.files.get(PARENT).path = file;
      prisma.analyses.set(PARENT, { userId: USER, fileId: PARENT, status: 'ready', metadata: { archiveExpansion: { state: 'running', at: new Date(0).toISOString() } } });
      // Both read the marker before either acts, like passes that fire together.
      const findMany = prisma.documentAnalysis.findMany;
      let arrived = 0;
      let open;
      const gate = new Promise((resolve) => { open = resolve; });
      prisma.documentAnalysis.findMany = async (args) => {
        const rows = await findMany(args);
        arrived += 1;
        if (arrived === 2) open();
        await gate;
        return rows;
      };
      // Database calls and inflating take a moment, as they do for real.
      for (const [model, method] of [['file', 'create'], ['file', 'findFirst'], ['file', 'delete'], ['documentAnalysis', 'findUnique'], ['documentAnalysis', 'upsert'], ['documentAnalysis', 'updateMany']]) {
        const real = prisma[model][method];
        prisma[model][method] = async (args) => { await new Promise((r) => setTimeout(r, 2)); return real(args); };
      }
      const userDir = path.join(dir, 'uploads', USER);
      const scheduled = [];
      const slowReader = (mod) => async (zipPath) => {
        const real = await mod.openPizzipReader(zipPath);
        return { ...real, async extract(entry, dest, opts) { await new Promise((r) => setTimeout(r, 5)); return real.extract(entry, dest, opts); } };
      };
      const options = (mod) => ({
        prisma, resolveUserDir: () => userDir, detectMime: fakeDetect, env: {}, logger: silentLogger(),
        limits: { minImageBytes: 1, freeSpaceReserveBytes: 0 }, readerFactory: slowReader(mod),
        schedule: async (child, row) => scheduled.push(row.id),
      });
      const [a, b] = await Promise.all([
        resumeArchiveExpansions(options(expander)),
        other.resumeArchiveExpansions(options(other)),
      ]);
      assert.deepEqual([a.resumed + b.resumed, a.skipped + b.skipped], [1, 1], 'one runs it, the other finds it claimed');
      assert.equal(a.recent + b.recent, 0);
      const marker = prisma.analyses.get(PARENT).metadata.archiveExpansion;
      assert.equal(marker.state, 'done');
      assert.equal(marker.attempt, 1, 'one attempt, not two');
      const rows = [...prisma.files.values()].filter((r) => r.id !== PARENT);
      assert.equal(rows.length, 4, 'one row per member');
      assert.equal(new Set(rows.map((r) => r.filename)).size, 4);
      assert.equal(scheduled.length, 4, 'each member queued once');
      assert.deepEqual([...scheduled].sort(), rows.map((r) => r.id).sort());
      for (const row of rows) assert.deepEqual(fs.readFileSync(row.path), media[row.originalName]);
      assert.deepEqual(fs.readdirSync(path.join(userDir, '.parts')), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the pass after boot (startArchiveExpansionResume)', () => {
  const { startArchiveExpansionResume, isResumeEnabled } = expander;

  // Captures the timer instead of waiting for it.
  function fakeTimers() {
    const timers = [];
    const setTimer = (fn, ms) => {
      const t = { fn, ms, unrefed: false, unref() { this.unrefed = true; return this; } };
      timers.push(t);
      return t;
    };
    return { timers, setTimer };
  }

  test('SIRAGPT_ARCHIVE_MEDIA_RESUME: on by default, off under NODE_ENV=test unless 1, off with the expansion', () => {
    assert.equal(isResumeEnabled({}), true);
    assert.equal(isResumeEnabled({ NODE_ENV: 'production' }), true);
    assert.equal(isResumeEnabled({ NODE_ENV: 'test' }), false);
    assert.equal(isResumeEnabled({ NODE_ENV: 'test', SIRAGPT_ARCHIVE_MEDIA_RESUME: '1' }), true);
    assert.equal(isResumeEnabled({ SIRAGPT_ARCHIVE_MEDIA_RESUME: '0' }), false);
    assert.equal(isResumeEnabled({ SIRAGPT_ARCHIVE_MEDIA_RESUME: 'off' }), false);
    assert.equal(isResumeEnabled({ SIRAGPT_ARCHIVE_MEDIA: '0', SIRAGPT_ARCHIVE_MEDIA_RESUME: '1' }), false);
    const { timers, setTimer } = fakeTimers();
    assert.equal(startArchiveExpansionResume({ env: { NODE_ENV: 'test' }, setTimer, prisma: fakePrisma() }), null);
    assert.equal(startArchiveExpansionResume({ env: { SIRAGPT_ARCHIVE_MEDIA_RESUME: '0' }, setTimer, prisma: fakePrisma() }), null);
    assert.equal(timers.length, 0, 'switched off: no timer at all');
  });

  test('a pass a little after boot, and one more that finishes the ZIP this restart interrupted, with the default minAgeMs', async () => {
    const dir = tmpDir();
    try {
      const { file } = await whatsappZip(dir);
      const prisma = fakePrisma();
      prisma.files.get(PARENT).path = file;
      const PARENT2 = 'cparent0000000000000000002';
      prisma.files.set(PARENT2, { ...prisma.files.get(PARENT), id: PARENT2 });
      const userDir = path.join(dir, 'uploads', USER);
      let clock = Date.parse('2026-10-17T12:00:00.000Z');
      const bootAt = clock;
      const running = (fileId, at) => ({ userId: USER, fileId, status: 'ready', metadata: { archiveExpansion: { state: 'running', at: new Date(at).toISOString() } } });
      // Left by an earlier restart; started 4 min before this boot and cut
      // by it (a deploy); one a live run of another process started since.
      prisma.analyses.set(PARENT, running(PARENT, 0));
      prisma.analyses.set(PARENT2, running(PARENT2, bootAt - 4 * 60_000));
      prisma.analyses.set('clive', running('clive', bootAt + 60_000));
      const { timers, setTimer } = fakeTimers();
      const logger = silentLogger();
      const scheduled = [];
      const timer = startArchiveExpansionResume({
        env: {}, setTimer, logger, now: () => clock, prisma, resolveUserDir: () => userDir, detectMime: fakeDetect,
        limits: { minImageBytes: 1, freeSpaceReserveBytes: 0 },
        schedule: async (child, row) => scheduled.push([child.archiveParent.fileId, row.userId]),
      });
      assert.equal(timer, timers[0]);
      assert.equal(timers.length, 1);
      assert.equal(timers[0].unrefed, true, 'never keeps the process alive');
      assert.ok(timers[0].ms >= 30_000 && timers[0].ms <= 5 * 60_000, 'a little after boot');
      assert.equal(prisma.files.size, 2, 'nothing runs before the timer');
      const stateOf = (id) => prisma.analyses.get(id).metadata.archiveExpansion.state;
      const summaries = () => logger.lines.filter((l) => /resume found=/.test(l));
      const settle = async (done) => { for (let i = 0; i < 100 && !done(); i += 1) await new Promise((r) => setTimeout(r, 20)); };

      clock = bootAt + timers[0].ms;
      await timers[0].fn();
      await settle(() => timers.length === 2);
      assert.equal(stateOf(PARENT), 'done', 'an earlier leftover is finished at once');
      assert.equal(stateOf(PARENT2), 'running', 'too recent for the first pass');
      assert.equal(stateOf('clive'), 'running');
      assert.deepEqual(summaries(), ['[archive-media] resume found=3 resumed=1 retry=0 abandoned=0 skipped=2 recent=2']);

      // Exactly one more pass, unref'd, once every pre-boot run is past the
      // default minimum age (timeout 10 min + 5 min).
      assert.equal(timers.length, 2);
      assert.equal(timers[1].unrefed, true);
      const minAge = 15 * 60_000;
      assert.equal(clock + timers[1].ms, bootAt + minAge + 30_000);
      clock += timers[1].ms;
      await timers[1].fn();
      await settle(() => summaries().length === 2);
      assert.equal(stateOf(PARENT2), 'done', 'the ZIP this restart interrupted is finished');
      assert.equal(stateOf('clive'), 'running', 'default minAgeMs: a live run of another process is left alone');
      assert.deepEqual(summaries()[1], '[archive-media] resume found=2 resumed=1 retry=0 abandoned=0 skipped=1 recent=1');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(timers.length, 2, 'no third pass');
      assert.equal(summaries().length, 2, 'one summary line per pass, counts only');
      assert.deepEqual(scheduled.map(([parentId]) => parentId), [PARENT, PARENT, PARENT, PARENT, PARENT2, PARENT2, PARENT2, PARENT2]);
      assert.ok(scheduled.every(([, userId]) => userId === USER));
      assert.ok(!logger.lines.some((l) => /PTT-|Ana|WhatsApp|\.opus|\.zip/.test(l)), 'no file names in the log');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never throws: nothing to resume, a failing query or a broken database still log one line', async () => {
    const quiet = fakePrisma();
    const broken = fakePrisma();
    broken.documentAnalysis.findMany = async () => { throw new Error('connection refused'); };
    const exploding = { get documentAnalysis() { throw new Error('boom'); } };
    for (const [prisma, expected] of [
      [quiet, /^\[archive-media\] resume found=0 resumed=0 retry=0 abandoned=0 skipped=0 recent=0$/],
      [broken, /^\[archive-media\] resume found=0 .* reason=query_failed$/],
      [exploding, /^\[archive-media\] resume found=0 .* reason=internal_error$/],
    ]) {
      const { timers, setTimer } = fakeTimers();
      const logger = silentLogger();
      assert.doesNotThrow(() => startArchiveExpansionResume({ env: {}, setTimer, logger, prisma, resolveUserDir: () => '/nonexistent' }));
      await assert.doesNotReject(async () => timers[0].fn());
      for (let i = 0; i < 50 && logger.lines.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal(logger.lines.length, 1);
      assert.match(logger.lines[0], expected);
    }
    // A timer that cannot be set is not an error either.
    assert.equal(startArchiveExpansionResume({ env: {}, setTimer: () => { throw new Error('no timers'); }, prisma: quiet }), null);
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

test('routes/files.js starts the boot resume once, next to the sweeper, with the upload wiring and the default minAgeMs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'files.js'), 'utf8');
  const calls = src.split('archiveMediaExpander.startArchiveExpansionResume(').length - 1;
  assert.equal(calls, 1, 'one pass per process');
  assert.equal((src.match(/resumeArchiveExpansions\(/g) || []).length, 0, 'only through the unref\'d, gated helper');
  const at = src.indexOf('archiveMediaExpander.startArchiveExpansionResume(');
  assert.ok(at > src.indexOf('chunkedUploads.startChunkedUploadSweeper('), 'module level, after the sweeper');
  assert.ok(src.lastIndexOf('router.', at) < src.indexOf('chunkedUploads.startChunkedUploadSweeper('), 'not inside a route handler');
  const call = src.slice(at, src.indexOf('});', at) + 3);
  assert.match(call, /^archiveMediaExpander\.startArchiveExpansionResume\(\{\n  prisma,\n/m);
  assert.match(call, /resolveUserDir: \(userId\) => upload\.resolveUserUploadDir\(userId\),/);
  assert.match(call, /detectMime: \(childPath, fallbackMime\) => detectMime\(childPath, fallbackMime\),/);
  assert.match(call, /schedule: \(child, row\) => scheduleResumedArchiveChild\(child, row\),/);
  assert.doesNotMatch(call, /minAgeMs/, 'the default keeps a live run of another process safe');
});

test('routes/files.js: the boot resume queues a repaired media child as a retry, everything else like an upload', async () => {
  // The real module, its boot call captured: the queue keeps the failed job
  // the media reconciler made while the child's file was missing, and only
  // a retry queues that row again.
  const filesKey = require.resolve('../src/routes/files');
  const uploadKey = require.resolve('../src/middleware/upload');
  const mediaQueue = require('../src/services/media-transcription-queue');
  const saved = { start: expander.startArchiveExpansionResume, enqueue: mediaQueue.enqueueMediaTranscription, env: { ...process.env } };
  const dir = tmpDir();
  const calls = [];
  let options = null;
  try {
    process.env.NODE_ENV = 'test'; // no sweeper
    process.env.UPLOAD_DIR = dir;
    expander.startArchiveExpansionResume = (opts) => { options = opts; return null; };
    mediaQueue.enqueueMediaTranscription = async (args) => { calls.push(args); return { queued: true }; };
    delete require.cache[filesKey];
    delete require.cache[uploadKey];
    require(filesKey);
    assert.equal(typeof (options && options.schedule), 'function');
    const child = { path: path.join(dir, 'x.opus'), filename: 'archive-x.opus', originalname: 'PTT-0.opus', mimetype: 'audio/ogg', size: 10, fieldname: 'files', archiveParent: {} };
    const row = { id: 'cchild0001', userId: USER, filename: 'archive-x.opus', originalName: 'PTT-0.opus', mimeType: 'audio/ogg', processingStage: 'uploaded' };
    options.schedule({ ...child, repaired: true }, row);
    options.schedule(child, { ...row, id: 'cchild0002' });
    assert.deepEqual(calls, [
      { fileId: 'cchild0001', userId: USER, retry: true },
      { fileId: 'cchild0002', userId: USER },
    ]);
  } finally {
    expander.startArchiveExpansionResume = saved.start;
    mediaQueue.enqueueMediaTranscription = saved.enqueue;
    for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
    delete require.cache[filesKey];
    delete require.cache[uploadKey];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
