'use strict';

/**
 * universal-document-extractor — text for the long tail of formats the chat
 * accepts but fileProcessor has no dedicated parser for.
 *
 *   - Office-family files LibreOffice can import (iWork, WordPerfect, Works,
 *     StarOffice, Visio, Publisher, macro/template variants of OOXML/ODF…)
 *     → LibreOffice headless → text / CSV-like rows / PDF → pdftotext.
 *   - Archives beyond ZIP: 7z, CAB, ISO, ARJ, LZH, WIM… (7-Zip), TAR and
 *     tar.gz / tar.bz2 / tar.xz (tar), single-stream .gz / .bz2 / .xz.
 *     Inventory + text of readable members, streamed to stdout with byte
 *     caps (nothing is written to disk, so no path traversal and no bombs).
 *   - Outlook .msg (OLE2 compound file, read in-process), .eml and .mbox
 *     (headers, readable body, attachment names).
 *   - MOBI / AZW / AZW3 / PRC e-books (PalmDOC decompression).
 *
 * Everything is best-effort: a missing binary, a timeout or a hostile file
 * returns a short Spanish note instead of throwing, and the upload still
 * succeeds (the original bytes stay stored and downloadable).
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MAX_TEXT_CHARS = parsePositiveInt(process.env.UNIVERSAL_EXTRACT_MAX_CHARS, 2 * 1024 * 1024);
const MAX_MEMBER_BYTES = parsePositiveInt(process.env.UNIVERSAL_ARCHIVE_MEMBER_MAX_BYTES, 1024 * 1024);
const MAX_MEMBERS_READ = parsePositiveInt(process.env.UNIVERSAL_ARCHIVE_MAX_MEMBERS_READ, 60);
const MAX_LISTED = parsePositiveInt(process.env.UNIVERSAL_ARCHIVE_MAX_LISTED, 500);
const MAX_ARCHIVE_UNPACKED_BYTES = parsePositiveInt(process.env.UNIVERSAL_ARCHIVE_MAX_UNPACKED_BYTES, 2 * 1024 * 1024 * 1024);
const COMMAND_TIMEOUT_MS = parsePositiveInt(process.env.UNIVERSAL_EXTRACT_TIMEOUT_MS, 90_000);
const LIBREOFFICE_BIN = process.env.LIBREOFFICE_BIN || 'soffice';
const MAX_IN_MEMORY_BYTES = 256 * 1024 * 1024;

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Families ─────────────────────────────────────────────────────────────

const OFFICE_WRITER = new Set([
  'docm', 'dotx', 'dotm', 'dot', 'wpd', 'wps', 'wpt', 'lwp', 'abw', 'zabw', 'hwp', 'cwk', 'sxw', 'stw',
  'sdw', 'wri', 'mcw', 'ott', 'fodt', 'pages', 'uot', '602', 'pdb', 'xps', 'oxps',
]);
const OFFICE_CALC = new Set([
  'xls', 'xlsm', 'xlsb', 'xltx', 'xltm', 'xlt', 'xlw', 'ots', 'fods', 'sxc', 'stc', 'sdc', 'dbf',
  'wk1', 'wks', '123', 'wb2', 'qpw', 'numbers', 'uos', 'slk', 'dif',
]);
const OFFICE_IMPRESS = new Set([
  'ppt', 'pptm', 'ppsx', 'ppsm', 'pps', 'potx', 'potm', 'pot', 'otp', 'fodp', 'sxi', 'sti', 'sdd', 'key', 'uop',
]);
const OFFICE_DRAW = new Set([
  'odg', 'otg', 'fodg', 'vsd', 'vsdx', 'vsdm', 'vdx', 'vss', 'vst', 'pub', 'cdr', 'cmx', 'wpg', 'sxd', 'sda', 'cgm',
]);
// Legacy binaries have dedicated handling upstream only when LibreOffice is
// involved; `.doc` is routed here too because fileProcessor has no parser.
const LEGACY_WRITER = new Set(['doc']);

const SEVEN_ZIP_ARCHIVES = new Set([
  '7z', 'cab', 'iso', 'arj', 'lzh', 'lha', 'wim', 'swm', 'cpio', 'rpm', 'deb', 'dmg', 'hfs', 'udf',
  'vhd', 'vhdx', 'vmdk', 'squashfs', 'chm', 'nsis', 'xar', 'z', 'lzma', 'rar', 'r00', 'cbr', 'cb7',
]);
const TAR_ARCHIVES = new Map([
  ['tar', ''], ['tgz', 'z'], ['taz', 'z'], ['tbz', 'j'], ['tbz2', 'j'], ['tb2', 'j'], ['txz', 'J'],
]);
const SINGLE_STREAM = new Map([
  ['gz', ['gzip', ['-dc']]], ['gzip', ['gzip', ['-dc']]], ['bz2', ['bzcat', []]], ['xz', ['xzcat', []]],
]);
const EBOOK_PALM = new Set(['mobi', 'azw', 'azw3', 'prc', 'azw4']);
const EMAIL = new Set(['eml', 'msg', 'oft', 'mbox', 'emlx']);

const TEXT_MEMBER_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'html', 'htm', 'xhtml', 'svg',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'java', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'rb', 'go',
  'rs', 'php', 'swift', 'kt', 'kts', 'scala', 'r', 'jl', 'lua', 'pl', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'env', 'log', 'sql', 'graphql', 'gql', 'proto', 'prisma', 'tex', 'bib', 'rst', 'adoc', 'org', 'srt', 'vtt',
  'ics', 'vcf', 'eml', 'gitignore', 'dockerfile', 'makefile', 'gradle', 'cmake', 'tf', 'hcl', 'ipynb',
]);

/** Lower-case extension of a filename, with multi-part tar suffixes collapsed. */
function extensionOf(name) {
  const lower = String(name || '').toLowerCase();
  const multi = /\.tar\.(gz|bz2|xz|z)$/.exec(lower);
  if (multi) return { gz: 'tgz', bz2: 'tbz2', xz: 'txz', z: 'taz' }[multi[1]];
  const ext = path.extname(lower).replace(/^\./, '');
  return ext;
}

