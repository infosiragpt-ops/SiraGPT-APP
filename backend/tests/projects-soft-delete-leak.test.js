'use strict';

// Regression — soft-deleted projects must be invisible to read + mutation
// routes. The list route already filtered with softDeleteWhere, but GET /:id,
// GET /:id/context and the ownProject() helper (used by every mutation route)
// queried `{ id, userId }` with no deletedAt filter, so a project sitting in the
// trash was still fetchable by id and still re-shareable / mutable.
//
// The fake prisma.project.findFirst HONORS the where.deletedAt the route passes,
// so the old (unfiltered) query returns the tombstoned project (leak) while the
// fixed query filters it out.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildRouteTestApp, installAuthSessionMock, reloadModule } = require('./http-test-utils');
const prisma = require('../src/config/database');

describe('projects · soft-deleted projects are not leaked', () => {
  let auth;
  let saved;
  let project;

  beforeEach(() => {
    auth = installAuthSessionMock();
    saved = { findFirst: prisma.project.findFirst, update: prisma.project.update };

    // Faithfully emulate Prisma equality filtering on the project row.
    prisma.project.findFirst = async ({ where = {} } = {}) => {
      const p = project;
      if (!p) return null;
      if (where.id !== undefined && p.id !== where.id) return null;
      if (where.userId !== undefined && p.userId !== where.userId) return null;
      if (Object.prototype.hasOwnProperty.call(where, 'deletedAt')) {
        if (where.deletedAt === null && p.deletedAt != null) return null;
        if (where.deletedAt && where.deletedAt.not === null && p.deletedAt == null) return null;
      }
      return { ...p, files: [], chats: [], documents: [], _count: { files: 0, chats: 0, memories: 0, documents: 0 } };
    };
    prisma.project.update = async ({ data }) => ({ shareId: data.shareId || 'sid', ...data });

    delete require.cache[require.resolve('../src/routes/projects')];
  });

  afterEach(() => {
    prisma.project.findFirst = saved.findFirst;
    prisma.project.update = saved.update;
    auth.restore();
    delete require.cache[require.resolve('../src/routes/projects')];
  });

  function app() {
    return buildRouteTestApp('/projects', reloadModule('../src/routes/projects'));
  }

  test('GET /:id returns 200 for a live project, 404 for a soft-deleted one', async () => {
    project = { id: 'pr1', userId: auth.user.id, name: 'Live', deletedAt: null };
    const live = await request(app()).get('/projects/pr1').set('Authorization', auth.authHeader);
    assert.equal(live.status, 200);

    project = { id: 'pr1', userId: auth.user.id, name: 'Trashed', deletedAt: new Date() };
    const dead = await request(app()).get('/projects/pr1').set('Authorization', auth.authHeader);
    assert.equal(dead.status, 404, 'a soft-deleted project must not be fetchable by id');
  });

  test('GET /:id/context 404s for a soft-deleted project', async () => {
    project = { id: 'pr1', userId: auth.user.id, name: 'Trashed', deletedAt: new Date() };
    const res = await request(app()).get('/projects/pr1/context').set('Authorization', auth.authHeader);
    assert.equal(res.status, 404);
  });

  test('POST /:id/share 404s for a soft-deleted project (ownProject guard)', async () => {
    project = { id: 'pr1', userId: auth.user.id, name: 'Trashed', deletedAt: new Date() };
    const res = await request(app()).post('/projects/pr1/share').set('Authorization', auth.authHeader);
    assert.equal(res.status, 404, 'a trashed project must not be re-shareable');
  });
});
