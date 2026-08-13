'use strict';

/**
 * Verification gate for the AgentRunner loop.
 *
 * After any file-mutating tool the model MUST call render_preview and
 * inspect the result before it is allowed to declare success. This closes
 * "dijo que lo hizo pero el preview siguió oscuro".
 */

const MAX_VERIFICATION_RETRIES = 3;

const EDIT_TOOLS = new Set([
  'execute_python',
  'execute_bash',
  'bash',
  'write_file',
  'str_replace',
  'set_slide_background',
  'create_presentation',
]);

function lastIndex(steps, pred) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (pred(steps[i])) return i;
  }
  return -1;
}

function looksLikeSuccessClaim(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /\b(listo|hecho|ready|done|completé|complete|éxito|exito|verificado|applied|apliqué|aplique)\b/i.test(t);
}

/**
 * @param {Array<{ tool: string, ok?: boolean }>} steps
 * @returns {{ needed: boolean, reason: string|null }}
 */
function needsVerification(steps = []) {
  const lastEdit = lastIndex(steps, (s) => EDIT_TOOLS.has(s.tool) && s.ok !== false);
  if (lastEdit === -1) return { needed: false, reason: null };
  const lastPreview = lastIndex(steps, (s) => s.tool === 'render_preview');
  if (lastPreview < lastEdit) {
    return { needed: true, reason: 'missing_preview' };
  }
  const preview = steps[lastPreview];
  if (preview && preview.ok === false) {
    return { needed: true, reason: 'preview_failed' };
  }
  return { needed: false, reason: null };
}

function verificationNudge(attempt, reason) {
  const n = Math.max(1, Number(attempt) || 1);
  const why = reason === 'preview_failed'
    ? 'render_preview failed or did not confirm the change.'
    : 'You edited a file but did not call render_preview afterwards.';
  return [
    `VERIFICATION REQUIRED (attempt ${n}/${MAX_VERIFICATION_RETRIES}). ${why}`,
    'You MUST now:',
    '1) call render_preview on the output file under /workspace/outputs',
    '2) reopen the file with execute_python and assert the change is really present (hex in XML, slide count, text, etc.)',
    '3) if verification fails, retry the edit. Do NOT claim success yet.',
    'If this is the last attempt and it still fails, report the error honestly in Spanish — never pretend it worked.',
  ].join('\n');
}

module.exports = {
  MAX_VERIFICATION_RETRIES,
  EDIT_TOOLS,
  needsVerification,
  verificationNudge,
  looksLikeSuccessClaim,
};