function familyFor(name) {
  const ext = extensionOf(name);
  if (!ext) return null;
  if (LEGACY_WRITER.has(ext) || OFFICE_WRITER.has(ext)) return 'office-writer';
  if (OFFICE_CALC.has(ext)) return 'office-calc';
  if (OFFICE_IMPRESS.has(ext)) return 'office-impress';
  if (OFFICE_DRAW.has(ext)) return 'office-draw';
  if (TAR_ARCHIVES.has(ext)) return 'tar';
  if (SEVEN_ZIP_ARCHIVES.has(ext)) return '7z';
  if (SINGLE_STREAM.has(ext)) return 'stream';
  if (EBOOK_PALM.has(ext)) return 'ebook-palm';
  if (EMAIL.has(ext)) return ext === 'msg' || ext === 'oft' ? 'email-msg' : (ext === 'mbox' ? 'email-mbox' : 'email-eml');
  return null;
}

function handles(name) {
  return familyFor(name) !== null;
}

// ── Process helpers ──────────────────────────────────────────────────────

/**
 * Run a command and capture stdout up to `maxBytes`; the child is killed as
 * soon as the cap is reached (that is how archive bombs stay bounded).
 */
function runCapture(cmd, args, { maxBytes = MAX_MEMBER_BYTES, timeoutMs = COMMAND_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, env: { ...process.env, LC_ALL: 'C.UTF-8' } });
    } catch (error) {
      resolve({ ok: false, missing: true, stdout: Buffer.alloc(0), stderr: String(error.message || error) });
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), truncated, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      finish({ ok: false, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      const room = maxBytes - size;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, Math.max(0, room)));
        size = maxBytes;
        truncated = true;
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, missing: error.code === 'ENOENT', stderr: String(error.message || error) }));
    child.on('close', (code) => finish({ ok: truncated || code === 0, code }));
  });
}

const binaryCache = new Map();
async function findBinary(candidates) {
  const key = candidates.join('|');
  if (binaryCache.has(key)) return binaryCache.get(key);
  let found = null;
  for (const bin of candidates) {
    const probe = await runCapture(bin, bin === LIBREOFFICE_BIN ? ['--version'] : ['--help'], { maxBytes: 4096, timeoutMs: 20_000 });
    if (!probe.missing) { found = bin; break; }
  }
  binaryCache.set(key, found);
  return found;
}

function looksLikeText(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control += 1;
  }
  return control / sample.length < 0.05;
}

function decodeText(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const utf8 = buf.toString('utf8');
  // Mostly-invalid UTF-8 → Windows-1252/Latin-1 (old Spanish documents).
  const bad = (utf8.match(/�/g) || []).length;
  return bad > 8 && bad > utf8.length / 200 ? buf.toString('latin1') : utf8.replace(/^﻿/, '');
}

