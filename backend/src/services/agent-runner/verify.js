'use strict';

/**
 * Verification gate for the AgentRunner loop.
 *
 * After any file-mutating tool the model MUST verify the result before it is
 * allowed to declare success. This closes "dijo que lo hizo pero el preview
 * siguió oscuro".
 *
 * Gate v2 (edición milimétrica, docs/specs/edicion-milimetrica/SPEC.md §6.2),
 * with the office engine on (SIRAGPT_OFFICE_ENGINE !== '0'):
 *   - a generic edit that touched an OFFICE file (office_edit, or
 *     execute_python/bash whose outputs snapshot shows a changed
 *     .docx/.xlsx/.pptx) must be followed by `verify_visual`; a render alone
 *     no longer counts (hallazgo 4);
 *   - execute_python/bash that did not change /workspace/outputs is NOT an
 *     edit (hallazgo 5: reading a file must not re-arm the gate);
 *   - every other edit (a .md a sub-agent wrote, the deterministic
 *     set_slide_background / create_presentation tools, or an exec step whose
 *     snapshot is unknown) keeps the previous rule: render_preview or
 *     verify_visual after it;
 *   - verify_visual failing because the sandbox has no renderer ends the turn
 *     honestly as «Sin verificación visual» instead of burning retries.
 * With the engine off the previous gate applies unchanged.
 */

const MAX_VERIFICATION_RETRIES = 3;

const EDIT_TOOLS = new Set([
  'execute_python',
  'execute_bash',
  'bash',
  'write_file',
  'str_replace',
  'edit_file',
  'set_slide_background',
  'create_presentation',
  'office_edit',
]);

const EXEC_TOOLS = new Set(['execute_python', 'execute_bash', 'bash']);
const VISUAL_VERIFY = 'verify_visual';
const OFFICE_PATH_RE = /\.(docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|potx)$/i;
const SAV_PATH_RE = /\.sav$/i;
const { MEDIA_PATH_RE } = require('./media-validation');
const RENDERER_UNAVAILABLE_RE = /no está instalado|renderer_unavailable|no hay pdftoppm/i;

function officeEngineOn(env = process.env) {
  return String((env && env.SIRAGPT_OFFICE_ENGINE) ?? '').trim() !== '0';
}

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

/** A step that really changed a deliverable. */
function isRealEdit(step) {
  if (!step || !EDIT_TOOLS.has(step.tool) || step.ok === false) return false;
  // office_edit that left the file byte-identical: nothing to verify.
  if (step.tool === 'office_edit' && /^\{"unchanged":true/.test(String(step.resultPreview || ''))) return false;
  // execute_python/bash that did not change outputs/ only READ (hallazgo 5).
  // `mutated` undefined = unknown snapshot → conservative: counts as an edit.
  if (EXEC_TOOLS.has(step.tool) && step.mutated === false) return false;
  return true;
}

/** A real edit that touched an office file (the strict visual gate applies). */
function isOfficeEdit(step) {
  if (!isRealEdit(step)) return false;
  if (step.tool === 'office_edit') return true;
  if (EXEC_TOOLS.has(step.tool)) {
    return Array.isArray(step.changedOutputs) && step.changedOutputs.some((p) => OFFICE_PATH_RE.test(String(p)));
  }
  // Text tools (write_file / edit_file / str_replace) edit text or extracted
  // XML; the rezip into outputs/ happens in an exec step the snapshot sees.
  // set_slide_background / create_presentation: deterministic, tested
  // generators — the previous render rule still applies to them.
  return false;
}

function outputPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/workspace\//, '');
}

function officeOutputPaths(step) {
  if (EXEC_TOOLS.has(step.tool) && Array.isArray(step.changedOutputs)) {
    return step.changedOutputs.map(outputPath).filter((path) => OFFICE_PATH_RE.test(path));
  }
  if (step.tool === 'office_edit') {
    let dst = step.args?.dst;
    if (!dst) {
      try { dst = JSON.parse(String(step.resultPreview || '')).dst; } catch { /* legacy result */ }
    }
    const path = outputPath(dst);
    return OFFICE_PATH_RE.test(path) ? [path] : [];
  }
  return [];
}

function isSavMutation(step) {
  return isRealEdit(step) && EXEC_TOOLS.has(step.tool)
    && Array.isArray(step.changedOutputs)
    && step.changedOutputs.length > 0
    && step.changedOutputs.every((path) => SAV_PATH_RE.test(outputPath(path)));
}

function isMediaMutation(step) {
  return isRealEdit(step) && EXEC_TOOLS.has(step.tool)
    && Array.isArray(step.changedOutputs) && step.changedOutputs.length > 0
    && step.changedOutputs.every((path) => MEDIA_PATH_RE.test(outputPath(path)));
}

