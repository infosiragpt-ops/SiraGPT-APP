'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const curated = require('../src/services/agents/hermes-curated-memory');
const compaction = require('../src/services/agents/hermes-memory-compaction');
const memoryBridge = require('../src/services/agents/hermes-memory-bridge');
const { buildHermesTools } = require('../src/services/agents/hermes-tools');
const { FOLDER_CAPABILITY_MAP } = require('../src/services/agents/hermes-playbook-bridge');

const USER_A = 'compact-mem-user-a';
const USER_B = 'compact-mem-user-b';

function wipe() {
  curated.clearUser(USER_A);
  curated.clearUser(USER_B);
  curated.resetForTests();
  compaction.resetForTests();
}

function memoryTool() {
  return buildHermesTools().find((tool) => tool.name === 'memory');
}

before(() => {
  wipe();
});

after(() => {
  wipe();
});

describe('hermes memory compaction — size caps', { concurrency: 1 }, () => {
  test('rejects a single fact over the character cap with a Spanish E_PARAMS', async () => {
    wipe();
    const huge = 'x'.repeat(compaction.FACT_MAX_CHARS + 1);
    const result = await compaction.record(USER_A, { layer: 'log', content: huge });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PARAMS');
    assert.match(result.error, /límite de 2000 caracteres/);
    assert.equal(curated.read(USER_A, { target: 'memory' }).count, 0);
  });

  test('stores a profile fact under the profile cap', async () => {
    wipe();
    const added = await compaction.record(USER_A, {
      layer: 'profile',
      content: 'Prefiere tablas en markdown.',
    });
    assert.equal(added.ok, true);
    assert.equal(added.layer, 'profile');
    const session = compaction.readSession(USER_A);
    assert.deepEqual(session.profile, ['Prefiere tablas en markdown.']);
    assert.deepEqual(session.log, []);
  });

  test('stores a log note under the log cap', async () => {
    wipe();
    const added = await compaction.record(USER_A, {
      layer: 'log',
      content: 'CI corre npm test en backend.',
    });
    assert.equal(added.ok, true);
    assert.equal(added.layer, 'log');
    assert.ok(compaction.readSession(USER_A).log.includes('CI corre npm test en backend.'));
  });

  test('a full profile fails closed and is never folded', async () => {
    wipe();
    const filler = 'Perfil fijo: convención de documentación local.';
    let guard = 0;
    while (guard < 40) {
      const next = await compaction.record(USER_A, {
        layer: 'profile',
        content: `${filler} ${guard}`,
        rateLimit: false,
        profileLimit: 80,
      });
      if (!next.ok) {
        assert.equal(next.code, 'E_PARAMS');
        assert.match(next.error, /perfil está lleno/);
        assert.match(next.error, /No se compactan/);
        break;
      }
      guard += 1;
    }
    assert.ok(guard < 40, 'profile cap must reject before looping forever');
    const session = compaction.readSession(USER_A);
    assert.ok(session.profile.length >= 1);
    assert.equal(session.notes.length, 0);
    assert.ok(session.profile.every((row) => row.startsWith('Perfil fijo')));
  });

  test('checkFactSize reports used/limit without writing', () => {
    const ok = compaction.checkFactSize('hola', { maxChars: 10 });
    assert.equal(ok.ok, true);
    assert.equal(ok.used, 4);
    const bad = compaction.checkFactSize('abcdefghijk', { maxChars: 10 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'E_PARAMS');
  });
});

describe('hermes memory compaction — rate caps', { concurrency: 1 }, () => {
  test('rate cap rejects with Spanish E_QUOTA and does not compact', async () => {
    wipe();
    await compaction.record(USER_A, { layer: 'log', content: 'alpha-rate-1', maxWrites: 2, now: 1_000 });
    await compaction.record(USER_A, { layer: 'log', content: 'alpha-rate-2', maxWrites: 2, now: 1_100 });
    const blocked = await compaction.record(USER_A, {
      layer: 'log',
      content: 'alpha-rate-3',
      maxWrites: 2,
      now: 1_200,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'E_QUOTA');
    assert.match(blocked.error, /demasiadas veces/);
    assert.equal(compaction.readSession(USER_A).log.length, 2);
    assert.equal(compaction.readSession(USER_A).notes.length, 0);
  });

  test('user A hitting the rate cap never blocks user B', async () => {
    wipe();
    await compaction.record(USER_A, { layer: 'log', content: 'solo-a-1', maxWrites: 1, now: 5_000 });
    const blockedA = await compaction.record(USER_A, {
      layer: 'log',
      content: 'solo-a-2',
      maxWrites: 1,
      now: 5_100,
    });
    assert.equal(blockedA.ok, false);
    const other = await compaction.record(USER_B, {
      layer: 'log',
      content: 'dato-de-b',
      maxWrites: 1,
      now: 5_100,
    });
    assert.equal(other.ok, true);
    assert.deepEqual(compaction.readSession(USER_B).log, ['dato-de-b']);
    assert.equal(compaction.readSession(USER_A).log.includes('dato-de-b'), false);
  });

  test('compaction itself does not consume the write-rate budget', async () => {
    wipe();
    await compaction.record(USER_A, { layer: 'log', content: 'vieja-uno-aaa', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'vieja-dos-bbb', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'reciente-ccc', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'rate-keep-1', maxWrites: 1, now: 9_000 });
    const folded = compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: () => 'nota plegada de prueba',
    });
    assert.equal(folded.ok, true);
    const stillBlocked = compaction.checkWriteRate(USER_A, { maxWrites: 1, now: 9_100, record: false });
    assert.equal(stillBlocked.ok, false);
    assert.equal(stillBlocked.code, 'E_QUOTA');
  });

  test('rate window expires and writes resume', async () => {
    wipe();
    await compaction.record(USER_A, {
      layer: 'log',
      content: 'ventana-1',
      maxWrites: 1,
      windowMs: 100,
      now: 20_000,
    });
    const later = await compaction.record(USER_A, {
      layer: 'log',
      content: 'ventana-2',
      maxWrites: 1,
      windowMs: 100,
      now: 20_200,
    });
    assert.equal(later.ok, true);
  });
});

