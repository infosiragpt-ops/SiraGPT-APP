'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-drizzle');
const { extractDrizzle, buildDrizzleForFiles, renderDrizzleBlock, _internal } = engine;
const { isDrizzleLike } = _internal;

const DRIZZLE_FIXTURE = `import { pgTable, serial, text, varchar, integer, boolean, timestamp, uuid, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, eq, and, desc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

export const userRoleEnum = pgEnum('user_role', ['admin', 'user', 'guest']);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: text('name').notNull(),
  age: integer('age'),
  isActive: boolean('is_active').default(true).notNull(),
  metadata: jsonb('metadata').default({}),
  role: userRoleEnum('role').default('user'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  externalId: uuid('external_id').defaultRandom(),
}, (table) => ({
  emailIdx: uniqueIndex('email_idx').on(table.email),
  createdIdx: index('created_idx').on(table.createdAt),
}));

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: text('body'),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const db = drizzle(pgClient);

async function findActiveUsers() {
  return db
    .select()
    .from(users)
    .where(and(eq(users.isActive, true), eq(users.role, 'admin')))
    .orderBy(desc(users.createdAt))
    .limit(10);
}

async function createUser(data) {
  return db.insert(users).values(data).returning();
}

async function updateRole(id, role) {
  return db.update(users).set({ role }).where(eq(users.id, id));
}

async function removeUser(id) {
  return db.delete(users).where(eq(users.id, id));
}
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractDrizzle('').total, 0);
  assert.equal(extractDrizzle(null).total, 0);
});

test('non-Drizzle text returns empty', () => {
  const r = extractDrizzle('Just regular text without Drizzle');
  assert.equal(r.total, 0);
});

test('isDrizzleLike heuristic', () => {
  assert.ok(isDrizzleLike('pgTable("x", {})'));
  assert.ok(isDrizzleLike('from "drizzle-orm"'));
  assert.ok(!isDrizzleLike('plain text'));
});

test('detects pgTable definitions', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'table' && e.name === 'users'));
  assert.ok(r.entries.some((e) => e.kind === 'table' && e.name === 'posts'));
});

test('detects pgEnum', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'enum' && e.name === 'user_role'));
});

test('detects column types (serial, varchar, integer)', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'column' && e.name === 'serial'));
  assert.ok(r.entries.some((e) => e.kind === 'column' && e.name === 'varchar'));
  assert.ok(r.entries.some((e) => e.kind === 'column' && e.name === 'integer'));
});

test('detects timestamp / uuid / jsonb columns', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'column' && e.name === 'timestamp'));
  assert.ok(r.entries.some((e) => e.kind === 'column' && e.name === 'uuid'));
  assert.ok(r.entries.some((e) => e.kind === 'column' && e.name === 'jsonb'));
});

test('detects constraints (.primaryKey, .notNull, .unique)', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'constraint' && e.name === '.primaryKey'));
  assert.ok(r.entries.some((e) => e.kind === 'constraint' && e.name === '.notNull'));
  assert.ok(r.entries.some((e) => e.kind === 'constraint' && e.name === '.unique'));
});

test('detects .references (foreign keys)', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'constraint' && e.name === '.references'));
});

test('detects indexes (uniqueIndex / index)', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'index' && e.name === 'email_idx'));
  assert.ok(r.entries.some((e) => e.kind === 'index' && e.name === 'created_idx'));
});

test('detects relations', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'relation' && e.name === 'users'));
});

test('detects db.select / .insert / .update / .delete', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'query' && e.name === 'db.select'));
  assert.ok(r.entries.some((e) => e.kind === 'query' && e.name === 'db.insert'));
  assert.ok(r.entries.some((e) => e.kind === 'query' && e.name === 'db.update'));
  assert.ok(r.entries.some((e) => e.kind === 'query' && e.name === 'db.delete'));
});

test('detects conditions (eq / and / desc)', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'condition' && e.name === 'eq'));
  assert.ok(r.entries.some((e) => e.kind === 'condition' && e.name === 'and'));
  assert.ok(r.entries.some((e) => e.kind === 'condition' && e.name === 'desc'));
});

test('dedupes identical tables', () => {
  const r = extractDrizzle('pgTable("x", {}); pgTable("x", {});');
  assert.equal(r.entries.filter((e) => e.kind === 'table' && e.name === 'x').length, 1);
});

test('caps entries per file', () => {
  let text = `import { pgTable, text } from "drizzle-orm/pg-core";\n`;
  for (let i = 0; i < 50; i++) text += `pgTable("t${i}", { c: text("c") });\n`;
  const r = extractDrizzle(text);
  assert.ok(r.entries.length <= 30);
});

test('counts totals by kind', () => {
  const r = extractDrizzle(DRIZZLE_FIXTURE);
  assert.ok(r.totals.table >= 2);
  assert.ok(r.totals.column >= 5);
  assert.ok(r.totals.query >= 4);
});

test('buildDrizzleForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'import "drizzle-orm/pg-core"; pgTable("a", {});' },
    { name: 'b.ts', extractedText: 'import "drizzle-orm"; pgTable("b", { c: text("c") });' },
  ];
  const r = buildDrizzleForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDrizzleBlock returns markdown when entries exist', () => {
  const files = [{ name: 'schema.ts', extractedText: DRIZZLE_FIXTURE }];
  const r = buildDrizzleForFiles(files);
  const md = renderDrizzleBlock(r);
  assert.match(md, /^## DRIZZLE/);
});

test('renderDrizzleBlock empty when nothing surfaces', () => {
  assert.equal(renderDrizzleBlock({ perFile: [] }), '');
  assert.equal(renderDrizzleBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDrizzleForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: DRIZZLE_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
