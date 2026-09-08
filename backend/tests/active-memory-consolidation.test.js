'use strict';

// Tests for the consolidation ("dreaming") pass of the active-memory service —
// OpenClaw port #9 (docs/code/openclaw-port-charter.md). Uses only the
// service's public API and an injected `now` so every assertion is
// deterministic regardless of wall-clock time.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const activeMemory = require('../src/services/active-memory');

describe('active-memory consolidateMemories (dreaming pass)', () => {
  // Unique per run so leftover disk-persisted entries from previous local runs
  // can never hydrate into these users.
  const runTag = `${process.pid}_${Date.now()}`;
  const users = [];
  const uid = (suffix) => {
    const id = `test_consolidation_${runTag}_${suffix}`;
    users.push(id);
    return id;
  };

  after(() => {
    for (const userId of users) activeMemory.clearUserMemory(userId);
  });

  it('merges near-duplicates keeping the stronger entry and summing accessCount; a distinct fact survives', () => {
    const userId = uid('merge');
    const strong = activeMemory.createMemoryEntry(
      userId,
      'The user prefers dark mode in the dashboard settings',
      { strength: 0.6 }
    );
    const weak = activeMemory.createMemoryEntry(
      userId,
      'the user prefers dark mode in the dashboard settings panel',
      { strength: 0.2 }
    );
    // Sanity: different normalized content, so the exact-hash dedupe did NOT
    // collapse them at creation time — only consolidation can.
    assert.notEqual(strong.id, weak.id);
    const distinct = activeMemory.createMemoryEntry(
      userId,
      'Quarterly revenue target for the sales team is ambitious',
      { strength: 0.4 }
    );

    const result = activeMemory.consolidateMemories({ userId, now: Date.now() });
    assert.deepEqual(result, { merged: 1, decayed: 0, promoted: 0, demoted: 0, purged: 0 });

    const remaining = activeMemory.listEntries(userId);
    assert.equal(remaining.length, 2, 'one of the three entries was absorbed');
    const keeper = remaining.find((e) => e.id === strong.id);
    assert.ok(keeper, 'the stronger near-duplicate survives');
    assert.equal(
      remaining.find((e) => e.id === weak.id),
      undefined,
      'the weaker near-duplicate is absorbed'
    );
    assert.equal(keeper.accessCount, 2, "absorbed entry's accessCount is summed into the keeper");
    assert.equal(keeper.strength, 0.6, "keeper's strength is preserved");
    assert.ok(
      remaining.some((e) => e.id === distinct.id),
      'a genuinely distinct fact is untouched'
    );
  });

  it('does not merge below the similarity threshold', () => {
    const userId = uid('below_threshold');
    // 9 shared tokens with one swapped word -> Jaccard 8/10 = 0.8 < 0.85.
    activeMemory.createMemoryEntry(userId, 'the user schedules weekly review meetings on monday mornings');
    activeMemory.createMemoryEntry(userId, 'the user schedules weekly review meetings on monday evenings');

    const result = activeMemory.consolidateMemories({ userId, now: Date.now() });
    assert.equal(result.merged, 0);
    assert.equal(activeMemory.listEntries(userId).length, 2);
  });

  it('decays entries without recent access using a fake clock', () => {
    const userId = uid('decay');
    const entry = activeMemory.createMemoryEntry(userId, 'Stale fact about legacy export preferences', {
      strength: 0.5,
    });

    const later = Date.now() + activeMemory.CONSOLIDATION_DECAY_WINDOW_MS + 1000;
    const result = activeMemory.consolidateMemories({ userId, now: later });
    assert.deepEqual(result, { merged: 0, decayed: 1, promoted: 0, demoted: 0, purged: 0 });

    const decayed = activeMemory.listEntries(userId).find((e) => e.id === entry.id);
    assert.equal(decayed.strength, 0.4, 'strength drops by exactly one decay step');

    // Same fake instant again -> the entry was already decayed at `later`.
    const again = activeMemory.consolidateMemories({ userId, now: later });
    assert.equal(again.decayed, 0, 'decay is not applied twice for the same now');
    assert.equal(
      activeMemory.listEntries(userId).find((e) => e.id === entry.id).strength,
      0.4
    );
  });

  it('does not decay recently accessed entries', () => {
    const userId = uid('fresh');
    activeMemory.createMemoryEntry(userId, 'Fresh fact accessed moments ago', { strength: 0.5 });
    const result = activeMemory.consolidateMemories({ userId, now: Date.now() + 60_000 });
    assert.equal(result.decayed, 0);
  });

  it('purges expired entries', () => {
    const userId = uid('purge');
    activeMemory.createMemoryEntry(userId, 'Ephemeral fact that should be purged quickly', { ttl: 1000 });
    const result = activeMemory.consolidateMemories({ userId, now: Date.now() + 60_000 });
    assert.deepEqual(result, { merged: 0, decayed: 0, promoted: 0, demoted: 0, purged: 1 });
    assert.equal(activeMemory.listEntries(userId).length, 0);
  });

  it('applies the existing promotion rules during the pass', () => {
    const userId = uid('promote');
    const entry = activeMemory.createMemoryEntry(userId, 'Critical preference reinforced heavily', {
      strength: 0.95,
    });
    const result = activeMemory.consolidateMemories({ userId, now: Date.now() });
    assert.equal(result.promoted, 1);
    assert.equal(
      activeMemory.listEntries(userId).find((e) => e.id === entry.id).tier,
      'long_term'
    );
  });

  it('reports correct counters across a mixed pass and is idempotent (second pass -> all zero)', () => {
    const userId = uid('mixed');
    const strong = activeMemory.createMemoryEntry(
      userId,
      'The team standup happens every weekday at nine thirty',
      { strength: 0.6 }
    );
    activeMemory.createMemoryEntry(
      userId,
      'the team standup happens every weekday at nine thirty sharp',
      { strength: 0.2 }
    );
    const promotable = activeMemory.createMemoryEntry(
      userId,
      'Deployment approvals always require a second reviewer',
      { strength: 0.95 }
    );
    activeMemory.createMemoryEntry(userId, 'Temporary note that expires almost immediately', { ttl: 1000 });

    const now = Date.now() + activeMemory.CONSOLIDATION_DECAY_WINDOW_MS + 1000;
    const first = activeMemory.consolidateMemories({ userId, now });
    // merged: the near-duplicate pair collapses. decayed: the two surviving
    // live entries (keeper + promotable) are past the decay window. promoted:
    // 0.95 - 0.1 = 0.85 still clears the 0.8 strength rule. purged: the
    // expired note (excluded from merge/decay).
    assert.deepEqual(first, { merged: 1, decayed: 2, promoted: 1, demoted: 0, purged: 1 });

    const remaining = activeMemory.listEntries(userId);
    assert.equal(remaining.length, 2);
    assert.equal(remaining.find((e) => e.id === strong.id).accessCount, 2);
    assert.equal(remaining.find((e) => e.id === promotable.id).tier, 'long_term');

    const second = activeMemory.consolidateMemories({ userId, now });
    assert.deepEqual(
      second,
      { merged: 0, decayed: 0, promoted: 0, demoted: 0, purged: 0 },
      'a second pass with the same now changes nothing'
    );
  });

  it("never touches another user's entries and no-ops without a userId", () => {
    const bystander = uid('bystander');
    const other = uid('other');
    const entry = activeMemory.createMemoryEntry(bystander, 'Bystander fact that must remain intact', {
      strength: 0.5,
    });
    activeMemory.createMemoryEntry(other, 'Other user fact that will decay', { strength: 0.5 });

    const now = Date.now() + activeMemory.CONSOLIDATION_DECAY_WINDOW_MS + 1000;
    const result = activeMemory.consolidateMemories({ userId: other, now });
    assert.equal(result.decayed, 1);

    const untouched = activeMemory.listEntries(bystander).find((e) => e.id === entry.id);
    assert.equal(untouched.strength, 0.5, "another user's entry is never decayed");

    assert.deepEqual(activeMemory.consolidateMemories({}), {
      merged: 0,
      decayed: 0,
      promoted: 0,
      demoted: 0,
      purged: 0,
    });
  });
});