function capText(text, max = MAX_TEXT_CHARS) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n\n[… texto recortado a ${max.toLocaleString('es')} caracteres]` : value;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function isReadableMember(name) {
  const base = path.basename(String(name || '')).toLowerCase();
  if (!base || base.startsWith('._') || base === '.ds_store') return false;
  const ext = path.extname(base).replace(/^\./, '');
  return TEXT_MEMBER_EXTENSIONS.has(ext) || TEXT_MEMBER_EXTENSIONS.has(base);
}

function unsafeMemberName(name) {
  const n = String(name || '').replace(/\\/g, '/');
  return !n || n.includes('\0') || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').includes('..')
    || /[*?[\]]/.test(n) || n.startsWith('-');
}

// ── LibreOffice ──────────────────────────────────────────────────────────

async function libreOfficeConvert(filePath, originalName, target, outExt) {
  const bin = await findBinary([LIBREOFFICE_BIN]);
  if (!bin) return { ok: false, reason: 'libreoffice_missing' };
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sira-universal-'));
  const profileDir = path.join(workDir, 'profile');
  const outDir = path.join(workDir, 'out');
  // LibreOffice picks import filters by extension for some formats (iWork,
  // WordPerfect), so hand it a copy named like the original upload.
  const ext = extensionOf(originalName) || 'bin';
  const input = path.join(workDir, `document.${ext}`);
  try {
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.symlink(path.resolve(filePath), input).catch(() => fsp.copyFile(filePath, input));
    const run = await runCapture(bin, [
      `-env:UserInstallation=file://${profileDir}`, '--headless', '--norestore', '--nolockcheck',
      '--nodefault', '--nofirststartwizard', '--convert-to', target, '--outdir', outDir, input,
    ], { maxBytes: 64 * 1024, timeoutMs: Math.max(COMMAND_TIMEOUT_MS, 120_000) });
    const names = (await fsp.readdir(outDir).catch(() => [])).filter((n) => n.toLowerCase().endsWith(`.${outExt}`));
    // Multi-sheet CSV exports are written one after another: mtime keeps the
    // workbook's sheet order (names alone would sort alphabetically).
    const stamped = await Promise.all(names.map(async (n) => ({ n, t: (await fsp.stat(path.join(outDir, n))).mtimeMs })));
    const produced = stamped.sort((a, b) => a.t - b.t || a.n.localeCompare(b.n)).map((x) => x.n);
    if (!produced.length) return { ok: false, reason: run.timedOut ? 'timeout' : 'no_output' };
    return {
      ok: true,
      path: path.join(outDir, produced[0]),
      paths: produced.map((n) => path.join(outDir, n)),
      cleanup: () => fsp.rm(workDir, { recursive: true, force: true }),
    };
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  } finally {
    // Caller cleans up on success (it still has to read the output).
    if (!(await fsp.readdir(outDir).catch(() => [])).length) fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readConverted(converted, reader) {
  try {
    return await reader(converted.path);
  } finally {
    await converted.cleanup().catch(() => {});
  }
}

async function pdfToText(pdfPath) {
  const run = await runCapture('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], { maxBytes: MAX_TEXT_CHARS * 2 });
  return run.missing ? '' : decodeText(run.stdout);
}

async function extractOffice(filePath, originalName, family) {
  const label = {
    'office-writer': 'Documento',
    'office-calc': 'Hoja de cálculo',
    'office-impress': 'Presentación',
    'office-draw': 'Dibujo / diagrama',
  }[family];
  let text = '';
  if (family === 'office-writer') {
    const converted = await libreOfficeConvert(filePath, originalName, 'txt:Text (encoded):UTF8', 'txt');
    if (converted.ok) text = await readConverted(converted, async (p) => decodeText(await fsp.readFile(p)));
  } else if (family === 'office-calc') {
    // Sheet token -1 exports EVERY sheet as its own CSV (document-<Hoja>.csv),
    // UTF-8 (76), comma separated, quoted text, formulas as shown values.
    const csv = await libreOfficeConvert(filePath, originalName,
      'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1', 'csv');
    if (csv.ok) {
      text = await readConverted(csv, async () => {
        const sheets = [];
        for (const p of csv.paths) {
          const body = decodeText(await fsp.readFile(p)).trim();
          if (!body) continue;
          const sheet = path.basename(p, '.csv').replace(/^document-?/, '') || `Hoja ${sheets.length + 1}`;
          sheets.push(csv.paths.length > 1 ? `### Hoja: ${sheet}\n${body}` : body);
        }
        return sheets.join('\n\n');
      });
    }
    if (!text.trim()) {
      const pdf = await libreOfficeConvert(filePath, originalName, 'pdf', 'pdf');
      if (pdf.ok) text = await readConverted(pdf, pdfToText);
    }
  } else {
    const pdf = await libreOfficeConvert(filePath, originalName, 'pdf', 'pdf');
    if (pdf.ok) text = await readConverted(pdf, pdfToText);
  }
  text = text.replace(/\f/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (!text) return null;
  return `${label} (.${extensionOf(originalName)}) — convertido con LibreOffice\n---\n${capText(text)}`;
}

// ── Archives ─────────────────────────────────────────────────────────────

function renderArchive(kind, name, entries, texts, notes = []) {
  const files = entries.filter((e) => !e.dir);
  const total = files.reduce((sum, e) => sum + (e.size || 0), 0);
  const lines = [
    `Archivo comprimido ${kind} "${name}" — ${files.length} archivo(s)${total ? `, ${formatBytes(total)} sin comprimir` : ''}`,
    ...notes,
    '',
    'Contenido:',
    ...files.slice(0, MAX_LISTED).map((e) => `- ${e.name}${e.size ? ` (${formatBytes(e.size)})` : ''}`),
  ];
  if (files.length > MAX_LISTED) lines.push(`- … y ${files.length - MAX_LISTED} más`);
  for (const t of texts) lines.push('', `=== ${t.name}${t.truncated ? ' (recortado)' : ''} ===`, t.text);
  return capText(lines.join('\n'));
}

async function readMembers(entries, reader) {
  const texts = [];
  let chars = 0;
  for (const entry of entries) {
    if (texts.length >= MAX_MEMBERS_READ || chars >= MAX_TEXT_CHARS) break;
    if (entry.dir || entry.encrypted || !isReadableMember(entry.name) || unsafeMemberName(entry.name)) continue;
    const run = await reader(entry.name);
    if (!run || !run.stdout || !run.stdout.length || !looksLikeText(run.stdout)) continue;
    const text = decodeText(run.stdout).trim();
    if (!text) continue;
    texts.push({ name: entry.name, text, truncated: run.truncated });
    chars += text.length;
  }
  return texts;
}

async function extractSevenZip(filePath, originalName) {
  const ext = extensionOf(originalName);
  const bin = await findBinary(['7zz', '7z', '7za']);
  if (!bin) {
    return `Archivo comprimido .${ext} "${originalName}" guardado. El servidor no tiene 7-Zip para abrirlo; el archivo se conserva completo y puede descargarse.`;
  }
  // -p… : never prompt for a password (encrypted archives fail fast instead).
  const list = await runCapture(bin, ['l', '-slt', '-ba', '-pSIRA_NO_PASSWORD', '--', filePath], { maxBytes: 8 * 1024 * 1024 });
  const entries = [];
  for (const block of decodeText(list.stdout).split(/\r?\n\r?\n/)) {
    const field = (k) => (new RegExp(`^${k} = (.*)$`, 'm').exec(block) || [])[1];
    const name = field('Path');
    if (!name) continue;
    entries.push({
      name,
      size: Number.parseInt(field('Size') || '0', 10) || 0,
      dir: field('Folder') === '+' || /^D/.test(field('Attributes') || ''),
      encrypted: field('Encrypted') === '+',
    });
  }
  const stderr = String(list.stderr || '');
  if (!entries.length) {
    if (/wrong password|encrypted|can not open encrypted/i.test(stderr)) {
      return `Archivo comprimido .${ext} "${originalName}" protegido con contraseña. Se guardó completo; para leer su contenido súbelo sin contraseña.`;
    }
    if (ext === 'rar' || ext === 'cbr' || ext === 'r00') {
      return `Archivo RAR "${originalName}" guardado completo. El servidor no abre RAR; si necesitas que se lea su contenido, súbelo como ZIP o 7z.`;
    }
    return `Archivo comprimido .${ext} "${originalName}" guardado, pero no se pudo leer su índice (puede estar dañado o en un formato no compatible).`;
  }
  const unpacked = entries.reduce((sum, e) => sum + (e.size || 0), 0);
  const notes = [];
  if (entries.some((e) => e.encrypted)) notes.push('Algunos archivos están cifrados con contraseña y no se leyeron.');
  if (unpacked > MAX_ARCHIVE_UNPACKED_BYTES) notes.push(`Contenido muy grande (${formatBytes(unpacked)}): solo se muestra el índice.`);
  const texts = unpacked > MAX_ARCHIVE_UNPACKED_BYTES ? [] : await readMembers(entries, (member) => runCapture(
    bin, ['e', '-so', '-y', '-bd', '-pSIRA_NO_PASSWORD', '--', filePath, member], { maxBytes: MAX_MEMBER_BYTES },
  ));
  return renderArchive(`.${ext}`, originalName, entries, texts, notes);
}

async function extractTar(filePath, originalName) {
  const ext = extensionOf(originalName);
  const flag = TAR_ARCHIVES.get(ext) || '';
  const list = await runCapture('tar', [`-t${flag}f`, filePath], { maxBytes: 4 * 1024 * 1024 });
  if (list.missing) return null;
  const names = decodeText(list.stdout).split(/\r?\n/).filter(Boolean);
  if (!names.length) {
    return `Archivo TAR "${originalName}" guardado, pero no se pudo leer su índice (puede estar dañado).`;
  }
  const entries = names.map((name) => ({ name, dir: name.endsWith('/') }));
  const texts = await readMembers(entries, (member) => runCapture('tar', [`-x${flag}Of`, filePath, '--', member], { maxBytes: MAX_MEMBER_BYTES }));
  return renderArchive(ext === 'tar' ? 'TAR' : `TAR (.${ext})`, originalName, entries, texts);
}

async function extractSingleStream(filePath, originalName) {
  const ext = extensionOf(originalName);
  const [cmd, args] = SINGLE_STREAM.get(ext);
  const run = await runCapture(cmd, [...args, filePath], { maxBytes: MAX_TEXT_CHARS });
  if (run.missing || !run.stdout.length) return null;
  const innerName = originalName.replace(/\.[^.]+$/, '');
  // A .gz that holds a TAR (named .gz only) → list it as a TAR.
  if (run.stdout.length > 262 && run.stdout.subarray(257, 262).toString('latin1') === 'ustar') {
    const tarFlag = { gz: 'z', gzip: 'z', bz2: 'j', xz: 'J' }[ext];
    const list = await runCapture('tar', [`-t${tarFlag}f`, filePath], { maxBytes: 4 * 1024 * 1024 });
    const entries = decodeText(list.stdout).split(/\r?\n/).filter(Boolean).map((name) => ({ name, dir: name.endsWith('/') }));
    const texts = await readMembers(entries, (member) => runCapture('tar', [`-x${tarFlag}Of`, filePath, '--', member], { maxBytes: MAX_MEMBER_BYTES }));
    return renderArchive(`TAR (.${ext})`, originalName, entries, texts);
  }
  if (!looksLikeText(run.stdout)) {
    return `Archivo comprimido .${ext} "${originalName}" — contiene "${innerName}" (datos binarios${run.truncated ? `, más de ${formatBytes(MAX_TEXT_CHARS)}` : `, ${formatBytes(run.stdout.length)}`}). Se guardó completo.`;
  }
  return `Archivo comprimido .${ext} "${originalName}" — contenido de "${innerName}"${run.truncated ? ' (recortado)' : ''}\n---\n${capText(decodeText(run.stdout))}`;
}

// ── E-mail ───────────────────────────────────────────────────────────────

function decodeCharset(buf, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(cs === 'latin1' ? 'iso-8859-1' : cs).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function decodeEncodedWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, charset, enc, data) => {
    try {
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return decodeCharset(bytes, charset);
    } catch {
      return data;
    }
  });
}

function parseHeaders(raw) {
  const headers = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (!(key in headers)) headers[key] = m[2];
  }
  return headers;
}