function legacyGate(steps) {
  const lastEdit = lastIndex(steps, (s) => EDIT_TOOLS.has(s.tool) && s.ok !== false && !isMediaMutation(s));
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

/**
 * @param {Array<{ tool: string, ok?: boolean, mutated?: boolean, changedOutputs?: string[], args?: object, renderUnavailable?: boolean }>} steps
 * @returns {{ needed: boolean, reason: string|null, terminal?: boolean }}
 */
function needsVerification(steps = [], { strict = officeEngineOn() } = {}) {
  if (!strict) return legacyGate(steps);
  const list = Array.isArray(steps) ? steps : [];

  const lastOfficeEdit = lastIndex(list, isOfficeEdit);
  if (lastOfficeEdit !== -1) {
    const latestMutation = new Map();
    let latestUnknownPath = -1;
    for (let i = 0; i < list.length; i += 1) {
      if (!isOfficeEdit(list[i])) continue;
      const paths = officeOutputPaths(list[i]);
      if (paths.length === 0) latestUnknownPath = i;
      else for (const path of paths) latestMutation.set(path, i);
    }
    const verdict = (verify) => {
      if (verify.ok !== false) return null;
      if (verify.renderUnavailable) return { needed: true, reason: 'renderer_unavailable', terminal: true };
      return { needed: true, reason: 'visual_checks_failed' };
    };
    for (const [path, editedAt] of latestMutation) {
      let verifiedAt = -1;
      for (let i = list.length - 1; i > editedAt; i -= 1) {
        if (list[i]?.tool === VISUAL_VERIFY && outputPath(list[i].args?.after) === path) {
          verifiedAt = i;
          break;
        }
      }
      if (verifiedAt === -1) return { needed: true, reason: 'missing_visual_verify' };
      const failed = verdict(list[verifiedAt]);
      if (failed) return failed;
      // A generated Office file needs a parser readback as well as a render.
      // verify_visual with an empty `expect` can otherwise approve appearance
      // without opening cells/text from the saved output itself.
      if (EXEC_TOOLS.has(list[editedAt].tool)) {
        const inspectedAt = lastIndex(list, (step) => step?.tool === 'inspect_document'
          && step.ok !== false && outputPath(step.args?.path) === path);
        if (inspectedAt <= editedAt) return { needed: true, reason: 'missing_document_inspection' };
      }
    }
    if (latestUnknownPath !== -1) {
      const lastVerify = lastIndex(list, (step) => step?.tool === VISUAL_VERIFY);
      if (lastVerify < latestUnknownPath) return { needed: true, reason: 'missing_visual_verify' };
      const failed = verdict(list[lastVerify]);
      if (failed) return failed;
    }
  }

  // SAV has no visual renderer. Ignore only a tool step that changed SAV
  // outputs exclusively; collectValidOutputs reopens those exact bytes with
  // pyreadstat before persistence. Office and other outputs still need their
  // own verification, regardless of the order in which SAV was generated.
  // MP3/MP4 also have no Office renderer. Only an exclusively-media step is
  // exempt: collection fully decodes its actual bytes before persistence.
  const lastEdit = lastIndex(list, (step) => isRealEdit(step) && !isSavMutation(step) && !isMediaMutation(step));
  if (lastEdit === -1 || lastEdit <= lastOfficeEdit) return { needed: false, reason: null };
  const lastCheck = lastIndex(list, (s) => s && (s.tool === 'render_preview' || s.tool === VISUAL_VERIFY));
  if (lastCheck < lastEdit) return { needed: true, reason: 'missing_preview' };
  if (list[lastCheck].ok === false) return { needed: true, reason: 'preview_failed' };
  return { needed: false, reason: null };
}

function verificationNudge(attempt, reason) {
  const n = Math.max(1, Number(attempt) || 1);
  if (reason === 'missing_visual_verify') {
    return [
      `VERIFICATION REQUIRED (attempt ${n}/${MAX_VERIFICATION_RETRIES}). An Office output still needs verify_visual after its latest change.`,
      'Call verify_visual NOW for EACH changed Office output: after=<that exact file in outputs/>, checklist=<one item per requirement>, expect=<content/cell checks>. For an edit set before=<source>; for a NEW file omit before.',
      'A render alone is not verification. Do NOT claim success yet.',
    ].join('\n');
  }
  if (reason === 'visual_checks_failed') {
    return [
      `VERIFICATION FAILED (attempt ${n}/${MAX_VERIFICATION_RETRIES}). verify_visual marked items with ✗.`,
      'Fix ONLY those items (office_edit for an existing file, execute_python for a new file), then call verify_visual again on the exact output.',
      'If this is the last attempt and it still fails, report plainly in Spanish what could not be achieved — never pretend it worked.',
    ].join('\n');
  }
  if (reason === 'missing_document_inspection') {
    return [
      `VERIFICATION REQUIRED (attempt ${n}/${MAX_VERIFICATION_RETRIES}). A generated Office file has not been reopened after its latest change.`,
      'Call inspect_document NOW with path=<that exact output in outputs/> for EACH generated Office file, inspect the returned content, and also call verify_visual on the same file. Do NOT claim success yet.',
    ].join('\n');
  }
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

/** The verify_visual result says the sandbox cannot render (no soffice/poppler/engine). */
function isRendererUnavailable(result) {
  return RENDERER_UNAVAILABLE_RE.test(String(result || '').slice(0, 600));
}

module.exports = {
  MAX_VERIFICATION_RETRIES,
  EDIT_TOOLS,
  OFFICE_PATH_RE,
  needsVerification,
  verificationNudge,
  looksLikeSuccessClaim,
  isRealEdit,
  isOfficeEdit,
  isRendererUnavailable,
};
