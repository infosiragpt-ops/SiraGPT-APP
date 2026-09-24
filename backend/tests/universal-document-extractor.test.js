'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const extractor = require('../src/services/universal-document-extractor');
const fileProcessor = require('../src/services/fileProcessor');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'universal-extract-test-'));
}

function hasBinary(bin, args = ['--help']) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    return true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

// ── Minimal OLE2 writer (512-byte sectors, every stream in the mini stream) ──
function buildCompoundFile(tree) {
  // tree: { streams: {name: Buffer}, storages: {name: {streams}} }
  const SECT = 512;
  const MINI = 64;
  const entries = [{ name: 'Root Entry', type: 5, children: [] }];
  const addChildren = (parentIndex, node) => {
    for (const [name, data] of Object.entries(node.streams || {})) {
      entries.push({ name, type: 2, data });
      entries[parentIndex].children.push(entries.length - 1);
    }
    for (const [name, sub] of Object.entries(node.storages || {})) {
      entries.push({ name, type: 1, children: [] });
      const idx = entries.length - 1;
      entries[parentIndex].children.push(idx);
      addChildren(idx, sub);
    }
  };
  addChildren(0, tree);

  // Mini stream: concatenate stream data in 64-byte mini sectors.
  const miniFat = [];
  const miniChunks = [];
  for (const e of entries) {
    if (e.type !== 2) continue;
    const n = Math.max(1, Math.ceil(e.data.length / MINI));
    e.start = miniFat.length;
    for (let i = 0; i < n; i += 1) miniFat.push(i === n - 1 ? 0xfffffffe : e.start + i + 1);
    const padded = Buffer.alloc(n * MINI);
    e.data.copy(padded);
    miniChunks.push(padded);
  }
  const miniStream = Buffer.concat(miniChunks);

  const dirSectors = Math.ceil((entries.length * 128) / SECT);
  const miniFatSectors = Math.max(1, Math.ceil((miniFat.length * 4) / SECT));
  const miniStreamSectors = Math.max(1, Math.ceil(miniStream.length / SECT));
  // Layout: [0]=FAT, then directory, then miniFAT, then mini stream.
  const dirStart = 1;
  const miniFatStart = dirStart + dirSectors;
  const miniStreamStart = miniFatStart + miniFatSectors;
  const total = miniStreamStart + miniStreamSectors;
  const fat = new Array(SECT / 4).fill(0xffffffff);
  fat[0] = 0xfffffffd; // FAT sector itself
  const chainRun = (start, count) => {
    for (let i = 0; i < count; i += 1) fat[start + i] = i === count - 1 ? 0xfffffffe : start + i + 1;
  };
  chainRun(dirStart, dirSectors);
  chainRun(miniFatStart, miniFatSectors);
  chainRun(miniStreamStart, miniStreamSectors);

  const header = Buffer.alloc(SECT);
  header.writeUInt32LE(0xe011cfd0, 0);
  header.writeUInt32LE(0xe11ab1a1, 4);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(dirStart, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(0xfffffffe, 68);
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 76 + i * 4);

  const fatBuf = Buffer.alloc(SECT);
  fat.forEach((v, i) => fatBuf.writeUInt32LE(v >>> 0, i * 4));

  const dir = Buffer.alloc(dirSectors * SECT);
  entries.forEach((e, i) => {
    const off = i * 128;
    const name = Buffer.from(`${e.name}\0`, 'utf16le');
    name.copy(dir, off, 0, Math.min(64, name.length));
    dir.writeUInt16LE(Math.min(64, name.length), off + 64);
    dir[off + 66] = e.type;
    // Children as a right-leaning chain: first child hangs off `child`,
    // siblings off `right`.
    dir.writeUInt32LE(0xffffffff, off + 68);
    dir.writeUInt32LE(0xffffffff, off + 72);
    dir.writeUInt32LE(0xffffffff, off + 76);
    dir.writeUInt32LE(e.type === 5 ? miniStreamStart : (e.start ?? 0), off + 116);
    dir.writeUInt32LE(e.type === 5 ? miniStream.length : (e.data ? e.data.length : 0), off + 120);
  });
  entries.forEach((e, i) => {
    if (!e.children || !e.children.length) return;
    dir.writeUInt32LE(e.children[0], i * 128 + 76);
    for (let k = 0; k < e.children.length - 1; k += 1) dir.writeUInt32LE(e.children[k + 1], e.children[k] * 128 + 72);
  });

  const miniFatBuf = Buffer.alloc(miniFatSectors * SECT, 0xff);
  miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v >>> 0, i * 4));
  const miniStreamBuf = Buffer.alloc(miniStreamSectors * SECT);
  miniStream.copy(miniStreamBuf);
  assert.equal(1 + dirSectors + miniFatSectors + miniStreamSectors, total);
  return Buffer.concat([header, fatBuf, dir, miniFatBuf, miniStreamBuf]);
}

