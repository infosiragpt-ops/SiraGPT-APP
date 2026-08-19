'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-compose-services');
const { extractComposeServices, buildComposeServicesForFiles, renderComposeServicesBlock } = engine;

const COMPOSE_FIXTURE = `version: "3.8"
services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
      - "443:443/tcp"
    depends_on:
      - db
      - cache
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
  db:
    image: postgres:15
    restart: always
    env_file: .env.db
  cache:
    image: redis:7
    build: ./cache
networks:
  default:
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractComposeServices('').total, 0);
  assert.equal(extractComposeServices(null).total, 0);
});

test('non-compose text returns empty', () => {
  const r = extractComposeServices('This is just regular text mentioning image and ports.');
  assert.equal(r.total, 0);
});

test('detects service names under services:', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'service' && e.name === 'web'));
  assert.ok(r.entries.some((e) => e.kind === 'service' && e.name === 'db'));
  assert.ok(r.entries.some((e) => e.kind === 'service' && e.name === 'cache'));
});

test('detects image references', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'image' && e.name === 'nginx:alpine'));
  assert.ok(r.entries.some((e) => e.kind === 'image' && e.name === 'postgres:15'));
});

test('detects port mappings', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'port' && e.name === '8080:80'));
  assert.ok(r.entries.some((e) => e.kind === 'port' && e.name === '443:443'));
});

test('detects depends_on entries', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'dependsOn' && e.name === 'db'));
  assert.ok(r.entries.some((e) => e.kind === 'dependsOn' && e.name === 'cache'));
});

test('detects restart policies', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'restart' && e.name === 'unless-stopped'));
  assert.ok(r.entries.some((e) => e.kind === 'restart' && e.name === 'always'));
});

test('detects build context', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'build' && e.name === './cache'));
});

test('detects env_file references', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'envFile' && e.name === '.env.db'));
});

test('counts healthcheck blocks', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.totals.healthcheck >= 1);
});

test('counts network definitions', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.totals.network >= 1);
});

test('dedupes identical service names', () => {
  const r = extractComposeServices('services:\n  web:\n    image: x\n  web:\n    image: y\n');
  assert.equal(r.entries.filter((e) => e.kind === 'service' && e.name === 'web').length, 1);
});

test('caps entries per file', () => {
  let text = 'services:\n';
  for (let i = 0; i < 30; i++) {
    text += `  svc${i}:\n    image: img-${i}:latest\n`;
  }
  const r = extractComposeServices(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractComposeServices(COMPOSE_FIXTURE);
  assert.ok(r.totals.service >= 3);
  assert.ok(r.totals.image >= 2);
});

test('buildComposeServicesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.yml', extractedText: 'services:\n  a:\n    image: foo' },
    { name: 'b.yml', extractedText: 'services:\n  b:\n    image: bar' },
  ];
  const r = buildComposeServicesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderComposeServicesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'docker-compose.yml', extractedText: COMPOSE_FIXTURE }];
  const r = buildComposeServicesForFiles(files);
  const md = renderComposeServicesBlock(r);
  assert.match(md, /^## DOCKER COMPOSE/);
});

test('renderComposeServicesBlock empty when nothing surfaces', () => {
  assert.equal(renderComposeServicesBlock({ perFile: [] }), '');
  assert.equal(renderComposeServicesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildComposeServicesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: COMPOSE_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
