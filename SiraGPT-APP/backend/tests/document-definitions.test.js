'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-definitions');
const { extractDefinitions, buildDefinitionsForFiles, renderDefinitionsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractDefinitions('').total, 0);
  assert.equal(extractDefinitions(null).total, 0);
});

test('detects "X is a Y"', () => {
  const r = extractDefinitions('Kubernetes is a container orchestration system.');
  assert.ok(r.definitions.some((d) => /Kubernetes/.test(d.term)));
});

test('detects "X is defined as Y"', () => {
  const r = extractDefinitions('Latency is defined as the time between request and response.');
  assert.ok(r.definitions.some((d) => d.kind === 'defined-as'));
});

test('detects "X means Y"', () => {
  const r = extractDefinitions('SLA means service level agreement.');
  assert.ok(r.definitions.some((d) => d.kind === 'means'));
});

test('detects "X refers to Y"', () => {
  const r = extractDefinitions('Throughput refers to the number of requests per second.');
  assert.ok(r.definitions.some((d) => d.kind === 'means'));
});

test('detects "X stands for Y"', () => {
  const r = extractDefinitions('API stands for Application Programming Interface.');
  assert.ok(r.definitions.some((d) => d.kind === 'means'));
});

test('detects Spanish "X es un Y"', () => {
  const r = extractDefinitions('Kubernetes es un orquestador de contenedores.');
  assert.ok(r.definitions.some((d) => d.kind === 'es-is-a'));
});

test('detects Spanish "X se define como Y"', () => {
  const r = extractDefinitions('Latencia se define como el tiempo entre solicitud y respuesta.');
  assert.ok(r.definitions.some((d) => d.kind === 'es-def'));
});

test('detects "X significa Y"', () => {
  const r = extractDefinitions('SLA significa acuerdo de nivel de servicio.');
  assert.ok(r.definitions.some((d) => d.kind === 'es-def'));
});

test('caps definitions per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `Term${i} is defined as something ${i}. `;
  const r = extractDefinitions(text);
  assert.ok(r.definitions.length <= 18);
});

test('buildDefinitionsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'API stands for Application Programming Interface.' },
    { name: 'b.md', extractedText: 'SLA means service level agreement.' },
  ];
  const r = buildDefinitionsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDefinitionsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'API stands for Application Programming Interface.' }];
  const r = buildDefinitionsForFiles(files);
  const md = renderDefinitionsBlock(r);
  assert.match(md, /^## IN-TEXT DEFINITIONS/);
});

test('renderDefinitionsBlock empty when nothing surfaces', () => {
  assert.equal(renderDefinitionsBlock({ perFile: [] }), '');
  assert.equal(renderDefinitionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDefinitionsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'API stands for Application Programming Interface.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