function headerParam(value, param) {
  const m = new RegExp(`${param}\\*?=(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(String(value || ''));
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? '';
  const ext = /^([^']*)'[^']*'(.*)$/.exec(raw);
  if (ext) {
    try { return decodeURIComponent(ext[2]); } catch { return ext[2]; }
  }
  return decodeEncodedWords(raw);
}

function decodeTransfer(body, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  return Buffer.from(body, 'latin1');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function walkMime(raw, out, depth = 0) {
  const split = raw.search(/\r?\n\r?\n/);
  const headerText = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, '') : '';
  const headers = parseHeaders(headerText);
  const type = String(headers['content-type'] || 'text/plain').toLowerCase();
  const disposition = String(headers['content-disposition'] || '');
  const filename = headerParam(disposition, 'filename') || headerParam(headers['content-type'], 'name');
  if (depth === 0) out.headers = headers;
  if (/^multipart\//.test(type) && depth < 8) {
    const boundary = headerParam(headers['content-type'], 'boundary');
    if (!boundary) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const part of parts.slice(1)) if (part.trim()) walkMime(part, out, depth + 1);
    return;
  }
  if (filename || /^attachment/i.test(disposition)) {
    out.attachments.push(filename || '(sin nombre)');
    return;
  }
  if (type.startsWith('message/rfc822') && depth < 8) {
    out.attachments.push('mensaje reenviado');
    return;
  }
  const decoded = decodeCharset(decodeTransfer(body, headers['content-transfer-encoding']), headerParam(headers['content-type'], 'charset'));
  if (type.startsWith('text/plain') && !out.plain) out.plain = decoded;
  else if (type.startsWith('text/html') && !out.html) out.html = decoded;
}

function renderEmail(fields, bodyText, attachments, label) {
  const lines = [label];
  for (const [k, v] of fields) if (v) lines.push(`${k}: ${String(v).trim()}`);
  if (attachments.length) lines.push(`Adjuntos (${attachments.length}): ${attachments.join(', ')}`);
  lines.push('---', bodyText ? bodyText.trim() : '(sin cuerpo de texto)');
  return lines.join('\n');
}

function parseEml(raw) {
  const out = { headers: {}, attachments: [], plain: '', html: '' };
  walkMime(raw, out);
  const h = out.headers;
  const body = out.plain || htmlToText(out.html);
  return {
    fields: [
      ['De', decodeEncodedWords(h.from)], ['Para', decodeEncodedWords(h.to)], ['CC', decodeEncodedWords(h.cc)],
      ['Fecha', h.date], ['Asunto', decodeEncodedWords(h.subject)],
    ],
    body,
    attachments: out.attachments,
  };
}

async function extractEml(filePath, originalName) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_IN_MEMORY_BYTES) return null;
  const raw = (await fsp.readFile(filePath)).toString('latin1');
  const mail = parseEml(raw);
  return capText(renderEmail(mail.fields, mail.body, mail.attachments, `Correo electrónico (.${extensionOf(originalName)}) "${originalName}"`));
}

async function extractMbox(filePath, originalName) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_IN_MEMORY_BYTES) return null;
  const raw = (await fsp.readFile(filePath)).toString('latin1');
  const messages = raw.split(/^From [^\r\n]*\r?\n/m).filter((m) => m.trim());
  const blocks = [`Buzón de correo (.mbox) "${originalName}" — ${messages.length} mensaje(s)`];
  let chars = 0;
  for (const [i, message] of messages.entries()) {
    if (chars > MAX_TEXT_CHARS) { blocks.push(`… ${messages.length - i} mensaje(s) más sin mostrar.`); break; }
    const mail = parseEml(message);
    const block = renderEmail(mail.fields, mail.body.slice(0, 20_000), mail.attachments, `\n### Mensaje ${i + 1}`);
    blocks.push(block);
    chars += block.length;
  }
  return capText(blocks.join('\n'));
}

