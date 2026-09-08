'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const curated = require('../src/services/agents/hermes-curated-memory');
const compaction = require('../src/services/agents/hermes-memory-compaction');
const portability = require('../src/services/agents/hermes-memory-portability');
const memoryBridge = require('../src/services/agents/hermes-memory-bridge');
const { buildHermesTools, hermesRememberTool, hermesForgetTool, hermesRecordarTool, hermesOlvidarTool } = require('../src/services/agents/hermes-tools');
const { runHermesCommand } = require('../src/services/agents/hermes-cli-bridge');
const { FOLDER_CAPABILITY_MAP } = require('../src/services/agents/hermes-playbook-bridge');

const USER_A = 'promo-mem-user-a';
const USER_B = 'promo-mem-user-b';

function wipe() {
  curated.clearUser(USER_A);
  curated.clearUser(USER_B);
  curated.resetForTests();
  compaction.resetForTests();
}

function memoryTool() {
  return buildHermesTools().find((tool) => tool.name === 'memory');
}

function toolByName(name) {
  return buildHermesTools().find((tool) => tool.name === name);
}

before(() => {
  wipe();
});

after(() => {
  wipe();
});

describe('hermes MEMORY→USER promotion with provenance', { concurrency: 1 }, () => {
  test('promotes a MEMORY note into USER and records provenance', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'Prefiere rustfmt en todos los crates.', rateLimit: false });
    const promoted = curated.promoteMemoryToUser(USER_A, {
      old_text: 'rustfmt',
      now: 1_700_000_100_000,
      reason: 'explicit',
    });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.promoted, true);
    assert.equal(promoted.provenance.from, 'memory');
    assert.match(promoted.provenance.sourceText, /rustfmt/);
    assert.equal(promoted.provenance.promotedAt, 1_700_000_100_000);
    assert.deepEqual(compaction.readSession(USER_A).profile, ['Prefiere rustfmt en todos los crates.']);
    assert.equal(compaction.readSession(USER_A).log.includes('Prefiere rustfmt en todos los crates.'), false);
    const facts = curated.listFacts(USER_A);
    const userFact = facts.find((row) => row.store === 'user');
    assert.ok(userFact.provenance);
    assert.equal(userFact.provenance.from, 'memory');
  });

  test('provenance survives an in-memory reset via disk hydrate', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'Zona horaria America/Bogota.', rateLimit: false });
    assert.equal(curated.promoteMemoryToUser(USER_A, { old_text: 'Bogota', now: 9 }).ok, true);
    curated.resetForTests();
    const facts = curated.listFacts(USER_A);
    assert.ok(facts.some((row) => row.store === 'user' && row.provenance && row.provenance.from === 'memory'));
    assert.ok(curated.listPromotions(USER_A).some((row) => row.sourceText.includes('Bogota')));
  });

  test('already-present USER fact is not duplicated and MEMORY is dropped', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Idioma: español.', rateLimit: false });
    curated.add(USER_A, { target: 'memory', content: 'Idioma: español.', rateLimit: false });
    const promoted = curated.promoteMemoryToUser(USER_A, { old_text: 'Idioma' });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.alreadyPresent, true);
    assert.equal(curated.read(USER_A, { target: 'user' }).count, 1);
    assert.equal(curated.read(USER_A, { target: 'memory' }).count, 0);
  });

  test('conflicting USER slot fails closed without resolve', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Timezone: America/Mexico_City', rateLimit: false });
    curated.add(USER_A, { target: 'memory', content: 'Timezone: Europe/Madrid', rateLimit: false });
    const blocked = curated.promoteMemoryToUser(USER_A, { old_text: 'Europe/Madrid' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'E_PARAMS');
    assert.match(blocked.error, /conflicto de perfil/);
    assert.ok(curated.read(USER_A, { target: 'memory' }).entries.includes('Timezone: Europe/Madrid'));
    assert.ok(curated.read(USER_A, { target: 'user' }).entries.includes('Timezone: America/Mexico_City'));
  });

  test('resolve=replace overwrites the conflicting USER fact', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Timezone: America/Mexico_City', rateLimit: false });
    curated.add(USER_A, { target: 'memory', content: 'Timezone: Europe/Madrid', rateLimit: false });
    const promoted = curated.promoteMemoryToUser(USER_A, {
      old_text: 'Europe/Madrid',
      resolve: 'replace',
    });
    assert.equal(promoted.ok, true);
    const profile = curated.read(USER_A, { target: 'user' }).entries;
    assert.ok(profile.includes('Timezone: Europe/Madrid'));
    assert.equal(profile.includes('Timezone: America/Mexico_City'), false);
  });

  test('resolve=keep_user keeps the profile and drops MEMORY', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Timezone: America/Mexico_City', rateLimit: false });
    curated.add(USER_A, { target: 'memory', content: 'Timezone: Europe/Madrid', rateLimit: false });
    const promoted = curated.promoteMemoryToUser(USER_A, {
      old_text: 'Europe/Madrid',
      resolve: 'keep_user',
    });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.skipped, true);
    assert.deepEqual(curated.read(USER_A, { target: 'user' }).entries, ['Timezone: America/Mexico_City']);
    assert.equal(curated.read(USER_A, { target: 'memory' }).count, 0);
  });

  test('user B cannot promote or read user A provenance', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'secreto-de-a promocion', rateLimit: false });
    const foreign = curated.promoteMemoryToUser(USER_B, { old_text: 'secreto-de-a' });
    assert.equal(foreign.ok, false);
    assert.match(foreign.error, /Ninguna nota de MEMORY/);
    assert.equal(curated.listPromotions(USER_B).length, 0);
    assert.ok(curated.read(USER_A, { target: 'memory' }).entries.some((row) => row.includes('secreto-de-a')));
  });

  test('missing userId never promotes', () => {
    wipe();
    const blocked = curated.promoteMemoryToUser('', { old_text: 'nada' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Falta el usuario/);
  });

  test('USER overflow keeps MEMORY and fails in Spanish', () => {
    wipe();
    const filler = 'Perfil fijo que ya ocupa espacio extra.';
    let guard = 0;
    while (guard < 40) {
      const added = curated.add(USER_A, { target: 'user', content: `${filler} ${guard}`, rateLimit: false });
      if (!added.ok) break;
      guard += 1;
    }
    curated.add(USER_A, {
      target: 'memory',
      content: `Dato extra que ya no cabe ${'y'.repeat(80)}`,
      rateLimit: false,
    });
    const blocked = curated.promoteMemoryToUser(USER_A, { old_text: 'Dato extra' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /perfil está lleno/);
    assert.ok(curated.read(USER_A, { target: 'memory' }).entries.some((row) => row.includes('Dato extra')));
  });
});

