'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const curated = require('../src/services/agents/hermes-curated-memory');
const compaction = require('../src/services/agents/hermes-memory-compaction');
const portability = require('../src/services/agents/hermes-memory-portability');
const memoryBridge = require('../src/services/agents/hermes-memory-bridge');
const { buildHermesTools } = require('../src/services/agents/hermes-tools');
const { runHermesCommand } = require('../src/services/agents/hermes-cli-bridge');
const { FOLDER_CAPABILITY_MAP } = require('../src/services/agents/hermes-playbook-bridge');

const USER_A = 'port-mem-user-a';
const USER_B = 'port-mem-user-b';

function wipe() {
  curated.clearUser(USER_A);
  curated.clearUser(USER_B);
  curated.resetForTests();
  compaction.resetForTests();
}

function memoryTool() {
  return buildHermesTools().find((tool) => tool.name === 'memory');
}

function seedProfileAndNotes(userId) {
  curated.add(userId, { target: 'user', content: 'Prefiere respuestas cortas en español.', rateLimit: false });
  curated.add(userId, { target: 'user', content: 'Trabaja en zona horaria America/Mexico_City.', rateLimit: false });
  curated.add(userId, { target: 'memory', content: 'Log local que no debe viajar en el snapshot.', rateLimit: false });
  curated.setNotes(userId, [{
    id: 'note_seed_1',
    text: 'Resumen de 2 notas: backlog Q3 · deploy viernes.',
    sourceCount: 2,
    createdAt: 1_700_000_000_000,
  }]);
}

before(() => {
  wipe();
});

after(() => {
  wipe();
});

describe('hermes memory portability — export checksums', { concurrency: 1 }, () => {
  test('empty profile+notes export still carries a valid sha256 checksum', () => {
    wipe();
    const exported = portability.exportSnapshot(USER_A);
    assert.equal(exported.ok, true);
    assert.equal(exported.snapshot.kind, portability.KIND);
    assert.equal(exported.snapshot.version, 1);
    assert.deepEqual(exported.snapshot.profile, []);
    assert.deepEqual(exported.snapshot.notes, []);
    assert.match(exported.checksum, /^sha256:[0-9a-f]{64}$/);
    const expected = portability.computeChecksum([], [], exported.snapshot.ownerFingerprint);
    assert.equal(portability.checksumsMatch(exported.checksum, expected), true);
  });

  test('export includes profile and compacted notes but not the raw MEMORY log', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const exported = portability.exportSnapshot(USER_A);
    assert.equal(exported.ok, true);
    assert.ok(exported.snapshot.profile.includes('Prefiere respuestas cortas en español.'));
    assert.equal(exported.snapshot.notes.length, 1);
    assert.match(exported.snapshot.notes[0].text, /backlog Q3/);
    assert.equal(
      exported.snapshot.profile.some((row) => /Log local/.test(row)),
      false,
    );
    assert.equal(JSON.stringify(exported.snapshot).includes('Log local'), false);
  });

  test('checksum covers the canonical payload and rejects a tampered profile', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const exported = portability.exportSnapshot(USER_A);
    const tampered = {
      ...exported.snapshot,
      profile: [...exported.snapshot.profile, 'dato inyectado'],
    };
    const imported = portability.importSnapshot(USER_A, tampered);
    assert.equal(imported.ok, false);
    assert.equal(imported.code, 'E_CONTENT');
    assert.match(imported.error, /checksum del snapshot no coincide/);
  });

  test('missing checksum is rejected in Spanish with E_PARAMS', () => {
    wipe();
    const exported = portability.exportSnapshot(USER_A);
    const { checksum, ...bare } = exported.snapshot;
    assert.ok(checksum);
    const imported = portability.importSnapshot(USER_A, bare);
    assert.equal(imported.ok, false);
    assert.equal(imported.code, 'E_PARAMS');
    assert.match(imported.error, /Falta el checksum/);
  });

  test('unsupported checksum algorithm is rejected', () => {
    wipe();
    const exported = portability.exportSnapshot(USER_A);
    const imported = portability.importSnapshot(USER_A, {
      ...exported.snapshot,
      checksum: `md5:${'a'.repeat(32)}`,
    });
    assert.equal(imported.ok, false);
    assert.equal(imported.code, 'E_CONTENT');
    assert.match(imported.error, /checksum del snapshot no coincide/);
  });
});