// ── Outlook .msg (OLE2 compound file) ────────────────────────────────────

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

function readCompoundFile(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error('not an OLE2 compound file');
  }
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSectorSize = 1 << buf.readUInt16LE(32);
  const firstDirSector = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  const firstDifat = buf.readUInt32LE(68);
  const sectorCount = Math.floor((buf.length - sectorSize) / sectorSize);
  const sectorOffset = (id) => sectorSize + id * sectorSize;
  const validSector = (id) => id < sectorCount;

  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) {
    const id = buf.readUInt32LE(76 + i * 4);
    if (id !== FREESECT && validSector(id)) fatSectors.push(id);
  }
  const seenDifat = new Set();
  for (let difat = firstDifat; difat !== ENDOFCHAIN && difat !== FREESECT && validSector(difat) && !seenDifat.has(difat);) {
    seenDifat.add(difat);
    const base = sectorOffset(difat);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i += 1) {
      const id = buf.readUInt32LE(base + i * 4);
      if (id !== FREESECT && validSector(id)) fatSectors.push(id);
    }
    difat = buf.readUInt32LE(base + per * 4);
  }
  const fat = [];
  for (const id of fatSectors) {
    const base = sectorOffset(id);
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(buf.readUInt32LE(base + i * 4));
  }
  const chain = (start, table) => {
    const ids = [];
    const seen = new Set();
    for (let id = start; id !== ENDOFCHAIN && id !== FREESECT && id < table.length && !seen.has(id); id = table[id]) {
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };
  const readChain = (start) => Buffer.concat(chain(start, fat).filter(validSector)
    .map((id) => buf.subarray(sectorOffset(id), sectorOffset(id) + sectorSize)));

  const dirData = readChain(firstDirSector);
  const entries = [];
  for (let off = 0; off + 128 <= dirData.length; off += 128) {
    const nameLen = dirData.readUInt16LE(off + 64);
    entries.push({
      name: dirData.subarray(off, off + Math.max(0, Math.min(64, nameLen) - 2)).toString('utf16le'),
      type: dirData[off + 66],
      left: dirData.readUInt32LE(off + 68),
      right: dirData.readUInt32LE(off + 72),
      child: dirData.readUInt32LE(off + 76),
      start: dirData.readUInt32LE(off + 116),
      size: dirData.readUInt32LE(off + 120),
    });
  }
  const root = entries[0];
  const miniStream = root ? readChain(root.start) : Buffer.alloc(0);
  const miniFatData = firstMiniFat !== ENDOFCHAIN ? readChain(firstMiniFat) : Buffer.alloc(0);
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatData.length; i += 4) miniFat.push(miniFatData.readUInt32LE(i));

  const readStream = (entry) => {
    if (entry.size < miniCutoff) {
      const parts = chain(entry.start, miniFat).map((id) => miniStream.subarray(id * miniSectorSize, (id + 1) * miniSectorSize));
      return Buffer.concat(parts).subarray(0, entry.size);
    }
    return readChain(entry.start).subarray(0, entry.size);
  };
  const children = (storageIndex) => {
    const out = [];
    const stack = [entries[storageIndex]?.child];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === undefined || id === FREESECT || id >= entries.length || seen.has(id)) continue;
      seen.add(id);
      const e = entries[id];
      out.push(id);
      stack.push(e.left, e.right);
    }
    return out;
  };
  return { entries, readStream, children };
}

