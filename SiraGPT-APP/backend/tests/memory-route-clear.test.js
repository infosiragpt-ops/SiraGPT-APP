'use strict';

// Route-level contract tests for DELETE /api/memory ("forget me").
//
// This is a PRIVACY action that must clear BOTH the per-user memory
// document and the learned vector facts. If the vector store fails to
// clear, the endpoint must NOT report full success — otherwise the user
// is told they were forgotten while learned facts remain recallable.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

// Stub the auth middleware BEFORE the route module is required so the
// router's `router.use(authenticateToken)` picks up a pass-through that
// injects a deterministic test user.
const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    authenticateToken: (req, _res, next) => {
      req.user = { id: 'u_test_clear' };
      next();
    },
  },
};

const memoryDocument = require('../src/services/memory-document');
const longTermMemory = require('../src/services/long-term-memory');
const memoryRouter = require('../src/routes/memory');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRouter);
  return app;
}

test('DELETE /api/memory reports full success when both stores clear', async () => {
  const origDoc = memoryDocument.clear;
  const origVec = longTermMemory.clearUserMemory;
  memoryDocument.clear = () => true;
  longTermMemory.clearUserMemory = async () => ({ cleared: 0 });
  try {
    const res = await request(makeApp()).delete('/api/memory');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.documentCleared, true);
    assert.equal(res.body.vectorCleared, true);
  } finally {
    memoryDocument.clear = origDoc;
    longTermMemory.clearUserMemory = origVec;
  }
});

test('DELETE /api/memory does NOT report success when vector clear fails', async () => {
  const origDoc = memoryDocument.clear;
  const origVec = longTermMemory.clearUserMemory;
  memoryDocument.clear = () => true;
  longTermMemory.clearUserMemory = async () => {
    throw new Error('vector store unavailable');
  };
  try {
    const res = await request(makeApp()).delete('/api/memory');
    assert.equal(res.status, 500);
    assert.notEqual(res.body.ok, true);
    assert.equal(res.body.partial, true);
    assert.equal(res.body.documentCleared, true);
    assert.equal(res.body.vectorCleared, false);
  } finally {
    memoryDocument.clear = origDoc;
    longTermMemory.clearUserMemory = origVec;
  }
});

test('DELETE /api/memory fails closed when the document clear itself throws', async () => {
  const origDoc = memoryDocument.clear;
  const origVec = longTermMemory.clearUserMemory;
  let vectorAttempted = false;
  memoryDocument.clear = () => {
    throw new Error('disk write failed');
  };
  longTermMemory.clearUserMemory = async () => {
    vectorAttempted = true;
    return { cleared: 0 };
  };
  try {
    const res = await request(makeApp()).delete('/api/memory');
    assert.equal(res.status, 500);
    assert.notEqual(res.body.ok, true);
    assert.equal(res.body.documentCleared, false);
    assert.equal(res.body.vectorCleared, false);
    assert.equal(vectorAttempted, false, 'must not touch vector store after document clear failed');
  } finally {
    memoryDocument.clear = origDoc;
    longTermMemory.clearUserMemory = origVec;
  }
});