describe('hermes memory compaction — triggers and profile preservation', { concurrency: 1 }, () => {
  test('log overflow folds older rows into a note and keeps the recent tail', async () => {
    wipe();
    const stub = (entries) => `STUB:${entries.length}:${entries[0]}`;
    await compaction.record(USER_A, { layer: 'log', content: 'antigua-alpha', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'antigua-beta', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'reciente-gamma', rateLimit: false });
    const added = await compaction.record(USER_A, {
      layer: 'log',
      content: 'nueva-delta',
      rateLimit: false,
      logLimit: 40,
      keepRecent: 1,
      summarizer: stub,
    });
    assert.equal(added.ok, true);
    const session = compaction.readSession(USER_A);
    assert.ok(session.log.includes('nueva-delta'));
    assert.equal(session.log.includes('antigua-alpha'), false);
    assert.ok(session.notes.some((note) => note.text.startsWith('STUB:')));
    assert.ok(session.notes[0].sourceCount >= 1);
  });

  test('profile facts survive a log compaction', async () => {
    wipe();
    await compaction.record(USER_A, {
      layer: 'profile',
      content: 'Habla siempre en español neutro.',
      rateLimit: false,
    });
    await compaction.record(USER_A, { layer: 'log', content: 'log-old-1', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'log-old-2', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'log-new-3', rateLimit: false });
    const folded = compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: () => 'bitacora plegada',
    });
    assert.equal(folded.ok, true);
    const session = compaction.readSession(USER_A);
    assert.deepEqual(session.profile, ['Habla siempre en español neutro.']);
    assert.deepEqual(session.log, ['log-new-3']);
  });

  test('force compact under the cap still folds when asked', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'n1-keep-short' });
    curated.add(USER_A, { target: 'memory', content: 'n2-keep-short' });
    curated.add(USER_A, { target: 'memory', content: 'n3-keep-short' });
    const folded = compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: () => 'forzado',
    });
    assert.equal(folded.ok, true);
    assert.equal(folded.compacted, 2);
    assert.deepEqual(compaction.readSession(USER_A).log, ['n3-keep-short']);
  });

  test('compact without force is skipped when the log is under the cap', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'una sola nota corta' });
    const skipped = compaction.compactLog(USER_A, { keepRecent: 1 });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, 'under_cap');
  });

  test('default summarizer is local and never opens a network client', () => {
    const summary = compaction.defaultSummarize(['alpha project postgres', 'beta staging ssh']);
    assert.match(summary, /Resumen de 2 notas/);
    assert.match(summary, /alpha project postgres/);
    assert.equal(summary.includes('openrouter'), false);
    assert.equal(summary.includes('https://'), false);
  });

  test('curated add overflow on memory uses the default folder', () => {
    wipe();
    const chunk = 'Nota de bitácora para llenar el almacén local.';
    let overflowed = false;
    for (let i = 0; i < 80; i += 1) {
      const added = curated.add(USER_A, { target: 'memory', content: `${chunk} #${i}` });
      if (!added.ok) {
        overflowed = true;
        assert.match(String(added.error), /memoria está|superaría|compact/i);
        break;
      }
    }
    const session = compaction.readSession(USER_A);
    assert.ok(session.log.length >= 1);
    assert.ok(overflowed || session.notes.length >= 1, 'either fold or Spanish overflow must fire');
  });
});

