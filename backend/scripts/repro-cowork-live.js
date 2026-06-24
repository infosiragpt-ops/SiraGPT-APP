#!/usr/bin/env node
'use strict';

/**
 * repro-cowork-live.js — Claude-Cowork-parity LIVE campaign, 100% real:
 *
 *   real upload (POST /api/files/upload, multipart)
 *     → real route (POST /api/doc-agent/run, SSE)
 *       → real LLM (OpenRouter, route default model)
 *         → REMOTE sandbox driver → sandbox.chatagic.com (Cloudflare Tunnel)
 *           → ephemeral Docker container on the Lenovo edits the document
 *     → artifact download card → format-specific verification of the edit.
 *
 * Four Cowork-style scenarios: DOCX edit, XLSX transform, CSV computation,
 * PPTX edit. Each scenario is independent; the campaign reports a summary
 * table and exits non-zero if any scenario fails.
 *
 * Requires: backend running with SANDBOX_SERVICE_URL/SANDBOX_API_KEY set
 * (E2E_BASE_URL, default http://localhost:5151) + OPENROUTER_API_KEY in env.
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
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

// ── input builders (real files, like a user would upload) ──────────────────

async function buildDocx() {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  return Packer.toBuffer(new Document({
    sections: [{ children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Informe Preliminar')] }),
      new Paragraph({ children: [new TextRun('El acompañamiento pedagógico fortalece la práctica docente en los CETPRO de Cusco.')] }),
    ] }],
  }));
}

async function buildXlsx() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ventas');
  ws.addRow(['Producto', 'Unidades', 'Precio']);
  ws.addRow(['Laptop', 3, 1200]);
  ws.addRow(['Mouse', 10, 25]);
  ws.addRow(['Teclado', 5, 80]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildCsv() {
  return Buffer.from([
    'Alumno,Nota1,Nota2,Nota3',
    'Ana,15,18,17',
    'Luis,11,12,14',
    'Maria,19,20,18',
  ].join('\n'), 'utf8');
}

async function buildPptx() {
  const PptxGen = require('pptxgenjs');
  const p = new PptxGen();
  const s = p.addSlide();
  s.addText('Plan 2025', { x: 0.6, y: 0.6, w: 8, h: 1.2, fontSize: 36, bold: true });
  s.addText('Objetivos generales del periodo', { x: 0.6, y: 2.0, w: 8, h: 0.8, fontSize: 18 });
  const out = await p.write('nodebuffer');
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

// ── format verifiers ────────────────────────────────────────────────────────

async function verifyDocx(buf) {
  const tmp = path.join(os.tmpdir(), `cw-${Date.now()}.docx`);
  await fs.writeFile(tmp, buf);
  const text = norm(await parseZip(tmp));
  await fs.rm(tmp, { force: true });
  const checks = {
    'valid OOXML': isValidOoxml(buf),
    'titulo nuevo (Informe Final)': text.includes('informe final'),
    'conclusiones agregadas': /conclusi/.test(text),
    'titulo viejo eliminado': !text.includes('informe preliminar'),
  };
  return { checks, pass: checks['valid OOXML'] && checks['titulo viejo eliminado'] && (checks['titulo nuevo (Informe Final)'] || checks['conclusiones agregadas']) };
}

async function verifyXlsx(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  let cells = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => {
    const v = c.value;
    if (v == null) return;
    if (typeof v === 'object' && v.formula) cells.push(`=${v.formula}`, String(v.result ?? ''));
    else cells.push(String(v));
  })));
  const blob = norm(cells.join(' | '));
  const checks = {
    'abre como xlsx': cells.length > 0,
    'columna Total presente': blob.includes('total'),
    'totales correctos (3600/250/400) o formulas': (blob.includes('3600') && blob.includes('250') && blob.includes('400')) || /=\s*b\d+\s*\*\s*c\d+/.test(blob),
    'total general (4250) o formula suma': blob.includes('4250') || /=\s*sum/.test(blob),
  };
  return { checks, pass: checks['abre como xlsx'] && checks['columna Total presente'] && (checks['totales correctos (3600/250/400) o formulas'] || checks['total general (4250) o formula suma']) };
}

function verifyCsv(buf) {
  const text = buf.toString('utf8');
  const lines = text.trim().split(/\r?\n/);
  const blob = norm(text);
  // Averages: Ana 16.67, Luis 12.33, Maria 19 → Maria first when sorted desc.
  const firstDataRow = norm(lines[1] || '');
  const checks = {
    'columna Promedio presente': blob.includes('promedio'),
    'promedios calculados (19 / 16.6 / 12.3)': blob.includes('19') && (blob.includes('16.6') || blob.includes('16,6')) && (blob.includes('12.3') || blob.includes('12,3')),
    'ordenado desc (Maria primero)': firstDataRow.includes('maria'),
  };
  return { checks, pass: checks['columna Promedio presente'] && checks['promedios calculados (19 / 16.6 / 12.3)'] && checks['ordenado desc (Maria primero)'] };
}

async function verifyPptx(buf) {
  const PizZip = require('pizzip');
  const zip = new PizZip(buf);
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const text = norm(slideNames.map((n) => zip.files[n].asText().replace(/<[^>]+>/g, ' ')).join(' '));
  const checks = {
    'valid OOXML': isValidOoxml(buf),
    'titulo nuevo (Plan Estrategico 2026)': text.includes('plan estrategico 2026'),
    'titulo viejo eliminado (Plan 2025)': !/plan 2025\b/.test(text),
    'diapositiva de conclusiones': slideNames.length >= 2 && /conclusi/.test(text),
  };
  return { checks, pass: checks['valid OOXML'] && checks['titulo nuevo (Plan Estrategico 2026)'] && (checks['titulo viejo eliminado (Plan 2025)'] || checks['diapositiva de conclusiones']) };
}

// ── scenario runner through the REAL route ─────────────────────────────────

async function runScenario({ name, fileName, mime, buffer, prompt, verify }, H, token, createdFileIds) {
  const t0 = Date.now();
  const log = (m) => console.log(`  [${name}] ${m}`);

  const fd = new FormData();
  fd.append('files', new Blob([buffer], { type: mime }), fileName);
  const up = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: H, body: fd });
  const upJson = await up.json().catch(() => ({}));
  const f = (upJson.files || upJson.data || [])[0] || upJson.file || upJson;
  if (!f?.id) throw new Error(`upload failed (HTTP ${up.status}): ${JSON.stringify(upJson).slice(0, 200)}`);
  createdFileIds.push(f.id);
  log(`subido: ${fileName} (${buffer.length}b) → ${f.id}`);

  const res = await fetch(`${BASE}/api/doc-agent/run`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ prompt, fileIds: [f.id] }),
    signal: AbortSignal.timeout(480_000),
  });
  if (res.status !== 200) throw new Error(`run HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = null;
  const artifacts = [];
  let toolCalls = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop();
    for (const fr of frames) {
      const m = fr.match(/^data:\s*(.*)$/m);
      if (!m) continue;
      let evt;
      try { evt = JSON.parse(m[1]); } catch { continue; }
      if (evt.type === 'tool_call') toolCalls += 1;
      if (evt.type === 'retry') log(`retry correctivo: ${evt.reason}`);
      if (evt.type === 'output_invalid') log(`output inválido: ${evt.name} (${evt.reason})`);
      if (evt.type === 'artifact') artifacts.push(evt);
      if (evt.type === 'done') done = evt;
      if (evt.type === 'error') throw new Error(`agent error: ${evt.message}`);
    }
  }
  log(`agente: driver=${done?.driver} iter=${done?.iterations} tools=${toolCalls} stop=${done?.stoppedReason}`);
  if (done?.driver !== 'remote') throw new Error(`expected REMOTE driver (Lenovo), got "${done?.driver}"`);
  if (!artifacts.length) throw new Error('no artifacts produced');
  createdFileIds.push(...artifacts.map((a) => a.id).filter(Boolean));
  for (const a of artifacts) log(`  · artefacto: ${a.name} (${a.size}b) valid=${a.valid}`);

  // Best deliverable: valid + same extension as the input, else first valid.
  const wantExt = fileName.split('.').pop().toLowerCase();
  const art = artifacts.find((a) => a.valid !== false && String(a.name).toLowerCase().endsWith(`.${wantExt}`))
    || artifacts.find((a) => a.valid !== false)
    || artifacts[0];
  const dl = await fetch(`${BASE}${art.url}?token=${encodeURIComponent(token)}`, { headers: H });
  if (dl.status !== 200) throw new Error(`download HTTP ${dl.status} for ${art.url}`);
  const outBuf = Buffer.from(await dl.arrayBuffer());
  log(`artefacto: ${art.name} (${outBuf.length}b) valid=${art.valid}`);

  const { checks, pass } = await verify(outBuf);
  for (const [k, v] of Object.entries(checks)) log(`  ${v ? '✓' : '✗'} ${k}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`${pass ? 'PASS ✅' : 'FAIL ❌'} (${secs}s)`);
  return { name, pass, secs, driver: done?.driver, iterations: done?.iterations, toolCalls, artifact: art.name, checks };
}

// ── campaign ────────────────────────────────────────────────────────────────

async function main() {
  const email = `cowork-live+${Date.now()}@siragpt.local`;
  const user = await prisma.user.create({
    data: { email, name: 'Cowork Live E2E', password: 'x', plan: 'ENTERPRISE', monthlyLimit: 99999999, monthlyCallLimit: 99999999 },
  });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '2h', audience: 'siragpt-clients', issuer: 'siragpt-api' });
  await prisma.session.create({ data: { userId: user.id, token, fingerprint: null, expiresAt: new Date(Date.now() + 7200_000) } });
  const H = { Authorization: `Bearer ${token}` };
  const createdFileIds = [];

  const scenarios = [
    {
      name: 'DOCX', fileName: 'informe.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await buildDocx(),
      prompt: 'cambia el título a "Informe Final" y agrega al final un párrafo de conclusiones (2-3 frases) sobre el acompañamiento pedagógico',
      verify: verifyDocx,
    },
    {
      name: 'XLSX', fileName: 'ventas.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await buildXlsx(),
      prompt: 'agrega una columna "Total" con Unidades × Precio para cada producto, y al final una fila "TOTAL GENERAL" con la suma de los totales. Mantén el formato xlsx.',
      verify: verifyXlsx,
    },
    {
      name: 'CSV', fileName: 'notas.csv', mime: 'text/csv', buffer: buildCsv(),
      prompt: 'agrega una columna "Promedio" con el promedio de las tres notas (2 decimales) y ordena las filas por promedio descendente. Entrega el resultado como CSV.',
      verify: verifyCsv,
    },
    {
      name: 'PPTX', fileName: 'plan.pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: await buildPptx(),
      prompt: 'cambia el título de la primera diapositiva a "Plan Estratégico 2026" y agrega una nueva diapositiva final titulada "Conclusiones" con 3 puntos clave',
      verify: verifyPptx,
    },
  ];

  const results = [];
  try {
    for (const sc of scenarios) {
      console.log(`\n━━ ${sc.name} ━━ "${sc.prompt.slice(0, 80)}…"`);
      try {
        results.push(await runScenario(sc, H, token, createdFileIds));
      } catch (e) {
        console.log(`  [${sc.name}] ERROR: ${e.message}`);
        results.push({ name: sc.name, pass: false, error: e.message });
      }
    }
  } finally {
    try { await prisma.file.deleteMany({ where: { userId: user.id } }); } catch (_) {}
    try { await prisma.session.deleteMany({ where: { userId: user.id } }); } catch (_) {}
    try { await prisma.user.delete({ where: { id: user.id } }); } catch (_) {}
    await prisma.$disconnect().catch(() => {});
  }

  console.log('\n══════════ RESUMEN CAMPAÑA COWORK LIVE ══════════');
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS ✅' : 'FAIL ❌'}  ${r.name.padEnd(5)} ${r.error ? `— ${r.error.slice(0, 120)}` : `driver=${r.driver} iter=${r.iterations} tools=${r.toolCalls} → ${r.artifact} (${r.secs}s)`}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`  ${passed}/${results.length} escenarios en verde`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => { console.error('campaign error:', e); process.exit(2); });