function msgProperties(cfb, storageIndex) {
  const props = {};
  for (const id of cfb.children(storageIndex)) {
    const entry = cfb.entries[id];
    const m = /^__substg1\.0_([0-9A-F]{4})([0-9A-F]{4})$/i.exec(entry.name);
    if (!m || entry.type !== 2) continue;
    const tag = m[1].toUpperCase();
    const type = m[2].toUpperCase();
    const data = cfb.readStream(entry);
    if (type === '001F') props[tag] = data.toString('utf16le').replace(/\0+$/, '');
    else if (type === '001E') props[tag] = decodeText(data).replace(/\0+$/, '');
    else if (type === '0102' && tag === '1013') props[tag] = decodeText(data);
  }
  return props;
}

async function extractMsg(filePath, originalName) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_IN_MEMORY_BYTES) return null;
  const cfb = readCompoundFile(await fsp.readFile(filePath));
  const props = msgProperties(cfb, 0);
  const recipients = [];
  const attachments = [];
  for (const id of cfb.children(0)) {
    const entry = cfb.entries[id];
    if (entry.type !== 1) continue;
    if (/^__recip_version1\.0_/i.test(entry.name)) {
      const r = msgProperties(cfb, id);
      recipients.push([r['3001'], r['39FE'] || r['3003']].filter(Boolean).join(' '));
    } else if (/^__attach_version1\.0_/i.test(entry.name)) {
      const a = msgProperties(cfb, id);
      attachments.push(a['3707'] || a['3704'] || a['3001'] || '(sin nombre)');
    }
  }
  const headers = props['007D'] ? parseHeaders(props['007D']) : {};
  const sender = [props['0C1A'], props['5D01'] || props['0C1F']].filter(Boolean).join(' ');
  const body = props['1000'] || htmlToText(props['1013']);
  return capText(renderEmail([
    ['De', sender || decodeEncodedWords(headers.from)],
    ['Para', props['0E04'] || recipients.join('; ') || decodeEncodedWords(headers.to)],
    ['CC', props['0E03']],
    ['Fecha', headers.date],
    ['Asunto', props['0037'] || decodeEncodedWords(headers.subject)],
  ], body, attachments, `Correo de Outlook (.msg) "${originalName}"`));
}