describe('hermes compacted-note TTL', { concurrency: 1 }, () => {
  test('compactLog stamps expiresAt = createdAt + TTL', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'ttl-old-1', rateLimit: false });
    curated.add(USER_A, { target: 'memory', content: 'ttl-old-2', rateLimit: false });
    curated.add(USER_A, { target: 'memory', content: 'ttl-new-3', rateLimit: false });
    const folded = compaction.compactLog(USER_A, {
      force: true,
      keepRecent: 1,
      now: 1_000,
      noteTtlMs: 5_000,
      summarizer: () => 'nota con vencimiento',
    });
    assert.equal(folded.ok, true);
    const note = compaction.readSession(USER_A, { now: 1_000 }).notes[0];
    assert.ok(note);
    assert.equal(note.expiresAt, 6_000);
    assert.equal(note.createdAt, 1_000);
  });

  test('expired notes are purged from retrieve and the frozen snapshot', () => {
    wipe();
    curated.setNotes(USER_A, [{
      id: 'expired',
      text: 'nota vencida rust',
      sourceCount: 2,
      createdAt: 1,
      expiresAt: 10,
    }]);
    const ranked = compaction.retrieve(USER_A, 'rust', { now: 20 });
    assert.equal(ranked.hits.some((hit) => hit.layer === 'notes'), false);
    const block = curated.getFrozenPromptBlock(USER_A, { chatId: 'ttl-chat', now: 20 });
    assert.equal(block.includes('nota vencida rust'), false);
    assert.equal(curated.listNotes(USER_A, { now: 20 }).length, 0);
  });

  test('unexpired notes still rank below profile and log', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Tema rust: rustfmt.', rateLimit: false });
    curated.add(USER_A, { target: 'memory', content: 'Log rust: serde.', rateLimit: false });
    curated.setNotes(USER_A, [{
      id: 'live',
      text: 'Nota rust: historial.',
      sourceCount: 1,
      createdAt: 1,
      expiresAt: Date.now() + 86_400_000,
    }]);
    const ranked = compaction.retrieve(USER_A, 'rust');
    assert.deepEqual(ranked.hits.map((hit) => hit.layer), ['profile', 'log', 'notes']);
  });

  test('legacy notes without expiresAt stay sticky', () => {
    wipe();
    curated.setNotes(USER_A, [{ id: 'legacy', text: 'nota pegajosa', sourceCount: 1, createdAt: 1 }]);
    assert.equal(curated.listNotes(USER_A, { now: Date.now() }).length, 1);
    assert.ok(compaction.retrieve(USER_A, 'pegajosa').hits.some((hit) => hit.text.includes('pegajosa')));
  });

  test('TTL never expires USER or MEMORY facts', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'dato de perfil eterno', rateLimit: false });
    curated.add(USER_A, { target: 'memory', content: 'dato de bitacora eterno', rateLimit: false });
    curated.setNotes(USER_A, [{ id: 'gone', text: 'solo la nota muere', createdAt: 1, expiresAt: 2 }]);
    curated.listNotes(USER_A, { now: 3 });
    assert.ok(curated.read(USER_A, { target: 'user' }).entries.includes('dato de perfil eterno'));
    assert.ok(curated.read(USER_A, { target: 'memory' }).entries.includes('dato de bitacora eterno'));
  });

  test('export/import restores expiresAt without breaking the v1 checksum', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Prefiere markdown.', rateLimit: false });
    const expiresAt = Date.now() + 86_400_000;
    curated.setNotes(USER_A, [{
      id: 'n-ttl',
      text: 'Resumen portable',
      sourceCount: 2,
      createdAt: 10,
      expiresAt,
    }]);
    const exported = portability.exportSnapshot(USER_A);
    assert.equal(exported.ok, true);
    assert.equal(exported.snapshot.notes[0].expiresAt, expiresAt);
    const expected = portability.computeChecksum(
      exported.snapshot.profile,
      exported.snapshot.notes.map(({ expiresAt, ...rest }) => rest),
      exported.snapshot.ownerFingerprint,
    );
    assert.equal(portability.checksumsMatch(exported.checksum, expected), true);
    curated.clearUser(USER_B);
    assert.equal(portability.importSnapshot(USER_B, exported.snapshot).ok, true);
    assert.equal(compaction.readSession(USER_B).notes[0].expiresAt, expiresAt);
  });

  test('status advertises noteTtlMs without vendor names', () => {
    const status = compaction.status(USER_A);
    assert.equal(status.noteTtlMs, compaction.NOTE_TTL_MS);
    assert.equal(JSON.stringify(status).toLowerCase().includes('openrouter'), false);
  });
});

