#!/usr/bin/env node
'use strict';

/**
 * repro-doc-agent-remote.js — prove the full PRODUCTION path:
 *   Mac (loop + OpenRouter LLM)  →  remote sandbox driver (HTTPS)
 *   →  sandbox.chatagic.com (Cloudflare Tunnel)  →  Lenovo
 *   →  ephemeral Docker container  →  real .docx edit  →  download + verify.
 *
 * Requires env: SANDBOX_SERVICE_URL, SANDBOX_API_KEY (so createSandbox picks
 * the remote driver) and OPENROUTER_API_KEY (for the agent's LLM).
 *
 *   SANDBOX_SERVICE_URL=https://sandbox.chatagic.com SANDBOX_API_KEY=… \
 *     node scripts/repro-doc-agent-remote.js
 */

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') }); } catch (_) {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const fs = require('fs/promises');
const os = require('os');
const { runDocumentAgent } = require('../src/services/doc-agent');
const { parseZip } = require('../src/services/zip-parser');

async function main() {
  if (!process.env.SANDBOX_SERVICE_URL || !process.env.SANDBOX_API_KEY) {
    throw new Error('SANDBOX_SERVICE_URL and SANDBOX_API_KEY must be set (so the remote sandbox driver is used)');
  }
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const docxBuffer = await Packer.toBuffer(new Document({
    sections: [{ children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Informe Preliminar')] }),
      new Paragraph({ children: [new TextRun('El acompañamiento pedagógico fortalece la práctica docente.')] }),
    ] }],
  }));

  const events = [];
  const result = await runDocumentAgent({
    files: [{ name: 'informe.docx', buffer: docxBuffer }],
    instruction: 'cambia el título a "Informe Final" y agrega al final un párrafo de conclusiones (2-3 frases) sobre el acompañamiento pedagógico',
    onEvent: (e) => { if (['sandbox_ready', 'tool_call', 'retry', 'output_invalid'].includes(e.type)) events.push(e); },
  });

  console.log(`driver=${result.driver} iterations=${result.iterations} stopped=${result.stoppedReason}`);
  console.log('tools:', events.filter((e) => e.type === 'tool_call').map((e) => e.tool).join(', '));
  const outputs = result.outputs || [];
  console.log('outputs:', outputs.map((o) => `${o.name}(${o.buffer.length}b, valid=${o.valid})`).join(', ') || 'NONE');
  if (result.driver !== 'remote') throw new Error(`expected the REMOTE driver, got "${result.driver}" — check SANDBOX_SERVICE_URL/KEY`);
  const edited = outputs.find((o) => /\.docx$/i.test(o.name) && o.valid !== false);
  if (!edited) throw new Error('no valid edited docx produced');

  const tmp = path.join(os.tmpdir(), `remote-docagent-${Date.now()}.docx`);
  await fs.writeFile(tmp, edited.buffer);
  const text = String(await parseZip(tmp));
  await fs.rm(tmp, { force: true });
  const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  const hasTitle = norm.includes('informe final');
  const hasConclusions = /conclusi/.test(norm);
  const oldGone = !norm.includes('informe preliminar');
  console.log(`valid OOXML: true | new title: ${hasTitle} | conclusions: ${hasConclusions} | old gone: ${oldGone}`);
  const pass = oldGone && (hasTitle || hasConclusions);
  console.log(pass ? 'REMOTE E2E PASS ✅ (real container on the Lenovo edited the docx)' : 'FAIL ❌');
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => { console.error('remote e2e error:', e.message); process.exit(2); });