// ── MOBI / AZW (PalmDOC) ─────────────────────────────────────────────────

function palmDocDecompress(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const c = data[i++];
    if (c >= 1 && c <= 8) {
      for (let k = 0; k < c && i < data.length; k += 1) out.push(data[i++]);
    } else if (c < 0x80) {
      out.push(c);
    } else if (c >= 0xc0) {
      out.push(0x20, c ^ 0x80);
    } else if (i < data.length) {
      const pair = (c << 8) | data[i++];
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 7) + 3;
      for (let k = 0; k < length; k += 1) {
        const from = out.length - distance;
        out.push(from >= 0 ? out[from] : 0x20);
      }
    }
  }
  return Buffer.from(out);
}

function trailingEntriesSize(record, flags) {
  let size = 0;
  for (let bits = flags >> 1; bits; bits >>= 1) {
    if (!(bits & 1)) continue;
    let value = 0;
    for (let pos = record.length - size - 1, depth = 0; pos >= 0 && depth < 4; pos -= 1, depth += 1) {
      const b = record[pos];
      value |= (b & 0x7f) << (7 * depth);
      if (b & 0x80) break;
    }
    size += value;
  }
  if (flags & 1) size += (record[record.length - size - 1] & 0x3) + 1;
  return Math.min(size, record.length);
}

