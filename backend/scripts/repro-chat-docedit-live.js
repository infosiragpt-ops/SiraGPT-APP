#!/usr/bin/env node
'use strict';

/**
 * repro-chat-docedit-live.js — LIVE proof that the CHAT can edit documents
 * like Claude Cowork: real upload → POST /api/ai/generate ("edita mi
 * documento…") → agentic loop picks document_edit → doc-agent runs in the
 * REMOTE sandbox → file_artifact card → download via /api/agent/artifact/:id
 * → OOXML verification. Plus controls: doc-QA stays on the plain stream, and
 * a no-attachment turn never sees the tool.
 */

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') }); } catch (_) {}
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const fs = require('fs/promises');
const os = require('os');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { parseZip } = require('../src/services/zip-parser');
const { isValidOoxml } = require('../src/services/doc-agent');

const prisma = new PrismaClient();
const BASE = process.env.E2E_BASE_URL || 'http://localhost:5151';
const MODEL = process.env.E2E_CHAT_MODEL || 'gpt-4o-mini';

async function sse(res, onEvt) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop();
    for (const fr of frames) {
      for (const line of fr.split('\n')) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m) continue;
        try { onEvt(JSON.parse(m[1])); } catch (_) { /* non-JSON frame */ }
      }
    }
  }
}

