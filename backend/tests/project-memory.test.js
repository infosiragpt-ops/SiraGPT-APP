/**
 * Tests for services/project-memory.js — fact extractor + persister
 * for project-scoped chat memory.
 *
 * extractFacts takes an injectable openai client so we can stub it
 * directly. saveFacts/extractAndSave/listMemory/deleteMemory hit
 * prisma — we mock that via require-cache injection.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const DB_PATH = require.resolve('../src/config/database');
const MEM_PATH = require.resolve('../src/services/project-memory');

const dbMock = {
  projectMemory: {
    findMany: async () => [],
    createMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  },
  project: {
    findFirst: async () => null,
  },
};

let origDb, origMem;

function installMocks() {
  origDb = require.cache[DB_PATH];
  origMem = require.cache[MEM_PATH];
  const m = new Module(DB_PATH);
  m.filename = DB_PATH;
  m.loaded = true;
  m.exports = dbMock;
  m.paths = Module._nodeModulePaths(path.dirname(DB_PATH));
  require.cache[DB_PATH] = m;
  delete require.cache[MEM_PATH];
}

function restoreMocks() {
  if (origDb) require.cache[DB_PATH] = origDb; else delete require.cache[DB_PATH];
  if (origMem) require.cache[MEM_PATH] = origMem; else delete require.cache[MEM_PATH];
}

let mem;

before(() => {
  installMocks();
  mem = require('../src/services/project-memory');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  dbMock.projectMemory.findMany = async () => [];
  dbMock.projectMemory.createMany = async () => ({ count: 0 });
  dbMock.projectMemory.deleteMany = async () => ({ count: 0 });
  dbMock.project.findFirst = async () => null;
});

// Helper that returns a fake openai client emitting one canned reply.
function fakeOpenAI(content) {
  return {
    chat: {
      completions: {
        create: async (req) => {
          // Save last request for assertions.
          fakeOpenAI._lastRequest = req;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

// ── exported constants ────────────────────────────────────────────

describe('project-memory · exported constants', () => {
  it('MAX_FACTS_PER_TURN = 3', () => {
    assert.equal(mem.MAX_FACTS_PER_TURN, 3);
  });

  it('MAX_FACT_CHARS = 200', () => {
    assert.equal(mem.MAX_FACT_CHARS, 200);
  });

  it('MAX_FACTS_TOTAL = 60 (soft cap per project)', () => {
    assert.equal(mem.MAX_FACTS_TOTAL, 60);
  });
});

// ── extractFacts ──────────────────────────────────────────────────

describe('extractFacts', () => {
  it('throws when openai client is missing', async () => {
    await assert.rejects(
      () => mem.extractFacts({ userMessage: 'hi', assistantMessage: 'hello' }),
      /openai client required/,
    );
  });

  it('returns [] when both messages are empty (short-circuit)', async () => {
    const openai = fakeOpenAI('{"facts":["should-not-be-used"]}');
    const out = await mem.extractFacts({ openai });
    assert.deepEqual(out, []);
  });

  it('parses a valid response into an array', async () => {
    const openai = fakeOpenAI('{"facts":["user prefers MLA citations","deadline March 5"]}');
    const out = await mem.extractFacts({ openai, userMessage: 'prefer MLA, deadline March 5' });
    assert.deepEqual(out, ['user prefers MLA citations', 'deadline March 5']);
  });

  it('returns [] when LLM emits malformed JSON', async () => {
    const openai = fakeOpenAI('not json {');
    const out = await mem.extractFacts({ openai, userMessage: 'x' });
    assert.deepEqual(out, []);
  });

  it('returns [] when parsed JSON lacks facts array', async () => {
    const openai = fakeOpenAI('{"something":"else"}');
    const out = await mem.extractFacts({ openai, userMessage: 'x' });
    assert.deepEqual(out, []);
  });

  it('returns [] when facts is non-array', async () => {
    const openai = fakeOpenAI('{"facts":"not-an-array"}');
    const out = await mem.extractFacts({ openai, userMessage: 'x' });
    assert.deepEqual(out, []);
  });

  it('filters out empty/whitespace-only fact strings', async () => {
    const openai = fakeOpenAI('{"facts":["good fact","","   ","another good one"]}');
    const out = await mem.extractFacts({ openai, userMessage: 'x' });
    assert.deepEqual(out, ['good fact', 'another good one']);
  });

  it('filters out non-string entries', async () => {
    const openai = fakeOpenAI('{"facts":["valid",42,null,{"nope":1},"also valid"]}');
    const out = await mem.extractFacts({ openai, userMessage: 'x' });
    assert.deepEqual(out, ['valid', 'also valid']);
  });

  it('trims facts and caps to MAX_FACT_CHARS', async () => {
    const long = '  ' + 'a'.repeat(300) + '  ';
    const openai = fakeOpenAI(`{"facts":[${JSON.stringify(long)}]}`);
    const out = await mem.extractFacts({ openai, userMessage: 'x' });
    assert.equal(out.length, 1);
    assert.equal(out[0].length, mem.MAX_FACT_CHARS);
    assert.ok(!out[0].startsWith(' '), 'must be trimmed');
  });

  it('caps total to MAX_FACTS_PER_TURN (3)', async () => {
    const facts = ['f1', 'f2', 'f3', 'f4', 'f5'];
    const openai = fakeOpenAI(JSON.stringify({ facts }));
    const out = await mem.extractFacts({ openai, userMessage: 'x' });
    assert.equal(out.length, 3);
    assert.deepEqual(out, ['f1', 'f2', 'f3']);
  });

  it('embeds project context into the user prompt', async () => {
    const openai = fakeOpenAI('{"facts":[]}');
    await mem.extractFacts({
      openai,
      projectName: 'Tesis Doctoral',
      projectDescription: 'Investigación sobre X',
      userMessage: 'pregunta',
      assistantMessage: 'respuesta',
    });
    const req = fakeOpenAI._lastRequest;
    const userBlock = req.messages[1].content;
    assert.match(userBlock, /Project: Tesis Doctoral/);
    assert.match(userBlock, /Goal: Investigación sobre X/);
    assert.match(userBlock, /User: pregunta/);
    assert.match(userBlock, /Assistant: respuesta/);
  });

  it('sends response_format=json_object', async () => {
    const openai = fakeOpenAI('{"facts":[]}');
    await mem.extractFacts({ openai, userMessage: 'x' });
    assert.equal(fakeOpenAI._lastRequest.response_format.type, 'json_object');
  });

  it('uses temperature=0.1 (factual, low-creativity)', async () => {
    const openai = fakeOpenAI('{"facts":[]}');
    await mem.extractFacts({ openai, userMessage: 'x' });
    assert.equal(fakeOpenAI._lastRequest.temperature, 0.1);
  });
});

// ── saveFacts ─────────────────────────────────────────────────────

describe('saveFacts', () => {
  it('returns {inserted: 0} when projectId is missing', async () => {
    const out = await mem.saveFacts({ facts: ['x'] });
    assert.deepEqual(out, { inserted: 0 });
  });

  it('returns {inserted: 0} when facts is empty', async () => {
    const out = await mem.saveFacts({ projectId: 'p1', facts: [] });
    assert.deepEqual(out, { inserted: 0 });
  });

  it('returns {inserted: 0} when facts is non-array', async () => {
    const out = await mem.saveFacts({ projectId: 'p1', facts: 'not-array' });
    assert.deepEqual(out, { inserted: 0 });
  });

  it('inserts all-new facts', async () => {
    let createArg;
    dbMock.projectMemory.findMany = async () => [];
    dbMock.projectMemory.createMany = async (a) => { createArg = a; return { count: a.data.length }; };
    const out = await mem.saveFacts({
      projectId: 'p1',
      sourceChatId: 'c1',
      facts: ['f1', 'f2'],
    });
    assert.deepEqual(out, { inserted: 2 });
    assert.deepEqual(createArg.data, [
      { projectId: 'p1', sourceChatId: 'c1', fact: 'f1' },
      { projectId: 'p1', sourceChatId: 'c1', fact: 'f2' },
    ]);
  });

  it('dedupes against existing facts case-insensitively', async () => {
    let createArg;
    dbMock.projectMemory.findMany = async () => [
      { fact: 'User prefers MLA' },
      { fact: 'Deadline March 5' },
    ];
    dbMock.projectMemory.createMany = async (a) => { createArg = a; return { count: a.data.length }; };
    const out = await mem.saveFacts({
      projectId: 'p1',
      facts: ['user prefers MLA', 'NEW FACT', 'DEADLINE march 5'],
    });
    assert.equal(out.inserted, 1);
    assert.deepEqual(createArg.data.map(d => d.fact), ['NEW FACT']);
  });

  it('returns {inserted: 0} (no createMany call) when all facts are duplicates', async () => {
    let createCalled = false;
    dbMock.projectMemory.findMany = async () => [{ fact: 'X' }];
    dbMock.projectMemory.createMany = async () => { createCalled = true; return { count: 0 }; };
    const out = await mem.saveFacts({ projectId: 'p1', facts: ['x'] });
    assert.deepEqual(out, { inserted: 0 });
    assert.equal(createCalled, false);
  });

  it('dedupes within the incoming batch too', async () => {
    let createArg;
    dbMock.projectMemory.findMany = async () => [];
    dbMock.projectMemory.createMany = async (a) => { createArg = a; return { count: a.data.length }; };
    await mem.saveFacts({ projectId: 'p1', facts: ['foo', 'FOO', 'bar', 'Foo'] });
    const facts = createArg.data.map(d => d.fact);
    assert.deepEqual(facts, ['foo', 'bar']);
  });

  it('sourceChatId defaults to null when not provided', async () => {
    let createArg;
    dbMock.projectMemory.findMany = async () => [];
    dbMock.projectMemory.createMany = async (a) => { createArg = a; return { count: 1 }; };
    await mem.saveFacts({ projectId: 'p1', facts: ['fact'] });
    assert.equal(createArg.data[0].sourceChatId, null);
  });

  it('trims oldest rows when over MAX_FACTS_TOTAL ceiling', async () => {
    // Simulate: 59 existing + insert 5 fresh = 64. Excess = 4.
    const existing = Array.from({ length: 59 }, (_, i) => ({ fact: `old-${i}` }));
    dbMock.projectMemory.findMany = async (args) => {
      // Two findMany calls:
      // 1. dedupe lookup → returns the existing fact list.
      // 2. trim lookup → returns oldest ids to delete.
      if (args.select?.fact) return existing;
      if (args.orderBy?.createdAt === 'asc') {
        return Array.from({ length: args.take }, (_, i) => ({ id: `old-id-${i}` }));
      }
      return [];
    };
    dbMock.projectMemory.createMany = async () => ({ count: 5 });
    let deleteArg;
    dbMock.projectMemory.deleteMany = async (a) => { deleteArg = a; return { count: 4 }; };
    const newFacts = ['n1', 'n2', 'n3', 'n4', 'n5'];
    await mem.saveFacts({ projectId: 'p1', facts: newFacts });
    // Should have requested deletion of 4 oldest rows.
    assert.ok(deleteArg);
    assert.equal(deleteArg.where.id.in.length, 4);
  });
});

// ── extractAndSave (fire-and-forget) ──────────────────────────────

describe('extractAndSave', () => {
  it('is a no-op when OPENAI_API_KEY is missing', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let createCalled = false;
    dbMock.projectMemory.createMany = async () => { createCalled = true; return { count: 0 }; };
    try {
      await mem.extractAndSave({ projectId: 'p1', userMessage: 'hi' });
      assert.equal(createCalled, false, 'should NOT touch the DB without an API key');
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('swallows errors silently (memory is quality-of-life, not required)', async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'bogus';
    // The real OpenAI client will fail with a bogus key. The function
    // must NOT propagate that error.
    const _origWarn = console.warn;
    console.warn = () => {};
    try {
      await assert.doesNotReject(() => mem.extractAndSave({
        projectId: 'p1',
        userMessage: 'hi',
      }));
    } finally {
      console.warn = _origWarn;
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

// ── listMemory + deleteMemory ────────────────────────────────────

describe('listMemory', () => {
  it('queries with desc order, default limit=30', async () => {
    let args;
    dbMock.projectMemory.findMany = async (a) => { args = a; return []; };
    await mem.listMemory('p1');
    assert.equal(args.where.projectId, 'p1');
    assert.equal(args.orderBy.createdAt, 'desc');
    assert.equal(args.take, 30);
  });

  it('clamps limit to [1, 100]', async () => {
    let limit;
    dbMock.projectMemory.findMany = async (a) => { limit = a.take; return []; };
    await mem.listMemory('p1', { limit: 999 });
    assert.equal(limit, 100);
    await mem.listMemory('p1', { limit: 0 });
    assert.equal(limit, 1);
    await mem.listMemory('p1', { limit: -50 });
    assert.equal(limit, 1);
  });
});

describe('deleteMemory', () => {
  it('returns "not found" when project ownership cannot be verified', async () => {
    dbMock.project.findFirst = async () => null;
    const out = await mem.deleteMemory({ userId: 'u1', projectId: 'p1', factId: 'f1' });
    assert.deepEqual(out, { ok: false, reason: 'not found' });
  });

  it('returns "fact not found" when no row was deleted', async () => {
    dbMock.project.findFirst = async () => ({ id: 'p1' });
    dbMock.projectMemory.deleteMany = async () => ({ count: 0 });
    const out = await mem.deleteMemory({ userId: 'u1', projectId: 'p1', factId: 'f1' });
    assert.deepEqual(out, { ok: false, reason: 'fact not found' });
  });

  it('returns ok:true on successful deletion', async () => {
    dbMock.project.findFirst = async () => ({ id: 'p1' });
    let deleteWhere;
    dbMock.projectMemory.deleteMany = async (a) => { deleteWhere = a.where; return { count: 1 }; };
    const out = await mem.deleteMemory({ userId: 'u1', projectId: 'p1', factId: 'f1' });
    assert.deepEqual(out, { ok: true });
    // Ownership filter applied: deleteMany must scope by projectId.
    assert.equal(deleteWhere.projectId, 'p1');
    assert.equal(deleteWhere.id, 'f1');
  });
});
