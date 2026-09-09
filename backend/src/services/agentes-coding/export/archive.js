'use strict';

/**
 * Minimal zip (STORE) + ustar+gzip builders for session export.
 * No archiver / tar npm — stdlib zlib only. Paths must already be jailed.
 */

const zlib = require('node:zlib');
const { fail } = require('../coding-sandbox/errors');

const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const ZIP_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function assertSafeArchiveName(name) {
  const rel = String(name || '');
  if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.includes('..')) {
    fail('E_PATH_ESCAPE', 'Nombre de archivo de archivo inválido.');
  }
  if (rel.length > 240) fail('E_PARAMS', 'La ruta del archivo exportado es demasiado larga.');
  return rel.replace(/\\/g, '/');
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = assertSafeArchiveName(entry.path);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      ZIP_LOCAL,
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    const central = Buffer.concat([
      ZIP_CENTRAL,
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    ZIP_EOCD,
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(centralStart),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function octal(n, width) {
  const s = (n >>> 0).toString(8);
  return Buffer.from(s.padStart(width - 1, '0').slice(-1 * (width - 1)) + '\0', 'utf8');
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  const nameBuf = Buffer.from(assertSafeArchiveName(name), 'utf8');
  if (nameBuf.length > 99) fail('E_PARAMS', 'La ruta tar supera 99 caracteres.');
  nameBuf.copy(header, 0);
  Buffer.from('000644 \0', 'utf8').copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  header[156] = 0x30; // regular file
  Buffer.from('ustar\0', 'utf8').copy(header, 257);
  Buffer.from('00', 'utf8').copy(header, 263);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  const chk = Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'utf8');
  chk.copy(header, 148);
  return header;
}

function pad512(buf) {
  const rem = buf.length % 512;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]);
}

function buildTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
    parts.push(tarHeader(entry.path, data.length));
    parts.push(pad512(data));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

function buildTarGz(entries) {
  return zlib.gzipSync(buildTar(entries), { level: 6 });
}

function buildArchive(format, entries) {
  const kind = String(format || 'zip').trim().toLowerCase();
  if (kind === 'zip') return { format: 'zip', bytes: buildZip(entries), ext: 'zip', mime: 'application/zip' };
  if (kind === 'tar.gz' || kind === 'tgz' || kind === 'tarball') {
    return {
      format: 'tar.gz',
      bytes: buildTarGz(entries),
      ext: 'tar.gz',
      mime: 'application/gzip',
    };
  }
  fail('E_PARAMS', 'Formato de exportación no soportado (usa zip o tar.gz).');
  return null;
}

module.exports = {
  crc32,
  buildZip,
  buildTar,
  buildTarGz,
  buildArchive,
};