const utf16 = (s) => Buffer.from(s, 'utf16le');

test('familyFor routes the long tail of formats to the right extractor', () => {
  const cases = {
    'memoria.pages': 'office-writer', 'carta.wpd': 'office-writer', 'viejo.doc': 'office-writer', 'plantilla.dotm': 'office-writer',
    'ventas.numbers': 'office-calc', 'libro.xlsb': 'office-calc', 'legado.xls': 'office-calc',
    'charla.key': 'office-impress', 'deck.ppsx': 'office-impress',
    'plano.vsdx': 'office-draw', 'flyer.pub': 'office-draw',
    'fuentes.7z': '7z', 'drivers.cab': '7z', 'disco.iso': '7z', 'fotos.rar': '7z',
    'backup.tar': 'tar', 'backup.tar.gz': 'tar', 'backup.tgz': 'tar', 'logs.tar.bz2': 'tar', 'x.tar.xz': 'tar',
    'server.log.gz': 'stream', 'dump.bz2': 'stream', 'data.xz': 'stream',
    'correo.msg': 'email-msg', 'correo.eml': 'email-eml', 'buzon.mbox': 'email-mbox',
    'novela.mobi': 'ebook-palm', 'kindle.azw3': 'ebook-palm',
  };
  for (const [name, family] of Object.entries(cases)) assert.equal(extractor.familyFor(name), family, name);
  for (const name of ['a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.zip', 'a.png', 'a.mp3', 'README', 'a.txt']) {
    assert.equal(extractor.familyFor(name), null, `${name} keeps its dedicated parser`);
  }
});

test('eml: headers, encoded words, quoted-printable body and attachment names', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'correo.eml');
  fs.writeFileSync(file, [
    'From: =?UTF-8?B?Sm9zw6kgUMOpcmV6?= <jose@example.com>',
    'To: ana@example.com',
    'Subject: =?ISO-8859-1?Q?Reuni=F3n_de_ma=F1ana?=',
    'Date: Thu, 24 Sep 2026 10:00:00 -0500',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hola Ana, la reuni=C3=B3n es a las 10.=',
    ' Trae el informe.',
    '--XYZ',
    'Content-Type: application/pdf; name="informe final.pdf"',
    'Content-Disposition: attachment; filename="informe final.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--XYZ--',
    '',
  ].join('\r\n'));
  const { family, text } = await extractor.extract(file, 'correo.eml');
  assert.equal(family, 'email-eml');
  assert.match(text, /De: José Pérez <jose@example.com>/);
  assert.match(text, /Asunto: Reunión de mañana/);
  assert.match(text, /la reunión es a las 10\. Trae el informe\./);
  assert.match(text, /Adjuntos \(1\): informe final\.pdf/);
  assert.doesNotMatch(text, /JVBERi0x/, 'attachment bytes never leak into the text');
});

test('eml: html-only body is converted to readable text', () => {
  // parseEml receives the raw bytes as a latin1 string (like readFile does).
  const raw = Buffer.from('Subject: Hola\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Primera&nbsp;línea</p><p>Segunda <b>línea</b></p><script>x()</script>', 'utf8').toString('latin1');
  const mail = extractor.parseEml(raw);
  assert.match(mail.body, /Primera línea\nSegunda línea/);
  assert.doesNotMatch(mail.body, /x\(\)/);
});

test('mbox: every message is listed with its subject', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'buzon.mbox');
  fs.writeFileSync(file, [
    'From a@x Thu Sep 24 10:00:00 2026', 'Subject: Primero', '', 'cuerpo uno', '',
    'From b@x Thu Sep 24 11:00:00 2026', 'Subject: Segundo', '', 'cuerpo dos', '',
  ].join('\n'));
  const { text } = await extractor.extract(file, 'buzon.mbox');
  assert.match(text, /2 mensaje\(s\)/);
  assert.match(text, /Asunto: Primero[\s\S]*cuerpo uno[\s\S]*Asunto: Segundo[\s\S]*cuerpo dos/);
});

