'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const curated = require('../src/services/agents/hermes-curated-memory');
const conflict = require('../src/services/agents/hermes-memory-conflict');
const memoryBridge = require('../src/services/agents/hermes-memory-bridge');
const { buildHermesTools } = require('../src/services/agents/hermes-tools');
const { runHermesCommand } = require('../src/services/agents/hermes-cli-bridge');
const { FOLDER_CAPABILITY_MAP } = require('../src/services/agents/hermes-playbook-bridge');

const USER_A = 'mem-conflict-user-a';
const USER_B = 'mem-conflict-user-b';

function wipe() {
  curated.clearUser(USER_A);
  curated.clearUser(USER_B);
  curated.resetForTests();
}

function memoryTool() {
  return buildHermesTools().find((tool) => tool.name === 'memory');
}

function deposits() {
  return [];
}

function saveStub(bucket) {
  return (artifact) => {
    const id = `art_${bucket.length + 1}`;
    const row = {
      id,
      filename: artifact.filename,
      brandLabel: artifact.brandLabel,
      kind: artifact.kind,
      ownerUserId: artifact.ownerUserId,
      body: Buffer.from(artifact.base64, 'base64').toString('utf8'),
    };
    bucket.push(row);
    return row;
  };
}

before(() => {
  wipe();
});

after(() => {
  wipe();
});

describe('hermes memory conflict — slot extraction', { concurrency: 1 }, () => {
  test('extracts timezone from Spanish profile copy', () => {
    const slots = conflict.extractSlots('Trabaja en zona horaria America/Mexico_City.');
    assert.deepEqual(slots, [{ key: 'timezone', value: 'america/mexico_city' }]);
  });

  test('extracts timezone from English memory copy', () => {
    const slots = conflict.extractSlots('Timezone is UTC');
    assert.deepEqual(slots, [{ key: 'timezone', value: 'utc' }]);
  });

  test('extracts prefers_lang from the first language after the verb', () => {
    const slots = conflict.extractSlots('Prefiero TypeScript sobre JavaScript');
    assert.ok(slots.some((slot) => slot.key === 'prefers_lang' && slot.value === 'typescript'));
    assert.equal(slots.filter((slot) => slot.key === 'prefers_lang').length, 1);
  });

  test('extracts theme dark vs light in both languages', () => {
    assert.ok(conflict.extractSlots('User prefers dark mode').some((s) => s.key === 'theme' && s.value === 'dark'));
    assert.ok(conflict.extractSlots('Prefiere modo claro').some((s) => s.key === 'theme' && s.value === 'light'));
  });

  test('extracts name and explicit key:value slots', () => {
    assert.ok(conflict.extractSlots('Mi nombre es Luis').some((s) => s.key === 'name' && s.value === 'luis'));
    assert.deepEqual(conflict.extractSlots('idioma: inglés'), [{ key: 'language', value: 'ingles' }]);
  });

  test('unrelated notes do not get a topic slot', () => {
    assert.deepEqual(conflict.extractSlots('El repo de docs vive en /workspace/docs.'), []);
    assert.deepEqual(conflict.extractSlots(''), []);
  });
});

