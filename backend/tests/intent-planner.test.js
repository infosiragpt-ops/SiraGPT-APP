'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/services/intent-planner');

describe('intent-planner', () => {
  test('empty prompt → no plan required', () => {
    const r = planner.buildPlan({ prompt: '' });
    assert.equal(r.planRequired, false);
    assert.equal(r.nodes.length, 0);
  });

  test('single trivial deliverable → no plan required', () => {
    const r = planner.buildPlan({ prompt: 'Envía un correo corto al cliente' });
    assert.equal(r.planRequired, false);
  });

  test('multiple deliverables → plan required', () => {
    const r = planner.buildPlan({ prompt: 'Crea un PDF, un Excel y una presentación con los resultados' });
    assert.equal(r.planRequired, true);
    assert.ok(r.nodes.length >= 3);
    assert.ok(r.nodes.some((n) => n.kind === 'generate'));
    assert.ok(r.nodes.some((n) => n.kind === 'deliver'));
  });

  test('explicit "step by step" forces plan', () => {
    const r = planner.buildPlan({ prompt: 'Hazlo paso a paso, primero analiza y luego genera el reporte' });
    assert.equal(r.planRequired, true);
  });

  test('verification request adds verify node', () => {
    const r = planner.buildPlan({ prompt: 'Crea un documento y un Excel, luego valida que sean coherentes' });
    assert.equal(r.planRequired, true);
    assert.ok(r.nodes.some((n) => n.kind === 'verify'));
  });

  test('detectDeliverables surfaces document + code', () => {
    const d = planner.detectDeliverables('Genera un PDF y luego implementa la función');
    assert.ok(d.find((x) => x.kind === 'document'));
    assert.ok(d.find((x) => x.kind === 'code'));
  });

  test('renderPlanBlock returns content when plan required', () => {
    const r = planner.buildPlan({ prompt: 'Plan: primero crea un PDF, después un Excel, finalmente prueba la salida' });
    const block = planner.renderPlanBlock(r);
    assert.match(block, /EXECUTION PLAN/);
  });

  test('renderPlanBlock empty when no plan', () => {
    const r = planner.buildPlan({ prompt: 'gracias' });
    assert.equal(planner.renderPlanBlock(r), '');
  });

  test('plan nodes have id, kind and depends_on', () => {
    const r = planner.buildPlan({ prompt: 'Roadmap: crea un PDF, un Excel y una presentación luego revisa todo' });
    for (const n of r.nodes) {
      assert.ok(n.id);
      assert.ok(['gather', 'analyze', 'decide', 'generate', 'verify', 'deliver'].includes(n.kind));
      assert.ok(Array.isArray(n.depends_on));
    }
  });
});