async function extractPalmEbook(filePath, originalName) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_IN_MEMORY_BYTES) return null;
  const buf = await fsp.readFile(filePath);
  if (buf.length < 86) return null;
  const count = buf.readUInt16BE(76);
  const offsets = [];
  for (let i = 0; i < count && 78 + i * 8 + 4 <= buf.length; i += 1) offsets.push(buf.readUInt32BE(78 + i * 8));
  offsets.push(buf.length);
  const record = (i) => buf.subarray(offsets[i], offsets[i + 1]);
  const r0 = record(0);
  const compression = r0.readUInt16BE(0);
  const textRecords = r0.readUInt16BE(8);
  const encryption = r0.readUInt16BE(12);
  const ext = extensionOf(originalName);
  if (encryption !== 0) {
    return `Libro electrónico .${ext} "${originalName}" protegido con DRM. Se guardó completo; su texto no puede leerse.`;
  }
  let encoding = 'cp1252';
  let extraFlags = 0;
  const title = buf.subarray(0, 32).toString('latin1').replace(/\0.*$/s, '').replace(/_/g, ' ');
  if (r0.length > 20 && r0.subarray(16, 20).toString('latin1') === 'MOBI') {
    const headerLength = r0.readUInt32BE(20);
    encoding = r0.readUInt32BE(28) === 65001 ? 'utf8' : 'cp1252';
    if (headerLength >= 0xe4 && r0.length >= 16 + 0xe4) extraFlags = r0.readUInt16BE(16 + 0xe2);
  }
  if (compression !== 1 && compression !== 2) {
    return `Libro electrónico .${ext} "${originalName}" ("${title}") guardado. Usa una compresión (HUFF/CDIC) que el servidor no descomprime; conviértelo a EPUB o PDF para leer su texto.`;
  }
  const parts = [];
  for (let i = 1; i <= textRecords && i < offsets.length - 1; i += 1) {
    let data = record(i);
    if (extraFlags) data = data.subarray(0, data.length - trailingEntriesSize(data, extraFlags));
    parts.push(compression === 2 ? palmDocDecompress(data) : data);
  }
  const raw = Buffer.concat(parts);
  const html = encoding === 'utf8' ? raw.toString('utf8') : decodeCharset(raw, 'windows-1252');
  const text = htmlToText(html.replace(/<mbp:pagebreak\s*\/?>/gi, '\n\n'));
  if (!text) return null;
  return `Libro electrónico .${ext} "${title || originalName}"\n---\n${capText(text)}`;
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Extract readable text for `originalName` stored at `filePath`.
 * Resolves `{ family, text }` (text may be null when nothing readable came
 * out); never rejects.
 */
async function extract(filePath, originalName) {
  const family = familyFor(originalName);
  if (!family) return { family: null, text: null };
  try {
    let text = null;
    if (family.startsWith('office-')) text = await extractOffice(filePath, originalName, family);
    else if (family === '7z') text = await extractSevenZip(filePath, originalName);
    else if (family === 'tar') text = await extractTar(filePath, originalName);
    else if (family === 'stream') text = await extractSingleStream(filePath, originalName);
    else if (family === 'email-msg') text = await extractMsg(filePath, originalName);
    else if (family === 'email-eml') text = await extractEml(filePath, originalName);
    else if (family === 'email-mbox') text = await extractMbox(filePath, originalName);
    else if (family === 'ebook-palm') text = await extractPalmEbook(filePath, originalName);
    return { family, text: text && String(text).trim() ? String(text) : null };
  } catch (error) {
    console.warn(`[universal-extract] ${family} failed for ${originalName}: ${error && error.message}`);
    return { family, text: null, error: String(error && error.message || error) };
  }
}

module.exports = {
  extract,
  handles,
  familyFor,
  extensionOf,
  // exported for tests
  parseEml,
  readCompoundFile,
  palmDocDecompress,
  trailingEntriesSize,
  runCapture,
  looksLikeText,
};