test('msg: Outlook compound file → sender, subject, recipients, body, attachments', async () => {
  const buf = buildCompoundFile({
    streams: {
      '__substg1.0_0037001F': utf16('Presupuesto 2027'),
      '__substg1.0_0C1A001F': utf16('Laura Gómez'),
      '__substg1.0_5D01001F': utf16('laura@empresa.pe'),
      '__substg1.0_0E04001F': utf16('Equipo Finanzas'),
      '__substg1.0_1000001F': utf16('Adjunto el presupuesto revisado. Saludos.'),
      '__properties_version1.0': Buffer.alloc(32),
    },
    storages: {
      '__recip_version1.0_#00000000': { streams: { '__substg1.0_3001001F': utf16('Equipo Finanzas'), '__substg1.0_39FE001F': utf16('finanzas@empresa.pe') } },
      '__attach_version1.0_#00000000': { streams: { '__substg1.0_3707001F': utf16('presupuesto.xlsx') } },
    },
  });
  const dir = tmpDir();
  const file = path.join(dir, 'correo.msg');
  fs.writeFileSync(file, buf);
  const { family, text } = await extractor.extract(file, 'correo.msg');
  assert.equal(family, 'email-msg');
  assert.match(text, /Correo de Outlook/);
  assert.match(text, /De: Laura Gómez laura@empresa\.pe/);
  assert.match(text, /Para: Equipo Finanzas/);
  assert.match(text, /Asunto: Presupuesto 2027/);
  assert.match(text, /Adjuntos \(1\): presupuesto\.xlsx/);
  assert.match(text, /Adjunto el presupuesto revisado\. Saludos\./);
});

test('msg: a non-OLE file named .msg fails soft (no throw, no text)', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'falso.msg');
  fs.writeFileSync(file, 'esto no es un correo de outlook');
  const result = await extractor.extract(file, 'falso.msg');
  assert.equal(result.text, null);
  assert.match(result.error, /OLE2/);
});

test('PalmDOC decompression: literals, space pairs and back-references', () => {
  // "ab" literal, 0xC1 → " A", then copy distance 3 length 3 → "b A".
  const pair = (3 << 3) | (3 - 3);
  const data = Buffer.from([0x61, 0x62, 0xc1, 0x80 | (pair >> 8), pair & 0xff]);
  assert.equal(extractor.palmDocDecompress(data).toString('latin1'), 'ab Ab A');
  assert.equal(extractor.palmDocDecompress(Buffer.from([0x02, 0x00, 0x01, 0x7a])).toString('latin1'), '\x00\x01z');
});

function buildMobi(text, { compression = 1, encryption = 0 } = {}) {
  const body = Buffer.from(`<html><body><p>${text}</p></body></html>`, 'utf8');
  const record0 = Buffer.alloc(16 + 0xe8);
  record0.writeUInt16BE(compression, 0);
  record0.writeUInt32BE(body.length, 4);
  record0.writeUInt16BE(1, 8);
  record0.writeUInt16BE(4096, 10);
  record0.writeUInt16BE(encryption, 12);
  record0.write('MOBI', 16, 'latin1');
  record0.writeUInt32BE(0xe8, 20);
  record0.writeUInt32BE(65001, 28);
  record0.writeUInt16BE(0, 16 + 0xe2);
  const headerLen = 78 + 2 * 8 + 2;
  const header = Buffer.alloc(headerLen);
  header.write('Mi_Libro', 0, 'latin1');
  header.write('BOOKMOBI', 60, 'latin1');
  header.writeUInt16BE(2, 76);
  header.writeUInt32BE(headerLen, 78);
  header.writeUInt32BE(headerLen + record0.length, 86);
  return Buffer.concat([header, record0, body]);
}

test('mobi: uncompressed MOBI text is extracted; DRM books are reported, not garbled', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'libro.mobi');
  fs.writeFileSync(file, buildMobi('Capítulo uno. Érase una vez.'));
  const { family, text } = await extractor.extract(file, 'libro.mobi');
  assert.equal(family, 'ebook-palm');
  assert.match(text, /Mi Libro/);
  assert.match(text, /Capítulo uno\. Érase una vez\./);

  const drm = path.join(dir, 'drm.azw');
  fs.writeFileSync(drm, buildMobi('secreto', { encryption: 2 }));
  const locked = await extractor.extract(drm, 'drm.azw');
  assert.match(locked.text, /DRM/);
  assert.doesNotMatch(locked.text, /secreto/);
});