describe('hermes memory portability — import restore', { concurrency: 1 }, () => {
  test('round-trip restore replaces profile and notes and leaves the log alone', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const exported = portability.exportSnapshot(USER_A);
    curated.clearUser(USER_A);
    curated.add(USER_A, { target: 'memory', content: 'Log posterior al wipe.', rateLimit: false });
    curated.add(USER_A, { target: 'user', content: 'Dato viejo que replace debe quitar.', rateLimit: false });

    const imported = portability.importSnapshot(USER_A, exported.snapshot);
    assert.equal(imported.ok, true);
    assert.equal(imported.mode, 'replace');

    const session = compaction.readSession(USER_A);
    assert.deepEqual(session.profile, exported.snapshot.profile);
    assert.equal(session.notes.length, 1);
    assert.equal(session.notes[0].text, exported.snapshot.notes[0].text);
    assert.ok(session.log.includes('Log posterior al wipe.'));
    assert.equal(session.profile.includes('Dato viejo que replace debe quitar.'), false);
  });

  test('merge keeps existing profile facts and appends new notes', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Ya estaba en el perfil.', rateLimit: false });
    curated.setNotes(USER_A, [{ id: 'keep', text: 'Nota previa', sourceCount: 1, createdAt: 1 }]);

    const incoming = {
      kind: portability.KIND,
      version: 1,
      ownerFingerprint: portability.ownerFingerprint(USER_A),
      profile: ['Hecho nuevo de perfil.'],
      notes: [{ id: 'n2', text: 'Nota importada', sourceCount: 3, createdAt: 2 }],
    };
    incoming.checksum = portability.computeChecksum(
      incoming.profile,
      incoming.notes,
      incoming.ownerFingerprint,
    );

    const imported = portability.importSnapshot(USER_A, incoming, { mode: 'merge' });
    assert.equal(imported.ok, true);
    assert.equal(imported.mode, 'merge');
    const session = compaction.readSession(USER_A);
    assert.ok(session.profile.includes('Ya estaba en el perfil.'));
    assert.ok(session.profile.includes('Hecho nuevo de perfil.'));
    assert.equal(session.notes.length, 2);
  });

  test('survives in-memory reset by hydrating imported stores from disk', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const exported = portability.exportSnapshot(USER_A);
    curated.clearUser(USER_A);
    assert.equal(portability.importSnapshot(USER_A, exported.snapshot).ok, true);
    curated.resetForTests();
    const afterReload = compaction.readSession(USER_A);
    assert.ok(afterReload.profile.includes('Prefiere respuestas cortas en español.'));
    assert.equal(afterReload.notes.length, 1);
  });

  test('empty replace snapshot clears profile and notes only', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const empty = portability.exportSnapshot(USER_B);
    const imported = portability.importSnapshot(USER_A, empty.snapshot);
    assert.equal(imported.ok, true);
    const session = compaction.readSession(USER_A);
    assert.deepEqual(session.profile, []);
    assert.deepEqual(session.notes, []);
    assert.ok(session.log.includes('Log local que no debe viajar en el snapshot.'));
  });

  test('invalid JSON string is rejected in Spanish', () => {
    wipe();
    const imported = portability.importSnapshot(USER_A, '{not-json');
    assert.equal(imported.ok, false);
    assert.equal(imported.code, 'E_PARAMS');
    assert.match(imported.error, /no es JSON válido/);
  });

  test('missing snapshot payload is rejected in Spanish', () => {
    wipe();
    const imported = portability.importSnapshot(USER_A, null);
    assert.equal(imported.ok, false);
    assert.match(imported.error, /Falta el snapshot/);
  });

  test('incompatible snapshot version is rejected', () => {
    wipe();
    const exported = portability.exportSnapshot(USER_A);
    const imported = portability.importSnapshot(USER_A, { ...exported.snapshot, version: 99 });
    assert.equal(imported.ok, false);
    assert.match(imported.error, /versión del snapshot/);
  });
});