describe('hermes memory compaction — stub summarizer failure', { concurrency: 1 }, () => {
  test('a throwing stub leaves the log untouched and returns Spanish', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'keep-old-a' });
    curated.add(USER_A, { target: 'memory', content: 'keep-old-b' });
    curated.add(USER_A, { target: 'memory', content: 'keep-new-c' });
    const failed = compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: () => {
        throw new Error('boom');
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'E_PARAMS');
    assert.match(failed.error, /Falló la compactación/);
    const session = compaction.readSession(USER_A);
    assert.deepEqual(session.log, ['keep-old-a', 'keep-old-b', 'keep-new-c']);
    assert.equal(session.notes.length, 0);
  });

  test('an empty stub fails closed', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'e1-old' });
    curated.add(USER_A, { target: 'memory', content: 'e2-old' });
    curated.add(USER_A, { target: 'memory', content: 'e3-new' });
    const failed = compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: () => '   ',
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /resumen quedó vacío/);
    assert.equal(compaction.readSession(USER_A).notes.length, 0);
    assert.equal(compaction.readSession(USER_A).log.length, 3);
  });

  test('an async stub is awaited and its note is stored', async () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'async-old-1' });
    curated.add(USER_A, { target: 'memory', content: 'async-old-2' });
    curated.add(USER_A, { target: 'memory', content: 'async-new-3' });
    const folded = await compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: async (entries) => `async:${entries.length}`,
    });
    assert.equal(folded.ok, true);
    assert.equal(folded.note, 'async:2');
    assert.deepEqual(compaction.readSession(USER_A).log, ['async-new-3']);
  });

  test('a rejected async stub fails in Spanish without mutating', async () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'rej-old-1' });
    curated.add(USER_A, { target: 'memory', content: 'rej-old-2' });
    curated.add(USER_A, { target: 'memory', content: 'rej-new-3' });
    const failed = await compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: async () => {
        throw new Error('no-llm');
      },
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Falló la compactación/);
    assert.equal(compaction.readSession(USER_A).log.length, 3);
  });

  test('unsafe stub output is blocked as E_CONTENT', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'sec-old-1' });
    curated.add(USER_A, { target: 'memory', content: 'sec-old-2' });
    curated.add(USER_A, { target: 'memory', content: 'sec-new-3' });
    const failed = compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: () => 'token sk-abcdefghijklmnopqrstuvwxyz012345',
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'E_CONTENT');
    assert.equal(compaction.readSession(USER_A).notes.length, 0);
  });
});

describe('hermes memory compaction — ranked retrieval', { concurrency: 1 }, () => {
  test('ranks profile above recent log above compacted notes', async () => {
    wipe();
    await compaction.record(USER_A, {
      layer: 'profile',
      content: 'Tema rust: prefiere rustfmt.',
      rateLimit: false,
    });
    await compaction.record(USER_A, {
      layer: 'log',
      content: 'Log rust: crate serde en el API.',
      rateLimit: false,
    });
    curated.setNotes(USER_A, [{
      id: 'n1',
      text: 'Nota rust: historial de crates antiguos.',
      sourceCount: 3,
      createdAt: 1,
    }]);
    const ranked = compaction.retrieve(USER_A, 'rust');
    assert.equal(ranked.ok, true);
    assert.deepEqual(ranked.hits.map((hit) => hit.layer), ['profile', 'log', 'notes']);
    assert.ok(ranked.hits[0].text.includes('rustfmt'));
  });

  test('empty query still returns profile then log then notes', async () => {
    wipe();
    await compaction.record(USER_A, { layer: 'profile', content: 'p-empty', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'l-empty', rateLimit: false });
    curated.setNotes(USER_A, [{ id: 'n-empty', text: 'n-empty', sourceCount: 1, createdAt: 2 }]);
    const ranked = compaction.retrieve(USER_A, '');
    assert.deepEqual(ranked.hits.map((hit) => hit.layer), ['profile', 'log', 'notes']);
  });

  test('within the log layer, higher overlap wins', async () => {
    wipe();
    await compaction.record(USER_A, { layer: 'log', content: 'deploy staging only', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'deploy staging postgres replica', rateLimit: false });
    const ranked = compaction.retrieve(USER_A, 'deploy staging postgres');
    assert.equal(ranked.hits[0].layer, 'log');
    assert.match(ranked.hits[0].text, /postgres replica/);
  });

  test('retrieve honors limit', async () => {
    wipe();
    await compaction.record(USER_A, { layer: 'profile', content: 'lim-a', rateLimit: false });
    await compaction.record(USER_A, { layer: 'log', content: 'lim-b', rateLimit: false });
    curated.setNotes(USER_A, [{ id: 'lim-n', text: 'lim-c', sourceCount: 1, createdAt: 1 }]);
    const ranked = compaction.retrieve(USER_A, 'lim', { limit: 1 });
    assert.equal(ranked.hits.length, 1);
    assert.equal(ranked.hits[0].layer, 'profile');
  });
});