test('tar / tar.gz archives: inventory + readable members, binaries only listed', { skip: !hasBinary('tar') }, async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(src, 'docs', 'leeme.md'), '# Proyecto\nInstrucciones de uso.');
  fs.writeFileSync(path.join(src, 'datos.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(src, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  execFileSync('tar', ['-cf', path.join(dir, 'b.tar'), '-C', src, '.']);
  execFileSync('tar', ['-czf', path.join(dir, 'b.tar.gz'), '-C', src, '.']);
  for (const name of ['b.tar', 'b.tar.gz']) {
    const { family, text } = await extractor.extract(path.join(dir, name), name);
    assert.equal(family, 'tar');
    assert.match(text, /3 archivo\(s\)/, name);
    assert.match(text, /leeme\.md/);
    assert.match(text, /Instrucciones de uso\./);
    assert.match(text, /a,b\n1,2/);
    assert.match(text, /logo\.png/);
    assert.doesNotMatch(text, /PNG\u0000/);
  }
});

test('single-stream .gz: text content is read; a gzipped TAR is listed as an archive', { skip: !hasBinary('gzip') || !hasBinary('tar') }, async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'server.log.gz');
  fs.writeFileSync(log, zlib.gzipSync('linea 1\nERROR conexión perdida\n'));
  const plain = await extractor.extract(log, 'server.log.gz');
  assert.equal(plain.family, 'stream');
  assert.match(plain.text, /contenido de "server\.log"/);
  assert.match(plain.text, /ERROR conexión perdida/);

  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'nota.txt'), 'dentro del tar');
  execFileSync('tar', ['-czf', path.join(dir, 'paquete.gz'), '-C', src, 'nota.txt']);
  const nested = await extractor.extract(path.join(dir, 'paquete.gz'), 'paquete.gz');
  assert.match(nested.text, /nota\.txt/);
  assert.match(nested.text, /dentro del tar/);

  const bin = path.join(dir, 'blob.gz');
  fs.writeFileSync(bin, zlib.gzipSync(Buffer.from([0, 1, 2, 3, 0, 0, 255, 254])));
  const opaque = await extractor.extract(bin, 'blob.gz');
  assert.match(opaque.text, /datos binarios/);
});

test('archive members are read through capped pipes (bombs cannot exhaust memory)', async () => {
  // 50 MB of zeros compresses to ~50 KB; the reader must stop at its cap.
  const run = await extractor.runCapture(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(50*1024*1024, 97))'], { maxBytes: 64 * 1024 });
  assert.equal(run.truncated, true);
  assert.equal(run.stdout.length, 64 * 1024);
});

test('unsupported / missing tools degrade to a clear Spanish note, never a throw', async () => {
  const dir = tmpDir();
  const rar = path.join(dir, 'fotos.rar');
  fs.writeFileSync(rar, Buffer.from('Rar!\x1a\x07\x00garbage', 'latin1'));
  const result = await extractor.extract(rar, 'fotos.rar');
  assert.equal(result.family, '7z');
  assert.ok(typeof result.text === 'string' && result.text.length > 0);
  assert.match(result.text, /RAR|7-Zip|guardado/);
});

test('fileProcessor routes .eml through the universal extractor', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'files-1-abc.eml');
  fs.writeFileSync(file, 'From: a@b.c\r\nSubject: Factura\r\n\r\nAdjunto la factura de septiembre.');
  const result = await fileProcessor.processFile({
    path: file, originalname: 'factura.eml', mimetype: 'message/rfc822', size: fs.statSync(file).size,
  });
  assert.equal(result.success, true);
  assert.match(result.extractedText, /Correo electrónico/);
  assert.match(result.extractedText, /Asunto: Factura/);
});

test('fileProcessor never crashes on legacy .doc without LibreOffice (no processLegacyDoc TypeError)', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'files-1-abc.doc');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(2048)]));
  const result = await fileProcessor.processFile({
    path: file, originalname: 'viejo.doc', mimetype: 'application/msword', size: fs.statSync(file).size,
  });
  assert.doesNotMatch(String(result.error || ''), /is not a function/);
  assert.equal(result.success, true, result.error);
});
