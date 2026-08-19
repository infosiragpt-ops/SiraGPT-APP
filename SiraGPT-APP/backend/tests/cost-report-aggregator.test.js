'use strict';

/**
 * Cycle 45 — cost-report org aggregation tests.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { aggregatePerOrg, UNAFFILIATED_KEY } = require('../src/services/ai/cost-report-aggregator');

describe('cost-report-aggregator · aggregatePerOrg', () => {
  test('rolls per-user cost into per-org buckets', () => {
    const perUser = [
      { userId: 'u1', costUSD: 1.5, inputTokens: 100, outputTokens: 50, requests: 3 },
      { userId: 'u2', costUSD: 0.75, inputTokens: 40, outputTokens: 10, requests: 1 },
    ];
    const memberships = [
      { userId: 'u1', orgId: 'org-A', organization: { id: 'org-A', name: 'Alpha', slug: 'alpha' } },
      { userId: 'u2', orgId: 'org-A', organization: { id: 'org-A', name: 'Alpha', slug: 'alpha' } },
    ];
    const result = aggregatePerOrg(perUser, memberships);
    assert.equal(result.length, 1);
    const a = result[0];
    assert.equal(a.orgId, 'org-A');
    assert.equal(a.name, 'Alpha');
    assert.equal(a.costUSD, 2.25);
    assert.equal(a.inputTokens, 140);
    assert.equal(a.outputTokens, 60);
    assert.equal(a.requests, 4);
    assert.equal(a.users, 2);
  });

  test('a user in N orgs contributes to each org bucket', () => {
    const perUser = [
      { userId: 'u1', costUSD: 2, inputTokens: 100, outputTokens: 50, requests: 2 },
    ];
    const memberships = [
      { userId: 'u1', orgId: 'org-A', organization: { id: 'org-A', name: 'Alpha', slug: 'alpha' } },
      { userId: 'u1', orgId: 'org-B', organization: { id: 'org-B', name: 'Bravo', slug: 'bravo' } },
    ];
    const result = aggregatePerOrg(perUser, memberships);
    assert.equal(result.length, 2);
    for (const r of result) {
      assert.equal(r.costUSD, 2);
      assert.equal(r.requests, 2);
      assert.equal(r.users, 1);
    }
  });

  test('users without memberships go into the unaffiliated bucket', () => {
    const perUser = [
      { userId: 'u1', costUSD: 1, inputTokens: 10, outputTokens: 5, requests: 1 },
      { userId: 'u2', costUSD: 0.5, inputTokens: 5, outputTokens: 2, requests: 1 },
    ];
    const result = aggregatePerOrg(perUser, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].orgId, UNAFFILIATED_KEY);
    assert.equal(result[0].costUSD, 1.5);
    assert.equal(result[0].users, 2);
  });

  test('sorts buckets descending by costUSD', () => {
    const perUser = [
      { userId: 'u1', costUSD: 0.5, inputTokens: 0, outputTokens: 0, requests: 1 },
      { userId: 'u2', costUSD: 5, inputTokens: 0, outputTokens: 0, requests: 1 },
      { userId: 'u3', costUSD: 2, inputTokens: 0, outputTokens: 0, requests: 1 },
    ];
    const memberships = [
      { userId: 'u1', orgId: 'org-A', organization: { id: 'org-A', name: 'A', slug: 'a' } },
      { userId: 'u2', orgId: 'org-B', organization: { id: 'org-B', name: 'B', slug: 'b' } },
      { userId: 'u3', orgId: 'org-C', organization: { id: 'org-C', name: 'C', slug: 'c' } },
    ];
    const result = aggregatePerOrg(perUser, memberships);
    assert.deepEqual(result.map((r) => r.orgId), ['org-B', 'org-C', 'org-A']);
  });

  test('returns empty array on bogus input', () => {
    assert.deepEqual(aggregatePerOrg(null, []), []);
    assert.deepEqual(aggregatePerOrg(undefined, undefined), []);
  });
});
