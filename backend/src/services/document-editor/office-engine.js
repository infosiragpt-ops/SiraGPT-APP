'use strict';

/**
 * Edición milimétrica — Fase G: the chat document editor (/api/ai/document-edit
 * and the /generate edit pre-step, both through runChatDocumentEdit) runs on
 * the SAME engine as the AgentRunner:
 *
 *   - Excel / PowerPoint: the AgentRunner loop with the office tools
 *     (sira_office.py: inspect_document / office_edit / render_preview /
 *     verify_visual), the verification gate v2 and the vision review — with the
 *     model the user picked (its client comes from the editor). PDFs and other
 *     formats keep the sandbox doc-agent loop (its PDF skills);
 *   - Word: the docx engine keeps its form tools (fill_field, set_cell…), and
 *     its `finish` adds the same visual verification (render, changed zones,
 *     before/after composite, vision review) — makeOfficeVisualVerifier.
 *
 * Both stream stage v2 events (callId / kind / status / description / detail /
 * thumbs) for the one timeline. The adapter keeps the editor's contract with
 * its engine — { finalText, outputs: [{ name, buffer, valid }], steps,
 * stoppedReason } — so the behaviours around it (sources = latest version,
 * v2/v3 names, honest failures, batch publish) are unchanged.
 *
 * SIRAGPT_DOCUMENT_EDITOR_ENGINE: `office` (default) | `legacy` (the previous
 * sandbox doc-agent loop for Excel/PowerPoint too — rollback switch).
 * SIRAGPT_DOCUMENT_EDITOR_VISUAL_VERIFY=0 turns the Word visual step off.
 */

const path = require('path');

// Editor contracts (PRs #797–#810) for the office loop: the assistant authors
// requested content, edits in place, never annexes, never delivers unverified.
const EDITOR_RULES = [
  'DOCUMENT EDITOR RULES (this turn edits the user\'s document in place):',
  '- Edit the file you were given (uploads/…) and deliver ONE edited file under outputs/. Never rebuild the document; never append an annex, a new section, a summary table or a note instead of editing in place.',
  '- When the user asks you to add, fill or complete content (observaciones, comentarios, sugerencias, datos, conclusiones…), YOU write it: brief, professional, in the document\'s language, specific to each item and coherent with the existing marks (an X in SÍ → a favourable observation). Never leave placeholders and never ask the user to write it.',
  '- Do not invent PERSONAL data the user did not give (names, IDs, dates, figures): leave those fields as they are and say what is missing.',
  '- Forms and tables: write in the blank next to each label or in the right cell, without touching labels, check marks or layout.',
  '- Keep the format of every run you touch; change only what was asked.',
  '- The file you were given is the LATEST version of the conversation: continue from it, never from an older one.',
  '- Verify with verify_visual (before = the file you were given, after = your output). Answer in Spanish with the concrete list of changes; if something could not be done, say so plainly.',
].join('\n');

const AUTHOR_CONTENT_RULE = 'The user expects YOU to write that content (comments, observations, suggestions…); they will not provide it. Write a brief professional text for every item and apply it with office_edit.';

// sira_office edits OOXML packages; a PDF, .doc, .csv… keeps the doc-agent loop.
const OFFICE_ENGINE_EXT_RE = /\.(?:docx|docm|dotx|xlsx|xlsm|xltx|pptx|pptm|potx)$/i;

function officeEngineHandles(files = []) {
  const list = Array.isArray(files) ? files : [];
  return list.length > 0 && list.every((file) => file && OFFICE_ENGINE_EXT_RE.test(String(file.name || '')));
}

// Word edits the docx engine cannot express — first-line indent / spacing,
// tracked changes, paraphrases that must keep citation fields — run on the
// office engine (sira_office.py), like Excel and PowerPoint. The docx engine
// keeps forms, fields, check boxes and the content the assistant writes.
const OFFICE_ENGINE_WORD_RE = /\b(?:sangr[ií]as?|interlineado|espaciado entre|control de cambios|cambios controlados|track(?:ed)? changes|marcas de revisi[oó]n|parafrase\w*|par[aá]frasis)\b/i;

function wordNeedsOfficeEngine(instruction, env = process.env) {
  return officeEditorEnabled(env) && OFFICE_ENGINE_WORD_RE.test(String(instruction || ''));
}

function officeEditorEnabled(env = process.env) {
  const raw = String((env && env.SIRAGPT_DOCUMENT_EDITOR_ENGINE) || '').trim().toLowerCase();
  return !['legacy', 'doc-agent', 'docagent', '0', 'off'].includes(raw);
}

