'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-prisma-schema');
const { extractPrismaSchema, buildPrismaSchemaForFiles, renderPrismaSchemaBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPrismaSchema('').total, 0);
  assert.equal(extractPrismaSchema(null).total, 0);
});

test('detects model declarations', () => {
  const r = extractPrismaSchema('model User { id Int @id }');
  assert.ok(r.entries.some((e) => e.kind === 'model' && e.name === 'User'));
});

test('detects enum declarations', () => {
  const r = extractPrismaSchema('enum Role { ADMIN USER }');
  assert.ok(r.entries.some((e) => e.kind === 'enum' && e.name === 'Role'));
});

test('detects datasource block', () => {
  const r = extractPrismaSchema('datasource db { provider = "postgresql" }');
  assert.ok(r.entries.some((e) => e.kind === 'datasource' && e.name === 'db'));
});

test('detects generator block', () => {
  const r = extractPrismaSchema('generator client { provider = "prisma-client-js" }');
  assert.ok(r.entries.some((e) => e.kind === 'generator' && e.name === 'client'));
});

test('detects provider value', () => {
  const r = extractPrismaSchema('provider = "postgresql"');
  assert.ok(r.entries.some((e) => e.kind === 'provider' && e.name === 'postgresql'));
});

test('detects field attributes @id @unique @default', () => {
  const r = extractPrismaSchema('id Int @id @default(autoincrement()) email String @unique');
  assert.ok(r.entries.some((e) => e.name === '@id'));
  assert.ok(r.entries.some((e) => e.name === '@unique'));
  assert.ok(r.entries.some((e) => e.name === '@default'));
});

test('detects @relation attribute', () => {
  const r = extractPrismaSchema('posts Post[] @relation("user-posts")');
  assert.ok(r.entries.some((e) => e.name === '@relation'));
});

test('detects model-level @@map / @@unique / @@index', () => {
  const r = extractPrismaSchema('model User { @@map("users") @@unique([email]) @@index([createdAt]) }');
  assert.ok(r.entries.some((e) => e.name === '@@map'));
  assert.ok(r.entries.some((e) => e.name === '@@unique'));
  assert.ok(r.entries.some((e) => e.name === '@@index'));
});

test('detects multiple models', () => {
  const r = extractPrismaSchema('model User { id Int @id } model Post { id Int @id }');
  assert.equal(r.totals.model, 2);
});

test('dedupes identical model names', () => {
  const r = extractPrismaSchema('model X { id Int @id }');
  assert.equal(r.entries.filter((e) => e.kind === 'model' && e.name === 'X').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `model M${i} { id Int @id } `;
  const r = extractPrismaSchema(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractPrismaSchema('model User { id Int @id } enum Role { A B } datasource db { } generator client { }');
  assert.equal(r.totals.model, 1);
  assert.equal(r.totals.enum, 1);
  assert.equal(r.totals.datasource, 1);
  assert.equal(r.totals.generator, 1);
});

test('detects native db types (@db.VarChar)', () => {
  const r = extractPrismaSchema('email String @db.VarChar(255)');
  assert.ok(r.entries.some((e) => /^@db\./.test(e.name)));
});

test('buildPrismaSchemaForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.prisma', extractedText: 'model User { id Int @id }' },
    { name: 'b.prisma', extractedText: 'model Post { id Int @id }' },
  ];
  const r = buildPrismaSchemaForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPrismaSchemaBlock returns markdown when entries exist', () => {
  const files = [{ name: 'schema.prisma', extractedText: 'model User { id Int @id }' }];
  const r = buildPrismaSchemaForFiles(files);
  const md = renderPrismaSchemaBlock(r);
  assert.match(md, /^## PRISMA/);
});

test('renderPrismaSchemaBlock empty when nothing surfaces', () => {
  assert.equal(renderPrismaSchemaBlock({ perFile: [] }), '');
  assert.equal(renderPrismaSchemaBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPrismaSchemaForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'model User { id Int @id }' },
  ]);
  assert.equal(r.perFile.length, 1);
});
