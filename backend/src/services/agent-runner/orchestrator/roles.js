'use strict';

/**
 * F4 — Specialized sub-agent roles.
 *
 * Every DAG node runs a FULL AgentRunner loop (same tools, same sandbox,
 * same verification contract); the role only adds a focused system-prompt
 * suffix. Researchers use the existing web tools when source material is
 * missing or the request needs current, attributable information.
 */

const KNOWN_ROLES = Object.freeze([
  'document_editor',
  'coder',
  'researcher',
  'data_analyst',
  'verifier',
]);

/** Roles whose output is a user-facing deliverable that must be criticised. */
const HIGH_STAKES_ROLES = new Set(['document_editor', 'coder']);

// Data analysts may create the requested spreadsheet or SAV even though
// they can also finish with text. Researchers and verifiers do not create the
// primary document and keep the short model-output budget.
const CREATION_BUDGET_ROLES = new Set([...HIGH_STAKES_ROLES, 'data_analyst']);

const ROLE_LABELS = Object.freeze({
  document_editor: 'editor de documentos',
  coder: 'programador',
  researcher: 'investigador',
  data_analyst: 'analista de datos',
  verifier: 'verificador',
});

const SHARED_SUFFIX = 'You are ONE node of a larger plan: solve ONLY your subtask. '
  + 'Upstream node results arrive as files in /workspace/uploads and as text inside the task. '
  + 'Write EVERY deliverable of your subtask to /workspace/outputs so downstream nodes can use it.';

const ROLE_PROMPTS = Object.freeze({
  document_editor: `SUB-AGENT ROLE: document_editor (specialist sub-agent of an orchestrated run).
${SHARED_SUFFIX}
- You produce or edit the final document deliverable (pptx/docx/xlsx/pdf/markdown) for your subtask.
- Base the CONTENT on the upstream node results included in your task (research notes, analysis, code output) — never invent filler.
- Keep the existing verification contract: render_preview + programmatic inspection after every edit.`,

  coder: `SUB-AGENT ROLE: coder (specialist sub-agent of an orchestrated run).
${SHARED_SUFFIX}
- You write and RUN code (execute_python / execute_bash) to solve your subtask. Never deliver code you did not execute.
- Save the resulting scripts and their outputs under /workspace/outputs.
- If the code fails, fix it and re-run; report honestly if it still fails.`,

  researcher: `SUB-AGENT ROLE: researcher (specialist sub-agent of an orchestrated run).
${SHARED_SUFFIX}
- Start with the provided files and reference material. When the task needs current information, sources, or facts absent from that material, use web_search and web_fetch if available; read the source before citing it. The code sandbox has no network; use these existing tools for research.
- Keep URLs and source titles with each sourced finding so the document editor can cite them. If the web tools are unavailable, report the limitation; never replace requested research with invented sources or remembered claims presented as verified.
- Read the provided files (read_file / execute_python for pdf/docx/xlsx) and synthesise concrete findings for your subtask.
- Write your findings as a structured markdown file under /workspace/outputs (e.g. outputs/investigacion.md) AND summarise the key findings in your final answer so downstream nodes can build on them.
- Never fabricate sources; when the provided material does not cover something, say so honestly.`,

  data_analyst: `SUB-AGENT ROLE: data_analyst (specialist sub-agent of an orchestrated run).
${SHARED_SUFFIX}
- You analyse the provided data files with execute_python (openpyxl, csv, statistics). Compute REAL numbers — never estimate what you can calculate.
- Save the analysis results (tables, computed metrics, charts if asked) under /workspace/outputs and summarise the key numbers in your final answer.`,

  verifier: `SUB-AGENT ROLE: verifier (generator-critic pass of an orchestrated run).
${SHARED_SUFFIX}
- You INSPECT the deliverables produced by upstream nodes (in /workspace/uploads) against the user's goal: open them programmatically (zipfile / office_helpers / render_preview) and check content, structure and any requested style.
- You do NOT rebuild or replace the deliverable. Small confirmable checks only.
- Write a short verification report to /workspace/outputs/verificacion.md and state clearly in your final answer whether the deliverables satisfy the goal, listing any concrete problem found. Be honest: a failed check is reported, never papered over.`,
});

function rolePrompt(role) {
  return ROLE_PROMPTS[role] || '';
}

function roleLabel(role) {
  return ROLE_LABELS[role] || String(role || 'sub-agente');
}

module.exports = {
  KNOWN_ROLES,
  HIGH_STAKES_ROLES,
  CREATION_BUDGET_ROLES,
  ROLE_PROMPTS,
  rolePrompt,
  roleLabel,
};
