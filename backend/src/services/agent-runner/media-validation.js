'use strict';

// The server reopens the exact bytes it is about to persist. A filename,
// model-authored JSON or a plausible MP4 header is never validation evidence.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MEDIA_PROOF = Symbol('agent-runner-media-proof');
const MEDIA_PATH_RE = /\.(mp3|mp4)$/i;
const MAX_BYTES = 100 * 1024 * 1024;

function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function digest(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function readerSource() {
  // Read the trusted packaged helper, never the copy writable by the model in
  // /workspace/tmp. -I also prevents a local json.py/subprocess.py shadowing it.
  const source = fs.readFileSync(path.join(__dirname, 'sira_convert.py')).toString('base64');
  return [
    'import base64,json,sys',
    'try:',
    '    namespace = {"__name__": "sira_conversion_validator"}',
    `    exec(base64.b64decode(${JSON.stringify(source)}), namespace)`,
    '    result = namespace["verify_media_file"](sys.argv[1], expected_sha256=sys.argv[2])',
    '    print(json.dumps({"ok": True, **result}))',
    'except Exception as error:',
    '    reason = "media_reader_unavailable" if getattr(error, "code", None) in ("E_PROVIDER", "E_TIMEOUT") else "media_unreadable"',
    '    print(json.dumps({"ok": False, "reason": reason}))',
  ].join('\n');
}

async function validateMediaOutput(sandbox, output) {
  if (!MEDIA_PATH_RE.test(String(output?.name || '')) || !Buffer.isBuffer(output?.buffer)
    || output.buffer.length === 0 || output.buffer.length > MAX_BYTES) return { ok: false, reason: 'media_unreadable' };
  if (typeof sandbox?.putFile !== 'function' || typeof sandbox?.exec !== 'function') {
    return { ok: false, reason: 'media_reader_unavailable' };
  }
  const buffer = Buffer.from(output.buffer);
  const hash = digest(buffer);
  const extension = path.extname(output.name).toLowerCase();
  const relative = `tmp/validate-media-${crypto.randomBytes(8).toString('hex')}${extension}`;
  const absolute = `/workspace/${relative}`;
  try {
    await sandbox.putFile(relative, buffer);
    const run = await sandbox.exec(`python3 -I -c ${quote(readerSource())} ${quote(absolute)} ${quote(hash)}`, { timeoutMs: 125000 });
    if (run?.timedOut || run?.exitCode !== 0) return { ok: false, reason: 'media_reader_unavailable' };
    let result;
    try { result = JSON.parse(String(run.stdout || '').trim().split('\n').at(-1)); }
    catch { return { ok: false, reason: 'media_reader_unavailable' }; }
    if (result?.ok !== true) {
      return { ok: false, reason: result?.reason === 'media_unreadable' ? result.reason : 'media_reader_unavailable' };
    }
    const streams = result.streams;
    if (result.sha256 !== hash || result.decoded !== true || !Number.isFinite(result.duration_seconds)
      || result.duration_seconds <= 0 || result.duration_seconds > 1200
      || !Array.isArray(streams) || !streams.length || streams.length > 32
      || streams.some((stream) => !['audio', 'video'].includes(stream?.type) || !/^[a-z0-9_]{1,30}$/i.test(stream?.codec || ''))
      || (extension === '.mp3' && !streams.some((stream) => stream.type === 'audio' && stream.codec === 'mp3'))
      || (extension === '.mp4' && !streams.some((stream) => stream.type === 'video'))) {
      return { ok: false, reason: 'media_reader_unavailable' };
    }
    Object.defineProperty(output, MEDIA_PROOF, { value: `${extension}:${hash}`, configurable: true });
    return { ok: true, validation: {
      ok: true, passed: true, engine: 'ffmpeg', scope: 'full_media_decode',
      media: { durationSeconds: result.duration_seconds, streams, decoded: true },
    } };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError'
      || ['ABORT_ERR', 'ABORTED', 'E_CANCELLED', 'OPERATION_TIMEOUT'].includes(error?.code)) throw error;
    return { ok: false, reason: 'media_reader_unavailable' };
  } finally {
    try { await sandbox.exec(`rm -f ${quote(absolute)}`, { timeoutMs: 5000 }); } catch { /* sandbox cleanup is best effort */ }
  }
}

function hasVerifiedMediaBytes(output) {
  return Buffer.isBuffer(output?.buffer) && output.validation?.passed === true
    && typeof output[MEDIA_PROOF] === 'string'
    && output[MEDIA_PROOF] === `${path.extname(String(output.name || '')).toLowerCase()}:${digest(output.buffer)}`;
}

module.exports = { validateMediaOutput, hasVerifiedMediaBytes, MEDIA_PATH_RE };