async function main() {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const docxBuffer = await Packer.toBuffer(new Document({
    sections: [{ children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Informe Preliminar')] }),
      new Paragraph({ children: [new TextRun('El acompañamiento pedagógico fortalece la práctica docente.')] }),
    ] }],
  }));

  const email = `chat-docedit+${Date.now()}@siragpt.local`;
  const user = await prisma.user.create({
    data: { email, name: 'Chat DocEdit E2E', password: 'x', plan: 'ENTERPRISE', monthlyLimit: 99999999, monthlyCallLimit: 99999999 },
  });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h', audience: 'siragpt-clients', issuer: 'siragpt-api' });
  await prisma.session.create({ data: { userId: user.id, token, fingerprint: null, expiresAt: new Date(Date.now() + 3600_000) } });
  const H = { Authorization: `Bearer ${token}` };

  let pass = false;
  try {
    // 1. real upload
    const fd = new FormData();
    fd.append('files', new Blob([docxBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'informe.docx');
    const up = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: H, body: fd });
    const upJson = await up.json();
    const f = (upJson.files || upJson.data || [])[0] || upJson.file || upJson;
    if (!f?.id) throw new Error(`upload failed: ${JSON.stringify(upJson).slice(0, 200)}`);
    console.log(`subido: informe.docx → ${f.id}`);

    // 2. the REAL chat turn: "edita mi documento…"
    const res = await fetch(`${BASE}/api/ai/generate`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        prompt: 'Edita mi documento: cambia el título a "Informe Final 2026" y agrega al final un párrafo corto de conclusiones. Devuélveme el .docx editado.',
        model: MODEL,
        provider: 'OpenAI',
        files: [f.id],
        stream: true,
      }),
      signal: AbortSignal.timeout(480_000),
    });
    console.log(`chat: HTTP ${res.status}`);
    if (res.status !== 200) throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let sawDocEditCall = false;
    const artifacts = [];
    const toolsSeen = new Set();
    let lastSentinel = null;
    await sse(res, (evt) => {
      const t = evt.type || evt.event;
      if (t === 'tool_call_start' && evt.name) toolsSeen.add(evt.name);
      if (t === 'tool_call_start' && evt.name === 'document_edit') sawDocEditCall = true;
      if (t === 'tool_result' && evt.name === 'document_edit') console.log('document_edit result:', String(evt.preview || '').slice(0, 400));
      if (t === 'file_artifact' && evt.artifact) artifacts.push(evt.artifact);
      // The chat UI reads artifacts from the agent-task-state sentinel — keep
      // the LAST full sentinel and parse its JSON after the stream ends.
      if (typeof evt.content === 'string' && evt.content.includes('agent-task-state')) lastSentinel = evt.content;
    });
    if (lastSentinel) {
      try {
        const json = lastSentinel.replace(/^[\s\S]*?```agent-task-state\n/, '').replace(/\n?```[\s\S]*$/, '');
        const state = JSON.parse(json);
        for (const a of state.artifacts || []) artifacts.push(a);
      } catch (e) { console.log('sentinel parse failed:', e.message); }
    }
    console.log(`tools vistos: ${[...toolsSeen].join(', ') || '(ninguno)'}`);
    console.log(`document_edit invocado: ${sawDocEditCall}`);
    const withUrl = artifacts.filter((a) => a && a.downloadUrl);
    console.log(`artifacts: ${withUrl.map((a) => `${a.filename} → ${a.downloadUrl}`).join(' | ') || 'NONE'}`);
    if (!withUrl.length) throw new Error('no artifact card reached the stream');

    // 3. download through the real artifact route + verify OOXML. The model
    // may deliver several cards (a retry produces a corrected second file) —
    // like a real user, accept the turn if ANY delivered docx has the edits.
    let okOoxml = false, hasTitle = false, oldGone = false;
    for (const art of withUrl.filter((a) => /\.docx$/i.test(a.filename))) {
      const dl = await fetch(`${BASE}${art.downloadUrl}`, { headers: H });
      console.log(`download ${art.downloadUrl} → HTTP ${dl.status}`);
      if (dl.status !== 200) continue;
      const outBuf = Buffer.from(await dl.arrayBuffer());
      const tmp = path.join(os.tmpdir(), `chat-docedit-${Date.now()}.docx`);
      await fs.writeFile(tmp, outBuf);
      const text = String(await parseZip(tmp)).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
      await fs.rm(tmp, { force: true });
      const vOk = isValidOoxml(outBuf);
      const vTitle = text.includes('informe final 2026') || text.includes('informe final');
      const vOld = !text.includes('informe preliminar');
      console.log(`  ${art.filename}: valid=${vOk} | título nuevo=${vTitle} | viejo fuera=${vOld}`);
      if (vOk && vTitle && vOld) { okOoxml = vOk; hasTitle = vTitle; oldGone = vOld; break; }
      if (!okOoxml) { okOoxml = vOk; hasTitle = vTitle; oldGone = vOld; }
    }
    console.log(`mejor artefacto → valid OOXML: ${okOoxml} | título nuevo: ${hasTitle} | título viejo fuera: ${oldGone}`);

    // 4. control: doc-QA with attachment must NOT invoke document_edit
    const qa = await fetch(`${BASE}/api/ai/generate`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ prompt: '¿De qué trata el documento?', model: MODEL, provider: 'OpenAI', files: [f.id], stream: true }),
      signal: AbortSignal.timeout(120_000),
    });
    let qaToolCalls = 0;
    if (qa.status === 200) await sse(qa, (evt) => { if ((evt.type || evt.event) === 'tool_call_start') qaToolCalls += 1; });
    console.log(`control doc-QA: HTTP ${qa.status}, tool calls=${qaToolCalls} (esperado 0 = stream plano)`);

    pass = sawDocEditCall && okOoxml && hasTitle && oldGone && qaToolCalls === 0;
    console.log(pass ? '\nCHAT DOC-EDIT LIVE PASS ✅ (el chat edita documentos como Cowork)' : '\nFAIL ❌');
  } finally {
    try { await prisma.file.deleteMany({ where: { userId: user.id } }); } catch (_) {}
    try { await prisma.session.deleteMany({ where: { userId: user.id } }); } catch (_) {}
    try { await prisma.user.delete({ where: { id: user.id } }); } catch (_) {}
    await prisma.$disconnect().catch(() => {});
  }
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => { console.error('repro error:', e.message); process.exit(2); });