describe('hermes memory compaction — isolation and wiring', { concurrency: 1 }, () => {
  test('user B cannot retrieve user A profile, log, or notes', async () => {
    wipe();
    await compaction.record(USER_A, {
      layer: 'profile',
      content: 'secreto-de-a perfil',
      rateLimit: false,
    });
    await compaction.record(USER_A, {
      layer: 'log',
      content: 'secreto-de-a log',
      rateLimit: false,
    });
    curated.setNotes(USER_A, [{ id: 'na', text: 'secreto-de-a nota', sourceCount: 1, createdAt: 1 }]);
    const foreign = compaction.retrieve(USER_B, 'secreto-de-a');
    assert.equal(foreign.hits.length, 0);
    assert.deepEqual(compaction.readSession(USER_B).profile, []);
    assert.deepEqual(compaction.readSession(USER_B).notes, []);
  });

  test('missing userId never writes and never leaks', async () => {
    wipe();
    const added = await compaction.record('', { layer: 'log', content: 'ghost' });
    assert.equal(added.ok, false);
    assert.match(added.error, /Falta el usuario/);
    assert.equal(compaction.retrieve(null, 'ghost').hits.length, 0);
    assert.equal(curated.read(USER_A, { target: 'memory' }).count, 0);
  });

  test('notes survive an in-memory reset via disk hydrate', async () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'disk-old-1' });
    curated.add(USER_A, { target: 'memory', content: 'disk-old-2' });
    curated.add(USER_A, { target: 'memory', content: 'disk-new-3' });
    const folded = compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      summarizer: () => 'nota persistida en disco',
    });
    assert.equal(folded.ok, true);
    curated.resetForTests();
    compaction.resetForTests();
    const reloaded = compaction.readSession(USER_A);
    assert.ok(reloaded.notes.some((note) => note.text.includes('persistida')));
    assert.deepEqual(reloaded.log, ['disk-new-3']);
  });

  test('bridge retrieve and compact are user-scoped', async () => {
    wipe();
    await memoryBridge.recordSession(USER_A, {
      layer: 'profile',
      content: 'bridge-perfil-unico',
      rateLimit: false,
    });
    const hits = memoryBridge.retrieveRanked(USER_A, 'bridge-perfil');
    assert.ok(hits.hits.some((hit) => hit.layer === 'profile'));
    assert.equal(memoryBridge.retrieveRanked(USER_B, 'bridge-perfil').hits.length, 0);
    const st = memoryBridge.status(USER_A);
    assert.equal(st.compaction.pattern, 'hermes-session-compaction');
  });

  test('memory tool compact and retrieve stay isolated', async () => {
    wipe();
    const tool = memoryTool();
    await tool.execute({ action: 'add', target: 'memory', content: 'tool-old-1' }, { userId: USER_A });
    await tool.execute({ action: 'add', target: 'memory', content: 'tool-old-2' }, { userId: USER_A });
    await tool.execute({ action: 'add', target: 'memory', content: 'tool-new-3' }, { userId: USER_A });
    const folded = await tool.execute({ action: 'compact' }, { userId: USER_A });
    assert.equal(folded.ok, true);
    const ranked = await tool.execute({ action: 'retrieve', query: 'tool' }, { userId: USER_A });
    assert.ok(ranked.hits.length >= 1);
    const foreign = await tool.execute({ action: 'retrieve', query: 'tool' }, { userId: USER_B });
    assert.equal(foreign.hits.length, 0);
  });

  test('playbook map lists the native compaction slice', () => {
    const entry = FOLDER_CAPABILITY_MAP.find((row) => row.sira.includes('hermes-memory-compaction.js'));
    assert.ok(entry);
    assert.equal(entry.status, 'integrated');
    assert.match(entry.strategy, /profile/);
  });

  test('unknown layer is rejected in Spanish', async () => {
    wipe();
    const bad = await compaction.record(USER_A, { layer: 'dreams', content: 'nope' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /capa debe ser/);
  });
});