describe('hermes memory conflict — detect and pick', { concurrency: 1 }, () => {
  test('different topics are not a conflict', () => {
    const groups = conflict.detectConflicts([
      { store: 'user', text: 'Trabaja en zona horaria America/Mexico_City.' },
      { store: 'memory', text: 'Prefiero TypeScript sobre JavaScript' },
    ]);
    assert.equal(groups.length, 0);
  });

  test('same key and same value is compatible', () => {
    const groups = conflict.detectConflicts([
      { store: 'user', text: 'Timezone is UTC' },
      { store: 'memory', text: 'timezone: UTC' },
    ]);
    assert.equal(groups.length, 0);
  });

  test('same key and different value is a conflict', () => {
    const groups = conflict.detectConflicts([
      { store: 'user', text: 'Trabaja en zona horaria America/Mexico_City.' },
      { store: 'memory', text: 'Timezone is UTC' },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, 'timezone');
    assert.ok(groups[0].values.includes('utc'));
    assert.ok(groups[0].values.includes('america/mexico_city'));
  });

  test('newer unpinned fact wins when nothing is pinned', () => {
    const winner = conflict.pickWinner([
      { store: 'user', text: 'Timezone is UTC', updatedAt: 10, pinned: false },
      { store: 'memory', text: 'Trabaja en zona horaria America/Mexico_City.', updatedAt: 99, pinned: false },
    ]);
    assert.match(winner.text, /Mexico_City/);
    assert.equal(winner.store, 'memory');
  });

  test('pinned USER profile wins over a newer MEMORY fact', () => {
    const winner = conflict.pickWinner([
      { store: 'user', text: 'Trabaja en zona horaria America/Mexico_City.', updatedAt: 10, pinned: true },
      { store: 'memory', text: 'Timezone is UTC', updatedAt: 500, pinned: false },
    ]);
    assert.match(winner.text, /Mexico_City/);
    assert.equal(winner.pinned, true);
  });

  test('pinned USER wins over a newer unpinned USER fact', () => {
    const winner = conflict.pickWinner([
      { store: 'user', text: 'Prefiero TypeScript sobre JavaScript', updatedAt: 1, pinned: true },
      { store: 'user', text: 'Prefiere JavaScript', updatedAt: 9, pinned: false },
    ]);
    assert.match(winner.text, /TypeScript/);
  });

  test('two pinned USER facts skip deletion of the loser', () => {
    const decision = conflict.resolveGroup({
      key: 'timezone',
      facts: [
        { store: 'user', text: 'Trabaja en zona horaria America/Mexico_City.', updatedAt: 20, pinned: true },
        { store: 'user', text: 'Timezone is UTC', updatedAt: 10, pinned: true },
      ],
    });
    assert.equal(decision.rule, 'perfil_fijado');
    assert.equal(decision.remove.length, 0);
    assert.equal(decision.skipped.length, 1);
    assert.match(decision.skipped[0].text, /UTC/);
  });
});

describe('hermes memory conflict — curated pin and apply', { concurrency: 1 }, () => {
  test('missing userId never writes and never leaks', () => {
    wipe();
    const pinned = curated.pin('', { old_text: 'zona' });
    assert.equal(pinned.ok, false);
    const resolved = conflict.resolveConflicts('', { deposit: false });
    assert.equal(resolved.ok, false);
    assert.match(resolved.error, /Falta el userId/);
    assert.equal(curated.listFacts(USER_B).length, 0);
  });

  test('pin is USER-only and persists across hydrate', () => {
    wipe();
    curated.add(USER_A, {
      target: 'user',
      content: 'Trabaja en zona horaria America/Mexico_City.',
      now: 100,
      rateLimit: false,
    });
    const pinned = curated.pin(USER_A, { old_text: 'zona horaria', now: 200 });
    assert.equal(pinned.ok, true);
    assert.match(pinned.message, /Perfil fijado/);
    const facts = curated.listFacts(USER_A);
    assert.equal(facts.some((row) => row.pinned && row.store === 'user'), true);

    curated.resetForTests();
    const reloaded = curated.listFacts(USER_A);
    assert.equal(reloaded.some((row) => row.text.includes('Mexico_City') && row.pinned), true);
  });

  test('pin rejects memory-only needles and ambiguous profile matches', () => {
    wipe();
    curated.add(USER_A, { target: 'memory', content: 'Timezone is UTC', now: 1, rateLimit: false });
    const memoryOnly = curated.pin(USER_A, { old_text: 'UTC' });
    assert.equal(memoryOnly.ok, false);
    assert.match(memoryOnly.error, /Ningún dato del perfil/);

    curated.add(USER_A, { target: 'user', content: 'Usa el editor vscode.', now: 2, rateLimit: false });
    curated.add(USER_A, { target: 'user', content: 'El editor es vim.', now: 3, rateLimit: false });
    const ambiguous = curated.pin(USER_A, { old_text: 'editor' });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error, /Varios datos del perfil/);
  });

  test('unpin is Spanish and leaves the fact in the profile', () => {
    wipe();
    curated.add(USER_A, {
      target: 'user',
      content: 'Trabaja en zona horaria America/Mexico_City.',
      pinned: true,
      now: 1,
      rateLimit: false,
    });
    const undone = curated.unpin(USER_A, { old_text: 'Mexico_City', now: 2 });
    assert.equal(undone.ok, true);
    assert.match(undone.message, /quitó el ancla/);
    const facts = curated.listFacts(USER_A);
    assert.equal(facts[0].pinned, false);
    assert.equal(facts[0].text.includes('Mexico_City'), true);
  });

  test('newer MEMORY replaces unpinned USER when resolve applies', () => {
    wipe();
    curated.add(USER_A, {
      target: 'user',
      content: 'Timezone is UTC',
      now: 10,
      rateLimit: false,
    });
    curated.add(USER_A, {
      target: 'memory',
      content: 'Trabaja en zona horaria America/Mexico_City.',
      now: 50,
      rateLimit: false,
    });
    const result = curated.resolveConflicts(USER_A, { deposit: false, now: 60 });
    assert.equal(result.ok, true);
    assert.equal(result.conflicts, 1);
    assert.equal(result.removed, 1);
    assert.match(result.message, /más reciente/);
    const live = curated.read(USER_A);
    assert.equal(live.user.entries.includes('Timezone is UTC'), false);
    assert.ok(live.memory.entries.some((row) => row.includes('Mexico_City')));
  });

  test('pinned profile survives a newer conflicting MEMORY fact', () => {
    wipe();
    curated.add(USER_A, {
      target: 'user',
      content: 'Trabaja en zona horaria America/Mexico_City.',
      pinned: true,
      now: 10,
      rateLimit: false,
    });
    curated.add(USER_A, {
      target: 'memory',
      content: 'Timezone is UTC',
      now: 90,
      rateLimit: false,
    });
    const result = curated.resolveConflicts(USER_A, { deposit: false, now: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.decisions[0].rule, 'perfil_fijado');
    assert.match(result.message, /perfil fijado/);
    const live = curated.read(USER_A);
    assert.ok(live.user.entries.some((row) => row.includes('Mexico_City')));
    assert.equal(live.memory.entries.includes('Timezone is UTC'), false);
  });

  test('dry-run reports in Spanish and does not mutate stores', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Timezone is UTC', now: 1, rateLimit: false });
    curated.add(USER_A, {
      target: 'memory',
      content: 'Trabaja en zona horaria America/Mexico_City.',
      now: 2,
      rateLimit: false,
    });
    const preview = curated.resolveConflicts(USER_A, { dryRun: true, deposit: false });
    assert.equal(preview.dryRun, true);
    assert.match(preview.message, /Simulación/);
    assert.match(preview.report, /Informe de fusión de memoria/);
    assert.equal(preview.removed, 0);
    const live = curated.read(USER_A);
    assert.equal(live.user.entries.includes('Timezone is UTC'), true);
    assert.ok(live.memory.entries.some((row) => row.includes('Mexico_City')));
  });

  test('user B cannot see or lose user A facts', () => {
    wipe();
    curated.add(USER_A, {
      target: 'user',
      content: 'Trabaja en zona horaria America/Mexico_City.',
      pinned: true,
      now: 1,
      rateLimit: false,
    });
    curated.add(USER_A, { target: 'memory', content: 'Timezone is UTC', now: 2, rateLimit: false });
    curated.resolveConflicts(USER_A, { deposit: false });
    assert.equal(curated.listFacts(USER_B).length, 0);
    assert.equal(curated.read(USER_B, { target: 'user' }).count, 0);
    assert.equal(
      curated.getFrozenPromptBlock(USER_B, { chatId: 'iso' }).includes('Mexico_City'),
      false,
    );
  });

  test('resolve refuses a foreign sessionUserId', () => {
    wipe();
    const denied = conflict.resolveConflicts(USER_A, {
      sessionUserId: USER_B,
      deposit: false,
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /otro usuario/);
  });

  test('Spanish merge report lands in Biblioteca without vendor names', () => {
    wipe();
    const bucket = deposits();
    curated.add(USER_A, {
      target: 'user',
      content: 'Trabaja en zona horaria America/Mexico_City.',
      pinned: true,
      now: 1,
      rateLimit: false,
    });
    curated.add(USER_A, { target: 'memory', content: 'Timezone is UTC', now: 2, rateLimit: false });
    const result = curated.resolveConflicts(USER_A, { save: saveStub(bucket), now: 3 });
    assert.equal(result.ok, true);
    assert.ok(result.asset_id);
    assert.equal(result.brand_label, 'SiraGPT');
    assert.equal(bucket.length, 1);
    assert.equal(bucket[0].brandLabel, 'SiraGPT');
    assert.match(bucket[0].body, /Informe de fusión de memoria/);
    assert.match(bucket[0].body, /perfil_fijado|perfil fijado/);
    assert.equal(bucket[0].body.toLowerCase().includes('openrouter'), false);
    assert.equal(bucket[0].body.toLowerCase().includes('nousresearch'), false);
    assert.equal(/sk-[a-z0-9]{8,}/i.test(bucket[0].body), false);
  });

  test('learnFromEntry drops a MEMORY fact that fights a pinned profile', () => {
    wipe();
    curated.add(USER_A, {
      target: 'user',
      content: 'Prefiero TypeScript sobre JavaScript',
      pinned: true,
      now: 1,
      rateLimit: false,
    });
    const learned = curated.learnFromEntry({
      userId: USER_A,
      fact: 'Prefiere JavaScript',
      source: 'hermes-memory-bridge',
      updatedAt: 80,
    });
    assert.equal(learned.ok, true);
    const haystack = [...curated.read(USER_A).memory.entries, ...curated.read(USER_A).user.entries].join('\n');
    assert.match(haystack, /TypeScript/);
    assert.equal(/Prefiere JavaScript/.test(haystack), false);
  });

  test('empty stores resolve as a Spanish no-op', () => {
    wipe();
    const result = curated.resolveConflicts(USER_A, { deposit: false });
    assert.equal(result.ok, true);
    assert.equal(result.conflicts, 0);
    assert.match(result.message, /No hay conflictos/);
    assert.match(result.report, /No hay conflictos/);
  });
});

describe('hermes memory conflict — tool, CLI, map', { concurrency: 1 }, () => {
  test('memory tool pin + resolve applies the pinned-profile rule', async () => {
    wipe();
    const tool = memoryTool();
    const added = await tool.execute(
      { action: 'add', target: 'user', content: 'Trabaja en zona horaria America/Mexico_City.', pinned: true },
      { userId: USER_A },
    );
    assert.equal(added.ok, true);
    await tool.execute(
      { action: 'add', target: 'memory', content: 'Timezone is UTC' },
      { userId: USER_A },
    );
    const pinned = await tool.execute({ action: 'pin', old_text: 'Mexico_City' }, { userId: USER_A });
    assert.equal(pinned.ok, true);
    const resolved = await tool.execute({ action: 'resolve' }, { userId: USER_A });
    assert.equal(resolved.ok, true);
    assert.equal(curated.read(USER_A, { target: 'memory' }).entries.includes('Timezone is UTC'), false);
  });

  test('tool without userId cannot pin or resolve', async () => {
    const tool = memoryTool();
    const pinned = await tool.execute({ action: 'pin', old_text: 'zona' }, {});
    assert.equal(pinned.ok, false);
    const resolved = await tool.execute({ action: 'resolve' }, {});
    assert.equal(resolved.ok, false);
  });

  test('CLI memory resolve uses the same conflict path', () => {
    wipe();
    curated.add(USER_A, { target: 'user', content: 'Timezone is UTC', now: 1, rateLimit: false });
    curated.add(USER_A, {
      target: 'memory',
      content: 'Trabaja en zona horaria America/Mexico_City.',
      now: 2,
      rateLimit: false,
    });
    const preview = runHermesCommand('memory', { userId: USER_A, action: 'resolve', dryRun: true });
    assert.equal(preview.ok, true);
    assert.equal(preview.command, 'memory');
    assert.equal(preview.dryRun, true);
    assert.match(preview.report, /Informe de fusión/);
  });

  test('playbook map lists the native conflict slice', () => {
    const entry = FOLDER_CAPABILITY_MAP.find((row) => row.sira.includes('hermes-memory-conflict.js'));
    assert.ok(entry);
    assert.equal(entry.status, 'integrated');
    assert.equal(entry.hermes, 'memories/USER.md');
    assert.match(entry.strategy, /pinned profile|perfil/i);
    assert.equal(entry.sira.includes('.agents/hermes-upstream'), false);
  });

  test('status advertises rules without OpenRouter or vendor model ids', () => {
    const status = conflict.status();
    assert.equal(status.pattern, 'hermes-memory-conflict');
    assert.deepEqual(status.rules, ['perfil_fijado', 'mas_reciente']);
    assert.equal(status.brand_label, 'SiraGPT');
    const blob = JSON.stringify(status).toLowerCase();
    assert.equal(blob.includes('openrouter'), false);
    assert.equal(blob.includes('nousresearch'), false);
    assert.ok(memoryBridge.status(USER_A).providers.includes('hermes-memory-conflict'));
  });

  test('hermes routes bind resolve to the authenticated session user', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/hermes.js'), 'utf8');
    assert.match(src, /\/memory\/resolve/);
    assert.match(src, /\/memory\/pin/);
    assert.match(src, /sessionUserId: req\.user\?\.id/);
  });

  test('active source does not import upstream Hermes or OpenRouter', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/agents/hermes-memory-conflict.js'),
      'utf8',
    );
    assert.equal(src.includes('.agents/hermes-upstream'), false);
    assert.equal(/require\(['"]openrouter/i.test(src), false);
    assert.match(src, /Not a dump of\s+NousResearch\/hermes-agent/);
  });
});
