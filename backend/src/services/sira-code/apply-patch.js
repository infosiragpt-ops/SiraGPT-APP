'use strict';

/**
 * Workspace patch language for SiraCode.
 *
 * Contract inspired by OpenCode's apply_patch envelope (anomalyco/opencode,
 * MIT): Begin/End Patch, Add/Update/Delete File, unique hunks. Native
 * implementation — not a copy of vendor/opencode/src/tool/apply_patch.ts.
 */

function toolError(code, message) {
  return { ok: false, code, error: message, content: `ERROR: ${message}` };
}

function parsePatch(input) {
  const lines = String(input || '').replace(/\r\n/g, '\n').split('\n');
  const hasEnvelope = lines.some((line) => line.trim() === '*** Begin Patch');
  const ops = [];
  let current = null;
  let inPatch = !hasEnvelope;

  const startOp = (op) => {
    current = op;
    ops.push(op);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '*** Begin Patch') {
      inPatch = true;
      current = null;
      continue;
    }
    if (trimmed === '*** End Patch') {
      inPatch = false;
      current = null;
      continue;
    }
    if (!inPatch) continue;

    const add = trimmed.match(/^\*\*\* Add File:\s+(.+)$/);
    if (add) {
      startOp({ type: 'add', path: add[1].trim(), body: [] });
      continue;
    }
    const del = trimmed.match(/^\*\*\* Delete File:\s+(.+)$/);
    if (del) {
      startOp({ type: 'delete', path: del[1].trim() });
      current = null;
      continue;
    }
    const upd = trimmed.match(/^\*\*\* Update File:\s+(.+)$/);
    if (upd) {
      startOp({ type: 'update', path: upd[1].trim(), moveTo: null, hunks: [[]] });
      continue;
    }
    const move = trimmed.match(/^\*\*\* Move to:\s+(.+)$/);
    if (move && current && current.type === 'update') {
      current.moveTo = move[1].trim();
      continue;
    }
    if (!current) continue;
    if (current.type === 'add') {
      current.body.push(line.startsWith('+') ? line.slice(1) : line);
      continue;
    }
    if (current.type === 'update') {
      if (line.startsWith('@@')) {
        if (current.hunks[current.hunks.length - 1].length) current.hunks.push([]);
        continue;
      }
      current.hunks[current.hunks.length - 1].push(line);
    }
  }
  return ops;
}

function hunkToOldNew(hunkLines) {
  const oldLines = [];
  const newLines = [];
  for (const line of hunkLines) {
    if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith('-')) oldLines.push(line.slice(1));
    else {
      const ctx = line.startsWith(' ') ? line.slice(1) : line;
      oldLines.push(ctx);
      newLines.push(ctx);
    }
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

function applyUnique(haystack, oldText, newText) {
  if (!oldText) {
    const err = new Error('hunk vacío o sin contexto');
    err.code = 'hunk_empty';
    throw err;
  }
  const count = haystack.split(oldText).length - 1;
  if (count === 0) {
    const err = new Error('el hunk no coincide con el archivo');
    err.code = 'hunk_miss';
    throw err;
  }
  if (count > 1) {
    const err = new Error('el hunk aparece más de una vez');
    err.code = 'hunk_ambiguous';
    throw err;
  }
  return haystack.replace(oldText, newText);
}

async function applyPatchToWorkspace(workspace, input) {
  const ops = parsePatch(input);
  if (!ops.length) return toolError('validation', 'el parche no tiene operaciones');
  const done = [];
  for (const op of ops) {
    if (op.type === 'add') {
      const rel = op.path;
      if (!rel) return toolError('validation', 'Add File requiere path');
      try {
        await workspace.readFile(rel);
        return toolError('file_exists', `${rel} ya existe`);
      } catch (err) {
        if (err && err.code === 'path_traversal') return toolError(err.code, err.message);
      }
      const saved = await workspace.writeFile(rel, op.body.join('\n'));
      done.push(`add ${saved}`);
      continue;
    }
    if (op.type === 'delete') {
      if (!op.path) return toolError('validation', 'Delete File requiere path');
      try {
        const removed = await workspace.removeFile(op.path);
        done.push(`delete ${removed}`);
      } catch (err) {
        return toolError(err.code || 'delete_failed', err.message || 'delete failed');
      }
      continue;
    }
    if (op.type === 'update') {
      if (!op.path) return toolError('validation', 'Update File requiere path');
      let current;
      try {
        current = await workspace.readFile(op.path);
      } catch (err) {
        return toolError(err.code || 'read_failed', err.message || 'read failed');
      }
      try {
        for (const hunk of op.hunks) {
          if (!hunk.length) continue;
          const { oldText, newText } = hunkToOldNew(hunk);
          current = applyUnique(current, oldText, newText);
        }
      } catch (err) {
        return toolError(err.code || 'hunk_failed', `${op.path}: ${err.message}`);
      }
      const saved = await workspace.writeFile(op.path, current);
      if (op.moveTo && op.moveTo !== op.path) {
        await workspace.writeFile(op.moveTo, current);
        try {
          await workspace.removeFile(op.path);
        } catch (err) {
          return toolError(err.code || 'move_failed', err.message || 'move failed');
        }
        done.push(`update ${saved} -> ${op.moveTo}`);
      } else {
        done.push(`update ${saved}`);
      }
    }
  }
  return { ok: true, content: done.join('\n'), operations: done };
}

module.exports = {
  parsePatch,
  hunkToOldNew,
  applyUnique,
  applyPatchToWorkspace,
};