function visualVerifyEnabled(env = process.env) {
  const raw = String((env && env.SIRAGPT_DOCUMENT_EDITOR_VISUAL_VERIFY) || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return String((env && env.NODE_ENV) || '') !== 'test';
}

function authorsContent(instruction) {
  try {
    return require('../docx-engine/agent').requestAuthorsContent(instruction);
  } catch (_) {
    return false;
  }
}

/**
 * The last verify_visual of an office edit decides: an edit whose final
 * verification failed (or never ran) is not a deliverable.
 */
function lastVerificationPassed(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const edited = list.some((s) => s && s.tool === 'office_edit' && s.ok !== false);
  const verifies = list.filter((s) => s && s.tool === 'verify_visual');
  if (!edited) return verifies.length ? verifies[verifies.length - 1].ok !== false : true;
  if (!verifies.length) return false;
  return verifies[verifies.length - 1].ok !== false;
}

/**
 * Run one document edit on the office engine (Excel / PowerPoint).
 * @returns {Promise<{ finalText, outputs, steps, stoppedReason, iterations }>}
 */
async function runOfficeEditorEngine({
  files = [],
  instruction,
  client,
  model,
  signal,
  maxIterations,
  onEvent = () => {},
  userId = null,
  chatId = null,
  runAgentRunner = null,
} = {}) {
  const run = runAgentRunner || require('../agent-runner').runAgentRunner;
  const rules = authorsContent(instruction) ? `${EDITOR_RULES}\n- ${AUTHOR_CONTENT_RULE}` : EDITOR_RULES;
  const result = await run({
    files,
    instruction,
    model,
    client,
    signal,
    ...(maxIterations ? { maxIterations } : {}),
    onEvent,
    userId,
    chatId,
    systemAppend: rules,
  });
  const verified = lastVerificationPassed(result && result.steps);
  const outputs = (Array.isArray(result && result.outputs) ? result.outputs : []).map((out) => ({
    name: out.name,
    buffer: out.buffer,
    // Never deliver an edit whose last visual verification failed.
    valid: out.valid !== false && verified,
    ...(out.validation ? { validation: out.validation } : {}),
    ...(out.validation && out.validation.changes ? { changeReport: out.validation.changes } : {}),
  }));
  let noChanges = false;
  try { noChanges = require('../agent-runner').noChangesNeeded(result && result.steps); } catch (_) { noChanges = false; }
  return {
    finalText: result && result.finalText,
    outputs,
    steps: (result && result.steps) || [],
    stoppedReason: result && result.stoppedReason,
    iterations: result && result.iterations,
    verified,
    // Everything asked was already in the file: the model's answer says so.
    ...(noChanges ? { noChanges: true } : {}),
  };
}

function safeName(name, fallback) {
  const base = path.basename(String(name || fallback || 'documento.docx')).replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]+/g, '_').trim();
  return base || fallback || 'documento.docx';
}

/**
 * The AgentRunner's visual verification for the docx engine's `finish`:
 * sira_office.py verify in a sandbox session (changed parts, changed zones in
 * mm, before/after composite, text checks) + the vision review with a
 * checklist built from the request and the values the model says it wrote.
 * Returns { ok, checksOk, visionOk, text, issues[], thumbs[] } or
 * { ok: null, unavailable: true } when there is no sandbox / renderer.
 */
function makeOfficeVisualVerifier({
  pickedModel = null,
  env = process.env,
  createSandbox = null,
  visionVerifier = undefined,
  thumbs = true,
} = {}) {
  if (!visualVerifyEnabled(env)) return null;
  return async function officeVisualVerify({ originalBuffer, editedBuffer, filename, instruction, expectedValues = [], signal } = {}) {
    if (!Buffer.isBuffer(originalBuffer) || !Buffer.isBuffer(editedBuffer)) return { ok: null, unavailable: true };
    const office = require('../agent-runner/tools.office');
    const { thumbsToDataUrls } = require('../agent-runner/loop');
    const make = createSandbox || require('../doc-agent/sandbox').createSandbox;
    let verifier = visionVerifier;
    if (verifier === undefined) {
      try { verifier = require('../agent-runner').buildVisionVerifier({ pickedModel, env }); } catch (_) { verifier = null; }
    }
    const sandbox = await make({ signal });
    try {
      await sandbox.exec('mkdir -p /workspace/uploads /workspace/outputs /workspace/previews /workspace/tmp', { timeoutMs: 10_000, signal });
      if (!(await office.installOfficeEngine(sandbox))) return { ok: null, unavailable: true };
      const name = safeName(filename, 'documento.docx');
      const ext = path.extname(name) || '.docx';
      const beforeRel = `uploads/original${ext}`;
      const afterRel = `outputs/editado${ext}`;
      await sandbox.writeFile(beforeRel, originalBuffer);
      await sandbox.writeFile(afterRel, editedBuffer);
      let seen = null;
      const executors = office.makeOfficeToolExecutors(sandbox, {
        visionVerifier: verifier || null,
        thumbs,
        onVerify: (v) => { seen = v; },
      });
      const checklist = [
        `Pedido del usuario: ${String(instruction || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`,
        ...(Array.isArray(expectedValues) ? expectedValues : [])
          .map((v) => String(v || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 8)
          .map((v) => `Se ve «${v.slice(0, 120)}» en el documento`),
        'No cambia nada más del documento',
      ];
      const out = await executors.verify_visual({ before: beforeRel, after: afterRel, checklist }, { signal });
      const text = typeof out === 'string' ? out : String((out && out.text) || '');
      if (/renderer_unavailable|no está instalado/.test(text)) return { ok: null, unavailable: true, text };
      const passed = !text.startsWith('ERROR') && !/NO VERIFICADO/.test(text);
      const issues = passed ? [] : text.split('\n')
        .filter((line) => /✗|no pasó|NO VERIFICADO|falló/i.test(line))
        .map((line) => `Revisión visual: ${line.replace(/^[•\s]+/, '').trim()}`)
        .slice(0, 6);
      return {
        ok: passed,
        checksOk: seen ? seen.checksOk : null,
        visionOk: seen ? seen.visionOk : null,
        text,
        issues,
        thumbs: thumbsToDataUrls(out && typeof out === 'object' ? out.__thumbs : null) || [],
      };
    } finally {
      try { await sandbox.destroy(); } catch (_) { /* best effort */ }
    }
  };
}

module.exports = {
  EDITOR_RULES,
  AUTHOR_CONTENT_RULE,
  officeEditorEnabled,
  officeEngineHandles,
  wordNeedsOfficeEngine,
  visualVerifyEnabled,
  lastVerificationPassed,
  runOfficeEditorEngine,
  makeOfficeVisualVerifier,
};
