'use strict';

// Validate the exact bytes collected for delivery inside AgentRunner's
// existing isolated document sandbox. A $FL2 header is not a readable SAV.
const crypto = require('node:crypto');

const SAV_PROOF = Symbol('agent-runner-sav-proof');
const SAFE_REASONS = new Set(['sav_unreadable', 'sav_reader_unavailable']);

const READER_SOURCE = [
  'import json, sys',
  'try:',
  '    import pyreadstat',
  '    frame, metadata = pyreadstat.read_sav(sys.argv[1])',
  '    rows, columns = frame.shape',
  '    if rows < 1 or columns < 1: raise ValueError("empty SAV table")',
  '    print(json.dumps({"ok": True, "rowCount": int(rows), "columnCount": int(columns), "labelCount": sum(bool(label) for label in (metadata.column_labels or []))}))',
  'except ImportError:',
  '    print(json.dumps({"ok": False, "reason": "sav_reader_unavailable"}))',
  'except Exception:',
  '    print(json.dumps({"ok": False, "reason": "sav_unreadable"}))',
].join('\n');

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function validateSavOutput(sandbox, output) {
  if (!Buffer.isBuffer(output?.buffer) || output.buffer.length === 0) {
    return { ok: false, reason: 'sav_unreadable' };
  }
  if (typeof sandbox?.putFile !== 'function' || typeof sandbox?.exec !== 'function') {
    return { ok: false, reason: 'sav_reader_unavailable' };
  }

  const relative = `tmp/validate-sav-${crypto.randomBytes(8).toString('hex')}.sav`;
  const absolute = `/workspace/${relative}`;
  try {
    await sandbox.putFile(relative, output.buffer);
    const run = await sandbox.exec(`python3 -c ${quoteShell(READER_SOURCE)} ${quoteShell(absolute)}`, { timeoutMs: 15000 });
    if (run?.timedOut || run?.exitCode !== 0) return { ok: false, reason: 'sav_reader_unavailable' };
    let result;
    try { result = JSON.parse(String(run.stdout || '').trim().split('\n').at(-1)); }
    catch { return { ok: false, reason: 'sav_reader_unavailable' }; }
    if (result?.ok !== true) {
      return { ok: false, reason: SAFE_REASONS.has(result?.reason) ? result.reason : 'sav_reader_unavailable' };
    }
    if (!Number.isSafeInteger(result.rowCount) || result.rowCount < 1
      || !Number.isSafeInteger(result.columnCount) || result.columnCount < 1
      || !Number.isSafeInteger(result.labelCount) || result.labelCount < 0) {
      return { ok: false, reason: 'sav_reader_unavailable' };
    }
    Object.defineProperty(output, SAV_PROOF, { value: digest(output.buffer), configurable: true });
    return {
      ok: true,
      validation: {
        ok: true, passed: true, engine: 'pyreadstat', scope: 'full_sav_read',
        spss: { rowCount: result.rowCount, columnCount: result.columnCount, labelCount: result.labelCount },
      },
    };
  } catch {
    return { ok: false, reason: 'sav_reader_unavailable' };
  } finally {
    try { await sandbox.exec(`rm -f ${quoteShell(absolute)}`, { timeoutMs: 5000 }); } catch { /* best effort */ }
  }
}

function hasVerifiedSavBytes(output) {
  return Buffer.isBuffer(output?.buffer)
    && output.validation?.passed === true
    && typeof output[SAV_PROOF] === 'string'
    && output[SAV_PROOF] === digest(output.buffer);
}

module.exports = { validateSavOutput, hasVerifiedSavBytes };
