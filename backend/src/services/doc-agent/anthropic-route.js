'use strict';

/**
 * Route A — Anthropic sandbox (fast lane).
 *
 * Shares the SAME orchestration layer as Route B (doc-agent/index.js): the
 * caller builds { files, instruction } and gets back { outputs, finalText },
 * so the frontend never changes when the engine is swapped.
 *
 * Protocol (per Anthropic docs — verify version strings before shipping):
 *   1. Files API upload (beta files-api-2025-04-14) → file_id
 *   2. messages.create with container.skills [{ type:'anthropic', skill_id,
 *      version:'latest' }], tools [code_execution_20260521], beta header
 *      code-execution-2025-08-25. Container has no network and no
 *      runtime package installs.
 *   3. Walk res.content, take the generated file_id, Files API download.
 *
 * Container limits to verify against current docs: ~1 GiB RAM, ~5 GiB disk,
 * 1 CPU, no internet, expiry ~1h after creation; container files/outputs
 * retained up to ~30 days — relevant because SiraGPT handles third-party
 * theses.
 *
 * Dormant unless ANTHROPIC_API_KEY is set. Pure fetch — no new npm deps.
 */

const ANTHROPIC_SKILL_IDS = Object.freeze({
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  pdf: 'pdf',
});

const CODE_EXECUTION_BETA = 'code-execution-2025-08-25';
const FILES_API_BETA = 'files-api-2025-04-14';
const CODE_EXECUTION_TOOL = Object.freeze({ type: 'code_execution_20260521', name: 'code_execution' });

function isAnthropicRouteAvailable(env = process.env) {
  return Boolean(env && env.ANTHROPIC_API_KEY);
}

function skillIdForFileName(name = '') {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (ext === 'doc' || ext === 'docx') return ANTHROPIC_SKILL_IDS.docx;
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return ANTHROPIC_SKILL_IDS.xlsx;
  if (ext === 'ppt' || ext === 'pptx') return ANTHROPIC_SKILL_IDS.pptx;
  if (ext === 'pdf') return ANTHROPIC_SKILL_IDS.pdf;
  return null;
}

function buildAnthropicRequest({ instruction, fileId, skillId, model, system }) {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': '$ANTHROPIC_API_KEY',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': `${CODE_EXECUTION_BETA},${FILES_API_BETA}`,
      'content-type': 'application/json',
    },
    body: {
      model: model || process.env.SIRAGPT_ANTHROPIC_DOC_MODEL || 'claude-opus-4-6',
      max_tokens: 16000,
      container: { skills: [{ type: 'anthropic', skill_id: skillId, version: 'latest' }] },
      tools: [{ ...CODE_EXECUTION_TOOL }],
      system: system || undefined,
      messages: [{
        role: 'user',
        content: [
          { type: 'container_upload', file_id: fileId },
          { type: 'text', text: String(instruction || '') },
        ],
      }],
    },
  };
}

/** Extract generated file ids from a messages.create response body. */
function extractOutputFileIds(responseBody = {}) {
  const out = [];
  const content = Array.isArray(responseBody.content) ? responseBody.content : [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.file_id === 'string') out.push(node.file_id);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  content.forEach(walk);
  return [...new Set(out)];
}

async function runAnthropicRoute({
  files = [],
  instruction,
  system,
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const apiKey = env && env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('runAnthropicRoute: ANTHROPIC_API_KEY is not configured');
  if (typeof fetchImpl !== 'function') throw new Error('runAnthropicRoute: fetch is not available');
  const task = String(instruction || '').trim();
  if (!task) throw new Error('runAnthropicRoute: instruction is required');
  if (!Array.isArray(files) || files.length === 0) throw new Error('runAnthropicRoute: files are required');

  const base = 'https://api.anthropic.com/v1';
  const headers = (beta) => ({
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': beta,
  });

  const outputs = [];
  let finalText = '';
  for (const f of files) {
    if (!f || !Buffer.isBuffer(f.buffer)) continue;
    const skillId = skillIdForFileName(f.name) || 'docx';
    // 1. upload (JSON base64 variant keeps this dependency-free; multipart
    //    works too — the file_id is all the orchestrator needs downstream).
    const upRes = await fetchImpl(`${base}/files`, {
      method: 'POST',
      headers: { ...headers(FILES_API_BETA), 'content-type': 'application/json' },
      body: JSON.stringify({ name: f.name, contentBase64: f.buffer.toString('base64') }),
    });
    const upJson = await upRes.json().catch(() => ({}));
    if (!upRes.ok || !upJson.id) {
      throw new Error(`anthropic files.upload failed: ${upRes.status} ${upJson.error?.message || ''}`.trim());
    }
    // 2. run with the skill + code execution tool.
    const req = buildAnthropicRequest({ instruction: task, fileId: upJson.id, skillId, model, system });
    const msgRes = await fetchImpl(req.url, {
      method: 'POST',
      headers: { ...headers(`${CODE_EXECUTION_BETA},${FILES_API_BETA}`), 'content-type': 'application/json' },
      body: JSON.stringify({ ...req.body, system: system || undefined }),
    });
    const msgJson = await msgRes.json().catch(() => ({}));
    if (!msgRes.ok) {
      throw new Error(`anthropic messages.create failed: ${msgRes.status} ${msgJson.error?.message || ''}`.trim());
    }
    for (const block of msgJson.content || []) {
      if (block.type === 'text' && block.text) finalText += `${block.text}\n`;
    }
    // 3. download every generated file.
    for (const fileId of extractOutputFileIds(msgJson)) {
      const dlRes = await fetchImpl(`${base}/files/${fileId}/content`, {
        method: 'GET',
        headers: headers(`${CODE_EXECUTION_BETA},${FILES_API_BETA}`),
      });
      if (!dlRes.ok) continue;
      const buf = Buffer.from(await dlRes.arrayBuffer());
      outputs.push({ name: `${fileId}`, buffer: buf, sourceFileId: fileId });
    }
  }
  return { finalText: finalText.trim(), outputs, driver: 'anthropic' };
}

module.exports = {
  ANTHROPIC_SKILL_IDS,
  CODE_EXECUTION_BETA,
  FILES_API_BETA,
  CODE_EXECUTION_TOOL,
  isAnthropicRouteAvailable,
  skillIdForFileName,
  buildAnthropicRequest,
  extractOutputFileIds,
  runAnthropicRoute,
};
