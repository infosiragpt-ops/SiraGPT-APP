'use strict';

/**
 * doc-agent-surgical — surgical-editing principle (§1–§7 of the design brief).
 *
 * Offline: real .docx buffers via the `docx` npm lib, ZIP patching via
 * python3 stdlib (zipfile only — same as doc-agent.test.js), mocked fetch
 * for the Anthropic route. No network, no API keys.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexec = promisify(execFile);

const {
  FORBIDDEN_PARTS,
  SKILL_ORDER,
  SURGICAL_RULES,
  isReformateoRequest,
  buildSurgicalPromptAddition,
} = require('../src/services/doc-agent/surgical-rules');
const {
  listZipEntries,
  isForbiddenEntry,
  diffOoxml,
  validateEditedFile,
  MAX_ATTEMPTS,
  libreOfficePdfCheckCommand,
} = require('../src/services/doc-agent/validate');
const {
  isAnthropicRouteAvailable,
  skillIdForFileName,
  buildAnthropicRequest,
  extractOutputFileIds,
  runAnthropicRoute,
  CODE_EXECUTION_TOOL,
} = require('../src/services/doc-agent/anthropic-route');
const { buildDocAgentSystemPrompt } = require('../src/services/doc-agent/skills');
const { runDocumentAgent } = require('../src/services/doc-agent');

async function makeDocx(title) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(title)] }),
        new Paragraph({ children: [new TextRun('Cuerpo del documento para validación milimétrica.')] }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

async function touchStyles(buffer) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'surgical-'));
  try {
    const inPath = path.join(tmp, 'in.docx');
    const outPath = path.join(tmp, 'out.docx');
    const scriptPath = path.join(tmp, 'touch.py');
    await fs.writeFile(inPath, buffer);
    await fs.writeFile(scriptPath, [
      'import sys, zipfile',
      'i, o = sys.argv[1], sys.argv[2]',
      'zin = zipfile.ZipFile(i)',
      'zout = zipfile.ZipFile(o, "w", zipfile.ZIP_DEFLATED)',
      'for it in zin.infolist():',
      '    data = b"<w:styles>TOUCHED</w:styles>" if it.filename == "word/styles.xml" else zin.read(it.filename)',
      '    zout.writestr(it, data)',
      'zout.close()',
      '',
    ].join('\n'));
    await pexec('python3', [scriptPath, inPath, outPath]);
    return fs.readFile(outPath);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

test('surgical-rules: forbidden parts + reformat detection + fixed order', () => {
  assert.ok(FORBIDDEN_PARTS.includes('[Content_Types].xml'));
  assert.ok(FORBIDDEN_PARTS.includes('word/styles.xml'));
  assert.ok(FORBIDDEN_PARTS.includes('word/numbering.xml'));
  assert.ok(SKILL_ORDER.length >= 6);
  assert.ok(SURGICAL_RULES.includes('NEVER regenerates'));
  assert.equal(isReformateoRequest('cambia el título'), false);
  assert.equal(isReformateoRequest('aplica modo reformateo total'), true);
  const guarded = buildSurgicalPromptAddition({ instruction: 'cambia el título', formats: ['docx'] });
  assert.match(guarded, /FORMAT GUARD active/);
  const reform = buildSurgicalPromptAddition({ instruction: 'modo reformateo', formats: ['docx'] });
  assert.match(reform, /REFORMAT MODE/);
});

test('validate: diff detects only the edited part; identical input fails', async () => {
  const a = await makeDocx('Título A');
  const b = await makeDocx('Título B');
  const entries = listZipEntries(b);
  assert.ok(entries.some((e) => e.name === '[Content_Types].xml'));
  const diff = diffOoxml(a, b);
  assert.ok(diff);
  assert.ok(diff.changed.includes('word/document.xml'));
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.changed.filter(isForbiddenEntry).length, 0);

  const okVerdict = validateEditedFile({ originalBuffer: a, editedBuffer: b, instruction: 'cambia el título' });
  assert.equal(okVerdict.ok, true);
  assert.equal(okVerdict.reason, 'valid');

  const same = validateEditedFile({ originalBuffer: a, editedBuffer: a, instruction: 'cambia el título' });
  assert.equal(same.ok, false);
  assert.equal(same.reason, 'identical_to_input');
});

test('validate: forbidden parts are advisory by default, hard-fail in strict mode', async () => {
  const a = await makeDocx('Título A');
  const touched = await touchStyles(await makeDocx('Título B'));
  // Default: advisory — the run stays valid but the touch is reported.
  const verdict = validateEditedFile({ originalBuffer: a, editedBuffer: touched, instruction: 'cambia el título' });
  assert.equal(verdict.ok, true);
  assert.ok((verdict.unexpectedParts || []).includes('word/styles.xml'));
  // Strict (lxml ZIP-patch path, exact CRCs): hard fail.
  const strict = validateEditedFile({ originalBuffer: a, editedBuffer: touched, instruction: 'cambia el título', strictForbidden: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.reason, 'forbidden_parts_touched');
  assert.ok(strict.details.includes('word/styles.xml'));

  const reform = validateEditedFile({ originalBuffer: a, editedBuffer: touched, instruction: 'modo reformateo total', strictForbidden: true });
  assert.equal(reform.ok, true);
  assert.equal(MAX_ATTEMPTS, 3);
  assert.match(libreOfficePdfCheckCommand('/workspace/outputs/f.docx'), /libreoffice --headless/);
});

test('anthropic-route: request shape, file-id extraction, mocked run', async () => {
  assert.equal(isAnthropicRouteAvailable({}), false);
  assert.equal(isAnthropicRouteAvailable({ ANTHROPIC_API_KEY: 'x' }), true);
  assert.equal(skillIdForFileName('tesis.docx'), 'docx');
  assert.equal(skillIdForFileName('data.xlsx'), 'xlsx');
  assert.equal(skillIdForFileName('deck.pptx'), 'pptx');
  assert.equal(skillIdForFileName('paper.pdf'), 'pdf');

  const req = buildAnthropicRequest({ instruction: 'parafrasea', fileId: 'file_1', skillId: 'docx' });
  assert.equal(req.body.container.skills[0].skill_id, 'docx');
  assert.equal(req.body.tools[0].type, CODE_EXECUTION_TOOL.type);
  assert.equal(req.body.messages[0].content[0].file_id, 'file_1');
  assert.equal(req.body.messages[0].content[0].type, 'container_upload');

  assert.deepEqual(extractOutputFileIds({ content: [{ type: 'text', text: 'hi' }] }), []);
  assert.deepEqual(
    extractOutputFileIds({ content: [{ type: 'text', text: 'done' }, { type: 'document', file_id: 'file_out' }] }),
    ['file_out'],
  );

  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push(url);
    const method = opts.method || 'GET';
    if (url.endsWith('/v1/files') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ id: 'file_1' }) };
    }
    if (url.endsWith('/v1/messages') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'Listo' }, { type: 'document', file_id: 'file_out' }] }),
      };
    }
    if (url.includes('/v1/files/file_out/content')) {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('PK-fake').buffer };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r = await runAnthropicRoute({
    files: [{ name: 'tesis.docx', buffer: Buffer.from('fake-docx') }],
    instruction: 'parafrasea el resumen',
    env: { ANTHROPIC_API_KEY: 'test' },
    fetchImpl: fakeFetch,
  });
  assert.equal(r.driver, 'anthropic');
  assert.equal(r.outputs.length, 1);
  assert.ok(r.finalText.includes('Listo'));
  assert.ok(calls.length >= 3);
});

test('skills: surgical block present, relevant skills only, fixed order', () => {
  const p = buildDocAgentSystemPrompt(['informe.docx', 'datos.xlsx'], { instruction: 'cambia el título' });
  assert.ok(p.includes('NEVER regenerates'));
  assert.ok(p.includes('FORMAT GUARD active'));
  assert.ok(p.includes('DOCX SKILL'));
  assert.ok(p.includes('XLSX SKILL'));
  assert.ok(!p.includes('PPTX SKILL'));
  assert.ok(p.indexOf('DOCX SKILL') < p.indexOf('XLSX SKILL'));
  const r = buildDocAgentSystemPrompt(['deck.pptx'], { instruction: 'aplica modo reformateo' });
  assert.ok(r.includes('REFORMAT MODE'));
  assert.ok(r.includes('PPTX SKILL'));
});

test('runDocumentAgent: approval mode emits approval_required and stops when denied', async () => {
  const buf = await makeDocx('Hola');
  let clientCalls = 0;
  const client = {
    chat: { completions: { create: async () => { clientCalls += 1; throw new Error('must not be called'); } } },
  };
  const events = [];
  const result = await runDocumentAgent({
    files: [{ name: 'doc.docx', buffer: buf }],
    instruction: 'cambia el título',
    client,
    driver: 'local',
    approvalMode: 'approval',
    approvePlan: async () => false,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.stoppedReason, 'awaiting_approval');
  assert.equal(clientCalls, 0);
  assert.ok(events.some((e) => e.type === 'approval_required'));
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'plan'));
});
