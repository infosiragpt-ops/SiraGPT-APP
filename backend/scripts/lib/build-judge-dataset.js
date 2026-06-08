#!/usr/bin/env node
'use strict';

/**
 * build-judge-dataset.js — joins the live-chat E2E report (model answers)
 * with the corpus (prompts) + fixtures (planted ground-truth facts) into a
 * compact array the adversarial-judge Workflow consumes via `args`.
 *
 * Emits JSON to stdout: [{ id, turn, category, prompt, expected, fact, answer, deterministic }]
 * Only includes turns that actually got an HTTP 200 answer (skips 429/network
 * failures — those are infra, not capability, and are reported separately).
 */

const path = require('path');
const { CORPUS } = require('./e2e-corpus');

const reportPath = process.argv[2] || path.join(__dirname, '..', 'evals', 'live-chat-e2e-report.json');
const report = require(reportPath);

// Map id → corpus unit for prompt + per-turn lookup.
const byId = new Map(CORPUS.map((u) => [u.id, u]));

// Ground-truth fact hints per fixture (mirror of e2e-fixtures facts) so the
// judge sees the canonical answer, not just the substring matcher.
const FACTS = {
  ventas: 'Excel ventas_2025: Norte total 600, Sur 375, Este 820 (mayor), Oeste 275 (menor); gran total 2070; 4 regiones; Norte Q4=200; marcador XLSMARK-5521.',
  contrato: 'Word contrato: Cliente Acme Corp, Proveedor TechSolutions SL, importe 45.000 EUR, vigencia 12 meses, penalización 2%/día (cláusula 7.3), confidencialidad 5 años, firmado en Madrid, marcador DOCMARK-8842.',
  acta: 'Word acta: 3 asistentes, presupuesto marketing 30.000 EUR, lanzamiento app pospuesto a Q3, Juan enviará el informe el viernes, próxima reunión 17 de marzo, marcador ACTAMARK-3310.',
  informe: 'PDF informe seguridad: uptime 99.95%, 3 vulnerabilidades críticas, 8 medias, rotar credenciales cada 90 días, cifrar backups AES-256, coste remediación 12.500 EUR, controles Firewall/Backups/Cifrado, marcador PDFMARK-7731.',
  factura: 'Imagen factura (OCR): número 4485, cliente ACME, total 1250 EUR, fecha 2025-03-15, concepto Consultoría.',
};

function factFor(doc) {
  if (!doc) return '';
  const keys = Array.isArray(doc) ? doc : [doc];
  return keys.map((k) => FACTS[k]).filter(Boolean).join(' ');
}

const report2 = require(reportPath);
const items = [];
for (const r of report2.results) {
  const unit = byId.get(r.unitId);
  if (!unit) continue;
  let prompt, doc;
  if (unit.turns) {
    const t = unit.turns[(r.turn || 1) - 1];
    if (!t) continue;
    prompt = t.prompt;
    // multi-turn: ground-truth = union of all docs used in the thread
    doc = unit.turns.map((x) => x.doc).filter(Boolean).flat();
  } else {
    prompt = unit.prompt;
    doc = unit.doc;
  }
  // Skip infra failures (no real answer to judge).
  const d = r.detail || '';
  const infra = /HTTP \d/.test(d) && (d.includes('429') || d.includes('HTTP 0') || d.includes('HTTP 5'));
  if (infra) continue;
  items.push({
    id: r.unitId, turn: r.turn || null, category: r.category,
    prompt, expected: r.expect, fact: factFor(doc),
    answer: (r.answer || '').slice(0, 900), deterministic: r.pass === true,
  });
}

process.stdout.write(JSON.stringify(items));