describe('hermes memory portability — isolation and size caps', { concurrency: 1 }, () => {
  test('export is isolated per user', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    curated.add(USER_B, { target: 'user', content: 'Secreto de B.', rateLimit: false });
    const fromA = portability.exportSnapshot(USER_A);
    const fromB = portability.exportSnapshot(USER_B);
    assert.equal(fromA.snapshot.profile.includes('Secreto de B.'), false);
    assert.equal(fromB.snapshot.profile.includes('Prefiere respuestas cortas en español.'), false);
    assert.ok(fromB.snapshot.profile.includes('Secreto de B.'));
  });

  test('import always writes to the caller, never to a foreign snapshot owner', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const fromA = portability.exportSnapshot(USER_A);
    const imported = portability.importSnapshot(USER_B, fromA.snapshot);
    assert.equal(imported.ok, true);
    const sessionB = compaction.readSession(USER_B);
    const sessionA = compaction.readSession(USER_A);
    assert.ok(sessionB.profile.includes('Prefiere respuestas cortas en español.'));
    assert.ok(sessionA.profile.includes('Prefiere respuestas cortas en español.'));
    assert.equal(sessionA.profile.includes('Secreto de B.'), false);
  });

  test('requireSameOwner blocks a foreign snapshot', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const fromA = portability.exportSnapshot(USER_A);
    const imported = portability.importSnapshot(USER_B, fromA.snapshot, { requireSameOwner: true });
    assert.equal(imported.ok, false);
    assert.match(imported.error, /pertenece a otro usuario/);
    assert.deepEqual(compaction.readSession(USER_B).profile, []);
  });

  test('session user cannot target another userId', () => {
    wipe();
    const denied = portability.resolveCallerUserId(USER_B, {
      sessionUserId: USER_A,
      action: 'export',
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /otro usuario/);
  });

  test('missing userId is rejected in Spanish', () => {
    const exported = portability.exportSnapshot('');
    assert.equal(exported.ok, false);
    assert.equal(exported.code, 'E_PARAMS');
    assert.match(exported.error, /Falta el usuario para exportar/);
    const imported = portability.importSnapshot('   ', { kind: portability.KIND });
    assert.match(imported.error, /Falta el usuario para importar/);
  });

  test('snapshot over the byte cap is rejected before apply', () => {
    wipe();
    const huge = `${'x'.repeat(portability.SNAPSHOT_MAX_BYTES + 8)}`;
    const imported = portability.importSnapshot(USER_A, huge);
    assert.equal(imported.ok, false);
    assert.equal(imported.code, 'E_PARAMS');
    assert.match(imported.error, /supera el límite/);
    assert.equal(imported.limit, portability.SNAPSHOT_MAX_BYTES);
  });

  test('imported profile over the USER store cap fails closed', () => {
    wipe();
    const profile = [];
    let guard = 0;
    while (portability.PROFILE_CHAR_LIMIT - profile.join('\n§\n').length > 40 && guard < 40) {
      profile.push(`Perfil largo importado número ${guard} con texto extra.`);
      guard += 1;
    }
    profile.push('x'.repeat(80));
    const snapshot = {
      kind: portability.KIND,
      version: 1,
      ownerFingerprint: portability.ownerFingerprint(USER_A),
      profile,
      notes: [],
    };
    snapshot.checksum = portability.computeChecksum(profile, [], snapshot.ownerFingerprint);
    const imported = portability.importSnapshot(USER_A, snapshot);
    assert.equal(imported.ok, false);
    assert.match(imported.error, /perfil importado supera/);
    assert.deepEqual(compaction.readSession(USER_A).profile, []);
  });

  test('imported notes over the notes store cap fail closed', () => {
    wipe();
    const notes = [];
    for (let i = 0; i < 8; i += 1) {
      notes.push({
        id: `n${i}`,
        text: `Nota compactada ${i} ${'n'.repeat(300)}`,
        sourceCount: 1,
        createdAt: i,
      });
    }
    const snapshot = {
      kind: portability.KIND,
      version: 1,
      ownerFingerprint: portability.ownerFingerprint(USER_A),
      profile: [],
      notes,
    };
    snapshot.checksum = portability.computeChecksum([], notes, snapshot.ownerFingerprint);
    const imported = portability.importSnapshot(USER_A, snapshot);
    assert.equal(imported.ok, false);
    assert.match(imported.error, /notas compactadas importadas superan/);
    assert.deepEqual(compaction.readSession(USER_A).notes, []);
  });

  test('a single imported fact over FACT_MAX_CHARS is rejected', () => {
    wipe();
    const profile = [`${'z'.repeat(portability.FACT_MAX_CHARS + 1)}`];
    const snapshot = {
      kind: portability.KIND,
      version: 1,
      ownerFingerprint: portability.ownerFingerprint(USER_A),
      profile,
      notes: [],
    };
    snapshot.checksum = portability.computeChecksum(profile, [], snapshot.ownerFingerprint);
    const imported = portability.importSnapshot(USER_A, snapshot);
    assert.equal(imported.ok, false);
    assert.equal(imported.code, 'E_PARAMS');
    assert.match(imported.error, /límite de 2000 caracteres/);
  });

  test('a single imported note over NOTE_MAX_CHARS is rejected', () => {
    wipe();
    const notes = [{
      id: 'too-big',
      text: 'n'.repeat(portability.NOTE_MAX_CHARS + 1),
      sourceCount: 1,
      createdAt: 1,
    }];
    const snapshot = {
      kind: portability.KIND,
      version: 1,
      ownerFingerprint: portability.ownerFingerprint(USER_A),
      profile: [],
      notes,
    };
    snapshot.checksum = portability.computeChecksum([], notes, snapshot.ownerFingerprint);
    const imported = portability.importSnapshot(USER_A, snapshot);
    assert.equal(imported.ok, false);
    assert.match(imported.error, /nota compactada supera/);
  });

  test('secret-looking imported profile is blocked with E_CONTENT', () => {
    wipe();
    const profile = ['El usuario pegó un api_key en el perfil y no debe guardarse.'];
    const snapshot = {
      kind: portability.KIND,
      version: 1,
      ownerFingerprint: portability.ownerFingerprint(USER_A),
      profile,
      notes: [],
    };
    snapshot.checksum = portability.computeChecksum(profile, [], snapshot.ownerFingerprint);
    const imported = portability.importSnapshot(USER_A, snapshot);
    assert.equal(imported.ok, false);
    assert.equal(imported.code, 'E_CONTENT');
    assert.match(imported.error, /no es seguro para guardar/);
    assert.deepEqual(compaction.readSession(USER_A).profile, []);
  });

  test('merge does not write when the combined profile would overflow', () => {
    wipe();
    const filler = 'Perfil fijo local que ya ocupa espacio.';
    let guard = 0;
    while (guard < 40) {
      const live = curated.read(USER_A, { target: 'user' });
      if ((live.used || 0) > portability.PROFILE_CHAR_LIMIT - 90) break;
      const next = curated.add(USER_A, {
        target: 'user',
        content: `${filler} ${guard}`,
        rateLimit: false,
      });
      if (!next.ok) break;
      guard += 1;
    }
    const before = compaction.readSession(USER_A).profile.slice();
    const incoming = [`Dato extra que ya no cabe ${'y'.repeat(80)}`];
    const snapshot = {
      kind: portability.KIND,
      version: 1,
      ownerFingerprint: portability.ownerFingerprint(USER_A),
      profile: incoming,
      notes: [],
    };
    snapshot.checksum = portability.computeChecksum(incoming, [], snapshot.ownerFingerprint);
    const imported = portability.importSnapshot(USER_A, snapshot, { mode: 'merge' });
    assert.equal(imported.ok, false);
    assert.match(imported.error, /perfil importado supera/);
    assert.deepEqual(compaction.readSession(USER_A).profile, before);
  });
});