describe('hermes Spanish remember/forget aliases', { concurrency: 1 }, () => {
  test('remember writes a generic fact to curated MEMORY', async () => {
    wipe();
    const result = await hermesRememberTool.execute(
      { fact: 'CI corre npm test en backend.' },
      { userId: USER_A },
    );
    assert.equal(result.ok, true);
    assert.equal(result.target, 'memory');
    assert.ok(curated.read(USER_A, { target: 'memory' }).entries.includes('CI corre npm test en backend.'));
  });

  test('remember sends a preference into USER', async () => {
    wipe();
    const result = await hermesRememberTool.execute(
      { fact: 'Prefiero TypeScript sobre JavaScript' },
      { userId: USER_A },
    );
    assert.equal(result.ok, true);
    assert.equal(result.target, 'user');
    assert.ok(curated.read(USER_A, { target: 'user' }).entries.includes('Prefiero TypeScript sobre JavaScript'));
  });

  test('recordar is a Spanish alias of remember', async () => {
    wipe();
    const result = await hermesRecordarTool.execute(
      { fact: 'Me gusta el modo oscuro.' },
      { userId: USER_A },
    );
    assert.equal(result.ok, true);
    assert.equal(result.target, 'user');
    assert.equal(result.provenance.actor, 'recordar');
  });

  test('forget and olvidar drop curated entries and stay isolated', async () => {
    wipe();
    const rememberedA = await hermesRememberTool.execute({ fact: 'marca-unica-xyz en el log' }, { userId: USER_A });
    assert.equal(rememberedA.ok, true);
    const rememberedB = await hermesRememberTool.execute({ fact: 'marca-unica-xyz en el log de B' }, { userId: USER_B });
    assert.equal(rememberedB.ok, true);
    const forgotten = await hermesForgetTool.execute({ query: 'marca-unica-xyz' }, { userId: USER_A });
    assert.equal(forgotten.ok, true);
    assert.ok(forgotten.removed >= 1);
    const leftover = [...curated.read(USER_A).memory.entries, ...curated.read(USER_A).user.entries].join('\n');
    assert.equal(leftover.includes('marca-unica-xyz'), false);
    assert.ok(curated.read(USER_B, { target: 'memory' }).entries.some((row) => row.includes('marca-unica-xyz')));

    await hermesRecordarTool.execute({ fact: 'dato-olvidar-abc' }, { userId: USER_A });
    const spanish = await hermesOlvidarTool.execute({ query: 'dato-olvidar-abc' }, { userId: USER_A });
    assert.equal(spanish.ok, true);
    assert.ok(spanish.removed >= 1);
  });

  test('remember and forget without userId fail in Spanish', async () => {
    const remembered = await hermesRememberTool.execute({ fact: 'nope' }, {});
    assert.equal(remembered.ok, false);
    assert.match(remembered.error, /Falta el userId/);
    const forgotten = await hermesForgetTool.execute({ query: 'nope' }, {});
    assert.equal(forgotten.ok, false);
    assert.match(forgotten.error, /Falta el userId/);
  });

  test('memory tool remember/forget/promote use curated stores', async () => {
    wipe();
    const tool = memoryTool();
    const remembered = await tool.execute(
      { action: 'remember', fact: 'Staging SSH escucha en 2222.' },
      { userId: USER_A },
    );
    assert.equal(remembered.ok, true);
    const forgotten = await tool.execute(
      { action: 'forget', query: '2222' },
      { userId: USER_A },
    );
    assert.equal(forgotten.ok, true);
    curated.add(USER_A, { target: 'memory', content: 'Prefiere tablas en markdown.', rateLimit: false });
    const promoted = await tool.execute(
      { action: 'promote', old_text: 'tablas en markdown' },
      { userId: USER_A },
    );
    assert.equal(promoted.ok, true);
    assert.ok(curated.read(USER_A, { target: 'user' }).entries.some((row) => row.includes('tablas en markdown')));
  });

  test('CLI remember/forget/promote share the curated path', () => {
    wipe();
    const remembered = runHermesCommand('memory', {
      userId: USER_A,
      action: 'recordar',
      fact: 'Prefiere respuestas cortas en español.',
    });
    assert.equal(remembered.ok, true);
    const promotedSeed = runHermesCommand('memory', {
      userId: USER_A,
      action: 'remember',
      fact: 'CI usa bunx tsc.',
    });
    assert.equal(promotedSeed.ok, true);
    const promoted = runHermesCommand('memory', {
      userId: USER_A,
      action: 'promote',
      old_text: 'bunx tsc',
    });
    assert.equal(promoted.ok, true);
    const forgotten = runHermesCommand('memory', {
      userId: USER_A,
      action: 'olvidar',
      query: 'respuestas cortas',
    });
    assert.equal(forgotten.ok, true);
  });

  test('buildHermesTools exposes remember/forget and Spanish aliases', () => {
    const names = new Set(buildHermesTools().map((tool) => tool.name));
    for (const expected of ['remember', 'forget', 'recordar', 'olvidar']) {
      assert.ok(names.has(expected), `missing tool ${expected}`);
    }
    assert.ok(toolByName('remember').description.includes('Alias en español'));
    assert.ok(toolByName('recordar').description.includes('Alias en español'));
  });

  test('playbook map lists promotion, TTL and Spanish aliases without an upstream dump', () => {
    const entry = FOLDER_CAPABILITY_MAP.find((row) => row.hermes === 'tools/memory_tool.py');
    assert.ok(entry);
    assert.equal(entry.status, 'integrated');
    assert.match(entry.strategy, /MEMORY→USER|MEMORY->USER|promotion/i);
    assert.match(entry.strategy, /TTL/i);
    assert.match(entry.strategy, /remember\/forget/);
    assert.equal(entry.sira.includes('.agents/hermes-upstream'), false);
    assert.equal(JSON.stringify(entry).toLowerCase().includes('openrouter'), false);
  });

  test('active code does not import the Hermes upstream snapshot', () => {
    const src = [
      fs.readFileSync(path.join(__dirname, '../src/services/agents/hermes-curated-memory.js'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '../src/services/agents/hermes-memory-compaction.js'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '../src/services/agents/hermes-tools.js'), 'utf8'),
    ].join('\n');
    assert.equal(src.includes('.agents/hermes-upstream'), false);
    assert.equal(/require\(['\"][^'\"]*openrouter/i.test(src), false);
    assert.equal(/api\.openrouter/i.test(src), false);
  });
});
