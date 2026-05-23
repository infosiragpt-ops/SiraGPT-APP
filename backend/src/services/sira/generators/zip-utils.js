"use strict";

/**
 * Minimal ZIP writer/reader supporting STORE (method 0) and DEFLATE
 * (method 8). Sufficient for EPUB and ODT containers, both of which
 * require an uncompressed `mimetype` entry as the first file.
 *
 * No native deps — uses only `node:zlib` for raw deflate/inflate.
 */

const { deflateRawSync, inflateRawSync } = require("node:zlib");

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ _crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {Array<{name: string, data: Buffer|string, store?: boolean}>} entries
 * @returns {Buffer}
 */
function zipBuild(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("zipBuild: entries must be a non-empty array");
  }
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const e of entries) {
    if (!e || typeof e.name !== "string" || e.name.length === 0) {
      throw new Error("zipBuild: each entry needs a non-empty name");
    }
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const store = !!e.store;
    const compData = store ? data : deflateRawSync(data);
    const method = store ? 0 : 8;
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(SIG_LFH, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compData.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localChunks.push(lfh, nameBuf, compData);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(SIG_CDH, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compData.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);

    centralChunks.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compData.length;
  }

  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, central, eocd]);
}

/**
 * Parse a zip buffer produced by `zipBuild` (or any other writer using
 * STORE/DEFLATE without zip64 extensions). Returns an array of
 * `{ name, data, method }` ordered by central directory.
 */
function zipParse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new Error("zipParse: not a buffer or too small");
  }
  let eocdPos = -1;
  const lo = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= lo; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error("zipParse: end-of-central-directory not found");

  const cdEntries = buf.readUInt16LE(eocdPos + 10);
  const cdStart = buf.readUInt32LE(eocdPos + 16);

  const out = [];
  let p = cdStart;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(p) !== SIG_CDH) {
      throw new Error(`zipParse: bad central header at ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    if (buf.readUInt32LE(localOffset) !== SIG_LFH) {
      throw new Error(`zipParse: bad local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compData = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = compData;
    else if (method === 8) data = inflateRawSync(compData);
    else throw new Error(`zipParse: unsupported compression method ${method} for ${name}`);

    if (data.length !== uncompSize) {
      throw new Error(`zipParse: size mismatch for ${name}`);
    }
    if (crc32(data) !== buf.readUInt32LE(p + 16)) {
      throw new Error(`zipParse: CRC mismatch for ${name}`);
    }

    out.push({ name, data, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = { zipBuild, zipParse, crc32, xmlEscape };