describe('hermes memory portability — bridge, tool, CLI, map, routes', { concurrency: 1 }, () => {
  test('memory bridge export/import wrappers round-trip', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const exported = memoryBridge.exportSnapshot(USER_A);
    assert.equal(exported.ok, true);
    curated.clearUser(USER_A);
    const imported = memoryBridge.importSnapshot(USER_A, exported.snapshot);
    assert.equal(imported.ok, true);
    assert.ok(compaction.readSession(USER_A).profile.length >= 2);
  });

  test('memory tool export/import actions stay isolated', async () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const tool = memoryTool();
    const exported = await tool.execute({ action: 'export' }, { userId: USER_A });
    assert.equal(exported.ok, true);
    const foreign = await tool.execute({ action: 'export' }, { userId: USER_B });
    assert.equal(foreign.snapshot.profile.length, 0);
    const imported = await tool.execute(
      { action: 'import', snapshot: exported.snapshot },
      { userId: USER_B },
    );
    assert.equal(imported.ok, true);
    assert.ok(compaction.readSession(USER_B).profile.includes('Prefiere respuestas cortas en español.'));
  });

  test('CLI memory export/import uses the same checksum path', () => {
    wipe();
    seedProfileAndNotes(USER_A);
    const exported = runHermesCommand('memory', { userId: USER_A, action: 'export' });
    assert.equal(exported.ok, true);
    assert.equal(exported.command, 'memory');
    curated.clearUser(USER_A);
    const imported = runHermesCommand('memory', {
      userId: USER_A,
      action: 'import',
      snapshot: exported.snapshot,
    });
    assert.equal(imported.ok, true);
  });

  test('playbook map lists the native portability slice', () => {
    const entry = FOLDER_CAPABILITY_MAP.find((row) => row.sira.includes('hermes-memory-portability.js'));
    assert.ok(entry);
    assert.equal(entry.status, 'integrated');
    assert.equal(entry.hermes, 'memories');
    assert.match(entry.strategy, /checksum/);
    assert.equal(entry.sira.includes('.agents/hermes-upstream'), false);
  });

  test('status advertises checksum algorithm and caps without vendor names', () => {
    const status = portability.status();
    assert.equal(status.checksumAlg, 'sha256');
    assert.equal(status.snapshotMaxBytes, portability.SNAPSHOT_MAX_BYTES);
    assert.deepEqual(status.layers, ['profile', 'notes']);
    assert.equal(JSON.stringify(status).toLowerCase().includes('openrouter'), false);
    assert.ok(memoryBridge.status(USER_A).providers.includes('hermes-memory-portability'));
  });

  test('hermes routes bind export/import to the authenticated session user', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/hermes.js'), 'utf8');
    assert.match(src, /\/memory\/export/);
    assert.match(src, /\/memory\/import/);
    assert.match(src, /sessionUserId: req\.user\?\.id/);
    assert.match(src, /authenticateToken/);
  });

  test('stableSerialize is key-order independent so checksums stay stable', () => {
    const left = portability.stableSerialize({ b: 1, a: { z: 2, y: [3, 1] } });
    const right = portability.stableSerialize({ a: { y: [3, 1], z: 2 }, b: 1 });
    assert.equal(left, right);
    assert.equal(
      portability.checksumsMatch(
        portability.computeChecksum(['uno'], [], 'abcd'),
        portability.computeChecksum(['uno'], [], 'abcd'),
      ),
      true,
    );
  });

  test('import of a foreign kind is rejected', () => {
    wipe();
    const snapshot = {
      kind: 'other.snapshot',
      version: 1,
      ownerFingerprint: portability.ownerFingerprint(USER_A),
      profile: [],
      notes: [],
    };
    snapshot.checksum = portability.computeChecksum([], [], snapshot.ownerFingerprint);
    const imported = portability.importSnapshot(USER_A, snapshot);
    assert.equal(imported.ok, false);
    assert.match(imported.error, /no es válido/);
  });
});
