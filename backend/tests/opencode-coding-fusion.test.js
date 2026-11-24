'use strict';

/**
 * OpenCode (anomalyco/opencode@4cf9db957485dd51a5b195fb6e2c1e03d8da1107, MIT)
 * native CommonJS coding-engine fusion regression suite.
 *
 * Verifies:
 *   1. Shared coding intelligence (BOM, typographic normalization, LCS mixed
 *      LF/CRLF preservation, edit missHint, fuzzy path suggestions, nearest
 *      missing folder, hierarchical AGENTS.md/CLAUDE.md discovery).
 *   2. Codex edit_file + read_file + native atomic multi-file apply_patch +
 *      tool-scheduler + agent-sdk readOnly guard + opencode-harness + root
 *      AGENTS.md project notes.
 *   3. SiraCode apply_patch (4-tier seek, @@ context disambiguation, EOF,
 *      heredoc, missHint), read (canonical look-alike, ENOENT fuzzy
 *      suggestions, scoped AGENTS.md), graduated edit/multiedit, and staged
 *      exchange-level compaction.
 *
 * Offline, deterministic, zero network, zero UI diff.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const intel = require('../src/services/codex/opencode-coding-intel');
const { applyEdit } = require('../src/services/codex/edit-matching');
const buildTools = require('../src/services/codex/build-tools');
const scheduler = require('../src/services/codex/tool-scheduler');
const agentSdk = require('../src/services/codex/agent-sdk');
const harness = require('../src/services/codex/opencode-harness');
const agentLoop = require('../src/services/codex/agent-loop');
const { createWorkspace } = require('../src/services/sira-code/workspace');
const { executeTool } = require('../src/services/sira-code/tools');
const { ERRORS } = require('../src/services/sira-code/file-tools');
const { parsePatch, stripHeredoc, applyUpdateChunks } = require('../src/services/sira-code/apply-patch');
const {
  COMPACTION_LEVELS,
  compactTranscriptStaged,
  compactTranscript,
} = require('../src/services/sira-code/tool-result');

async function withTempWorkspace(t) {
  const ws = await createWorkspace(`oc-fusion-${crypto.randomBytes(6).toString('hex')}`);
  t.after(() => ws.destroy());
  return ws;
}

function siraSession(workspace, agentId = 'construir') {
  return { id: `sess_${crypto.randomBytes(4).toString('hex')}`, agentId, workspace, permission: 'default' };
}

describe('opencode-coding-intel primitives', () => {
  test('splitBom / joinBom preserve UTF-8 BOM cleanly', () => {
    const split = intel.splitBom('\uFEFFhello\n');
    assert.deepEqual(split, { text: 'hello\n', bom: true });
    assert.equal(intel.joinBom('world\n', true), '\uFEFFworld\n');
    assert.equal(intel.joinBom('\uFEFFworld\n', true), '\uFEFFworld\n');
    assert.equal(intel.joinBom('world\n', false), 'world\n');
  });

  test('normalizeForMatch maps typographic quotes, dashes and NBSP 1-to-1', () => {
    const raw = 'const msg = “hola\u00A0—\u2019mundo’”;';
    const norm = intel.normalizeForMatch(raw);
    assert.equal(norm, 'const msg = "hola -\'mundo\'";');
    assert.equal(norm.length, raw.length);
  });

  test('withRegionEndings preserves mixed LF/CRLF on untouched context lines via LCS', () => {
    const region = 'alpha\r\nbeta\ngamma\r\ndelta';
    const replacement = 'alpha\nBETA_EDITED\ngamma\ndelta';
    const out = intel.withRegionEndings(region, replacement, '\r\n');
    assert.equal(out, 'alpha\r\nBETA_EDITED\ngamma\r\ndelta');
  });

  test('buildEditMissHint detects already-applied edits and closest numbered lines', () => {
    const src = [
      'export function calculateTotal(items) {',
      '  const subtotal = items.reduce((a, b) => a + b.price, 0);',
      '  const tax = subtotal * 0.18;',
      '  return subtotal + tax;',
      '}',
    ].join('\n');

    const already = intel.buildEditMissHint(
      src,
      'const tax = subtotal * 0.10;',
      '  const tax = subtotal * 0.18;\n  return subtotal + tax;',
    );
    assert.match(already, /ya existe en el archivo/i);

    const closest = intel.buildEditMissHint(
      src,
      [
        'export function calculateTotal(items) {',
        '  const subtotal = items.reduce((a, b) => a + b.price, 0);',
        '  const tax = subtotal * 0.21;',
        '  return subtotal + tax;',
        '}',
      ].join('\n'),
      'return 0;',
    );
    assert.match(closest, /Líneas más cercanas/);
    assert.match(closest, /1: export function calculateTotal/);
    assert.match(closest, /4:   return subtotal \+ tax;/);

    const unrelated = intel.buildEditMissHint(src, 'completely unrelated code foo bar', 'z');
    assert.equal(unrelated, null);
  });

  test('suggestSimilarNames ranks case, stem-ext, substring and bounded typos', () => {
    const names = ['App.tsx', 'app-shell.tsx', 'Header.tsx', 'Footer.tsx', 'utils.ts', 'other.md'];
    assert.deepEqual(intel.suggestSimilarNames(names, 'app.tsx').slice(0, 1), ['App.tsx']);
    assert.deepEqual(intel.suggestSimilarNames(names, 'App.js').slice(0, 1), ['App.tsx']);
    assert.equal(intel.suggestSimilarNames(names, 'Headre.tsx')[0], 'Header.tsx');
    assert.equal(intel.suggestSimilarNames(names, 'util.ts')[0], 'utils.ts');
  });

  test('diagnoseMissingPath handles both missing siblings and missing parent folders', () => {
    const files = ['src/components/Button.tsx', 'src/components/Modal.tsx', 'src/lib/api.ts'];
    const siblingDiag = intel.diagnoseMissingPath('src/components/Buton.tsx', files);
    assert.equal(siblingDiag.missingFolder, null);
    assert.equal(siblingDiag.suggestions[0], 'src/components/Button.tsx');

    const folderDiag = intel.diagnoseMissingPath('src/compnents/Button.tsx', files);
    assert.equal(folderDiag.missingFolder, 'src/compnents');
    assert.equal(folderDiag.nearestFolder, 'src');
    assert.equal(folderDiag.suggestions[0], 'src/components');
    const formatted = intel.formatMissingPathHint(folderDiag);
    assert.match(formatted, /La carpeta src\/compnents no existe/);
    assert.match(formatted, /src\/components/);
  });

  test('preferAgents drops CLAUDE.md when AGENTS.md exists in the same directory', () => {
    const filtered = intel.preferAgents([
      'packages/api/AGENTS.md',
      'packages/api/CLAUDE.md',
      'packages/web/CLAUDE.md',
    ]);
    assert.deepEqual(filtered, ['packages/api/AGENTS.md', 'packages/web/CLAUDE.md']);
  });
});

describe('Codex edit_file, read_file and native atomic apply_patch', () => {
  test('applyEdit recovers typographic quotes, trailing whitespace, CRLF and preserves literal $', () => {
    const src = 'const label = "Hola — mundo";  \r\nconst total = price;\r\n';

    const typo = applyEdit(src, 'const label = “Hola - mundo”;', 'const label = "$& $$ $1";');
    assert.equal(typo.ok, true);
    assert.equal(typo.strategy, 'unicode-normalized');
    assert.equal(typo.next, 'const label = "$& $$ $1";  \r\nconst total = price;\r\n');

    const trailing = applyEdit(src, 'const label = "Hola — mundo";\nconst total = price;', 'const label = "OK";\nconst total = 42;');
    assert.equal(trailing.ok, true);
    assert.equal(trailing.strategy, 'trailing-ws');
    assert.equal(trailing.next, 'const label = "OK";\r\nconst total = 42;\r\n');

    const exactDollar = applyEdit('const a = cost;', 'cost', '$& + $$ + $1');
    assert.equal(exactDollar.ok, true);
    assert.equal(exactDollar.next, 'const a = $& + $$ + $1;');
  });

  test('applyEdit honours explicit \\r-only line-ending conversions on exact bytes', () => {
    const crlf = 'a\r\nb\r\n';
    const converted = applyEdit(crlf, 'a\r\nb\r\n', 'a\nb\n');
    assert.equal(converted.ok, true);
    assert.equal(converted.strategy, 'exact');
    assert.equal(converted.next, 'a\nb\n');
  });

  test('edit_file appends actionable missHint while preserving legacy error text', async () => {
    const content = 'function run() {\n  const x = 10;\n  const y = 20;\n  return x + y;\n}\n';
    const runner = {
      readFile: async () => ({ content }),
      writeFiles: async () => ({ ok: true }),
    };
    const res = await buildTools.TOOLS.edit_file.execute(
      { path: 'src/run.js', find: 'function run() {\n  const x = 10;\n  const y = 99;\n  return x + y;\n}', replace: 'return 0;' },
      { runner, project: 'p1' },
    );
    assert.equal(res.isError, true);
    assert.match(res.observation, /ni exacto ni por líneas/);
    assert.match(res.observation, /Líneas más cercanas/);
    assert.match(res.observation, /3:   const y = 20;/);
  });

  test('read_file discovers nested AGENTS.md once per run and suggests paths on ENOENT', async () => {
    const files = {
      'packages/api/AGENTS.md': 'Usa siempre validación Zod en rutas.',
      'packages/api/CLAUDE.md': 'Ignorar cuando existe AGENTS.md.',
      'packages/api/src/users.ts': 'export const users = [];\n',
      'packages/api/src/orders.ts': 'export const orders = [];\n',
    };
    const runner = {
      exec: async () => ({ exitCode: 0, stdout: Object.keys(files).join('\n'), stderr: '' }),
      readFile: async (_p, filePath) => {
        if (Object.hasOwn(files, filePath)) return { content: files[filePath] };
        const err = new Error('file_not_found');
        err.status = 404;
        throw err;
      },
    };
    const controller = new AbortController();
    const ctx = { runner, project: 'p1', signal: controller.signal };

    const first = await buildTools.TOOLS.read_file.execute({ path: 'packages/api/src/users.ts' }, ctx);
    assert.equal(first.isError, false);
    assert.deepEqual(first.scopedInstructions, ['packages/api/AGENTS.md']);
    assert.match(first.observation, /INSTRUCCIONES DE SUBCARPETA: packages\/api\/AGENTS\.md/);
    assert.match(first.observation, /validación Zod/);
    assert.ok(!first.observation.includes('Ignorar cuando existe'));

    // Second read in same subtree must NOT re-inject the already seen AGENTS.md.
    const second = await buildTools.TOOLS.read_file.execute({ path: 'packages/api/src/orders.ts' }, ctx);
    assert.equal(second.isError, false);
    assert.equal(second.scopedInstructions, undefined);
    assert.ok(!second.observation.includes('INSTRUCCIONES DE SUBCARPETA'));

    // Missing file produces fuzzy suggestions.
    const missing = await buildTools.TOOLS.read_file.execute({ path: 'packages/api/src/user.ts' }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.observation, /Quisiste decir alguno de estos/);
    assert.ok(missing.suggestions.includes('packages/api/src/users.ts'));
  });

  test('Codex apply_patch applies multi-file Add/Update/Move/Delete atomically with file-state', async () => {
    const store = new Map([
      ['src/math.ts', '\uFEFFexport function add(a: number, b: number) {\r\n  return a + b;\r\n}\r\n'],
      ['src/legacy.ts', 'export const old = true;\n'],
    ]);
    const deletedViaExec = [];
    const runner = {
      readFile: async (_p, rel) => {
        if (!store.has(rel)) {
          const e = new Error('file_not_found');
          e.status = 404;
          throw e;
        }
        return { content: store.get(rel) };
      },
      writeFiles: async (_p, batch) => {
        for (const f of batch) store.set(f.path, f.content);
        return { ok: true, written: batch.length };
      },
      exec: async (_p, cmd) => {
        if (cmd[0] === 'node' && cmd[1] === '-e' && cmd[2].includes('unlinkSync')) {
          for (const p of cmd.slice(3)) {
            deletedViaExec.push(p);
            store.delete(p);
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const controller = new AbortController();
    const ctx = { runner, project: 'p1', signal: controller.signal, enforceFileState: true };

    // Read-before-edit enforced before writing anything.
    const unread = await buildTools.TOOLS.apply_patch.execute({
      patch: [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+export const ok = 1;',
        '*** Update File: src/math.ts',
        '@@ export function add(a: number, b: number) {',
        '-  return a + b;',
        '+  return a + b + 0;',
        '*** End Patch',
      ].join('\n'),
    }, ctx);
    assert.equal(unread.isError, true);
    assert.match(unread.observation, /read-before-edit/);
    assert.equal(store.has('src/new.ts'), false, 'failed pre-verify must not write Add File');

    // Read src/math.ts, then apply full multi-file heredoc patch.
    await buildTools.TOOLS.read_file.execute({ path: 'src/math.ts' }, ctx);
    const ok = await buildTools.TOOLS.apply_patch.execute({
      patch: [
        "cat <<'EOF'",
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+export const fresh = true;',
        '*** Update File: src/math.ts',
        '*** Move to: src/calc.ts',
        '@@ export function add(a: number, b: number) {',
        '-  return a + b;',
        '+  return Number(a) + Number(b);',
        '*** Delete File: src/legacy.ts',
        '*** End Patch',
        'EOF',
      ].join('\n'),
    }, ctx);
    assert.equal(ok.isError, false, ok.observation);
    assert.match(ok.observation, /A src\/new\.ts/);
    assert.match(ok.observation, /R src\/math\.ts -> src\/calc\.ts/);
    assert.match(ok.observation, /D src\/legacy\.ts/);
    assert.equal(store.get('src/new.ts'), 'export const fresh = true;\n');
    // BOM and CRLF preserved on moved/updated file!
    assert.equal(store.get('src/calc.ts'), '\uFEFFexport function add(a: number, b: number) {\r\n  return Number(a) + Number(b);\r\n}\r\n');
    assert.ok(deletedViaExec.includes('src/math.ts'));
    assert.ok(deletedViaExec.includes('src/legacy.ts'));
  });

  test('Codex apply_patch handles case-only rename safely without unlinking the file', async () => {
    const writes = [];
    const renames = [];
    const unlinks = [];
    const runner = {
      readFile: async () => ({ content: 'export const X = 1;\n' }),
      writeFiles: async (_p, batch) => { writes.push(...batch); return { ok: true }; },
      exec: async (_p, cmd) => {
        if (cmd[0] === 'node' && cmd[2].includes('renameSync')) renames.push(cmd.slice(3));
        if (cmd[0] === 'node' && cmd[2].includes('unlinkSync')) unlinks.push(cmd.slice(3));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const res = await buildTools.TOOLS.apply_patch.execute({
      patch: '*** Begin Patch\n*** Update File: src/Widget.tsx\n*** Move to: src/widget.tsx\n-export const X = 1;\n+export const X = 2;\n*** End Patch',
    }, { runner, project: 'p1' });
    assert.equal(res.isError, false, res.observation);
    assert.equal(writes[0].path, 'src/Widget.tsx');
    assert.deepEqual(renames, [['src/Widget.tsx', 'src/widget.tsx']]);
    assert.deepEqual(unlinks, []);
  });

  test('Codex apply_patch aborts atomically when a later hunk misses', async () => {
    let writeCalls = 0;
    const runner = {
      readFile: async (_p, rel) => ({ content: rel === 'a.ts' ? 'const a = 1;\n' : 'const b = 1;\n' }),
      writeFiles: async () => { writeCalls += 1; return { ok: true }; },
    };
    const res = await buildTools.TOOLS.apply_patch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '-const a = 1;',
        '+const a = 2;',
        '*** Update File: b.ts',
        '-const b = 999;',
        '+const b = 2;',
        '*** End Patch',
      ].join('\n'),
    }, { runner, project: 'p1' });
    assert.equal(res.isError, true);
    assert.equal(writeCalls, 0, 'zero writes when any hunk fails verification');
    assert.match(res.observation, /ningún archivo fue modificado/);
  });

  test('tool-scheduler, agent-sdk, opencode-harness and safeProjectNotes reflect fusion', async () => {
    assert.equal(scheduler.EXCLUSIVE_TOOLS.has('apply_patch'), true);
    assert.equal(scheduler.accessFor({ name: 'apply_patch', args: {} }).parallel, false);

    const { def } = agentSdk.validateCustomAgent({
      name: 'auditor_only',
      prompt: 'solo lectura',
      readOnly: true,
      tools: ['read_file', 'apply_patch'],
    });
    assert.deepEqual(def.tools, ['read_file']);
    assert.ok(agentSdk.getSubagent('debugger').tools.includes('apply_patch'));

    const row = harness.OPENCODE_TOOL_CATALOG.find((r) => r.opencodeId === 'apply_patch');
    assert.equal(row.status, 'native');
    assert.equal(row.siraTool, 'apply_patch');
    assert.equal(harness.OPENCODE_PROVENANCE.latestSnapshotSha, '4cf9db957485dd51a5b195fb6e2c1e03d8da1107');

    // safeProjectNotes loads root AGENTS.md and prefers it over CLAUDE.md.
    const runner = {
      readFile: async (_p, rel) => {
        if (rel === 'AGENTS.md') return { content: 'Regla raíz AGENTS.' };
        if (rel === 'CLAUDE.md') return { content: 'Regla CLAUDE secundaria.' };
        throw new Error('not found');
      },
    };
    const notes = await agentLoop.safeProjectNotes(runner, 'p1');
    assert.match(notes, /## AGENTS\.md/);
    assert.match(notes, /Regla raíz AGENTS/);
    assert.ok(!notes.includes('CLAUDE secundaria'));
  });
});

describe('SiraCode upgraded patch, read, edit and staged compaction', () => {
  test('parsePatch strips heredocs and captures @@ context and *** End of File', () => {
    const raw = stripHeredoc("cat <<'PATCH'\n*** Begin Patch\n*** Update File: app.js\n@@ function second()\n-return 1;\n+return 2;\n*** End of File\n*** End Patch\nPATCH");
    const ops = parsePatch(raw);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].chunks[0].changeContext, 'function second()');
    assert.equal(ops[0].chunks[0].endOfFile, true);
  });

  test('SiraCode apply_patch uses @@ context to disambiguate identical hunks and 4-tier seek', async (t) => {
    const ws = await withTempWorkspace(t);
    await ws.writeFile('funcs.js', [
      'function first() {',
      '  return "hola";',
      '}',
      '',
      'function second() {',
      '  return "hola";',
      '}',
      '',
    ].join('\n'));

    const patched = await executeTool(siraSession(ws), 'apply_patch', {
      patch: [
        '*** Begin Patch',
        '*** Update File: funcs.js',
        '@@ function second() {',
        '-  return “hola”;',
        '+  return "adios";',
        '*** End Patch',
      ].join('\n'),
    });
    assert.equal(patched.ok, true, patched.error);
    const updated = await ws.readFile('funcs.js');
    assert.match(updated, /function first\(\) \{\n  return "hola";/);
    assert.match(updated, /function second\(\) \{\n  return "adios";/);
  });

  test('applyUpdateChunks respects *** End of File anchor and preserves mixed endings', () => {
    const src = 'header\r\nitem\nfooter\r\nitem\r\n';
    const next = applyUpdateChunks(src, [{
      changeContext: null,
      endOfFile: true,
      oldLines: ['item'],
      newLines: ['LAST_ITEM'],
    }]);
    assert.equal(next, 'header\r\nitem\nfooter\r\nLAST_ITEM\r\n');
  });

  test('SiraCode read recovers look-alike canonical filenames, suggests typos and discovers AGENTS.md', async (t) => {
    const ws = await withTempWorkspace(t);
    const sess = siraSession(ws);
    await ws.writeFile('packages/ui/AGENTS.md', 'Usa siempre botones accesibles.');
    await ws.writeFile('packages/ui/CLAUDE.md', 'No duplicar.');
    await ws.writeFile('packages/ui/src/Button.tsx', 'export const Button = () => null;\n');
    await ws.writeFile("notes/don't.txt", 'contenido canonico');

    // Canonical look-alike apostrophe recovery.
    const canon = await executeTool(sess, 'read', { path: 'notes/don\u2019t.txt' });
    assert.equal(canon.ok, true, canon.error);
    assert.equal(canon.text, 'contenido canonico');

    // Nested AGENTS.md discovery (once per session, preferAgents).
    const first = await executeTool(sess, 'read', { path: 'packages/ui/src/Button.tsx' });
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first.scopedInstructions, ['packages/ui/AGENTS.md']);
    assert.match(first.content, /botones accesibles/);
    assert.ok(!first.content.includes('No duplicar'));

    const second = await executeTool(sess, 'read', { path: 'packages/ui/src/Button.tsx' });
    assert.equal(second.ok, true);
    assert.equal(second.scopedInstructions, undefined);

    // Fuzzy ENOENT suggestions while preserving ERRORS.not_found pin.
    const miss = await executeTool(sess, 'read', { path: 'packages/ui/src/Buton.tsx' });
    assert.equal(miss.ok, false);
    assert.equal(miss.code, 'not_found');
    assert.equal(miss.error, ERRORS.not_found);
    assert.match(miss.content, /Quisiste decir alguno de estos/);
    assert.ok(miss.suggestions.includes('packages/ui/src/Button.tsx'));
  });

  test('SiraCode edit recovers typographic/indentation drift and emits missHint without breaking ERRORS.edit_miss', async (t) => {
    const ws = await withTempWorkspace(t);
    await ws.writeFile('view.tsx', 'function View() {\r\n  return (\r\n    <p>"Hola — mundo"</p>\r\n  );\r\n}\r\n');

    const recovered = await executeTool(siraSession(ws), 'edit', {
      path: 'view.tsx',
      old_str: '<p>“Hola - mundo”</p>',
      new_str: '<p>"Listo"</p>',
    });
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(await ws.readFile('view.tsx'), 'function View() {\r\n  return (\r\n    <p>"Listo"</p>\r\n  );\r\n}\r\n');

    const miss = await executeTool(siraSession(ws), 'edit', {
      path: 'view.tsx',
      old_str: 'function View() {\n  return (\n    <p>"NOPE"</p>\n  );\n}',
      new_str: 'return null;',
    });
    assert.equal(miss.ok, false);
    assert.equal(miss.code, 'edit_miss');
    assert.equal(miss.error, ERRORS.edit_miss);
    assert.match(miss.content, /Líneas más cercanas/);
  });

  test('compactTranscriptStaged shortens oldest exchanges progressively and preserves system + newest exchange', () => {
    const bigTool = 'linea\n'.repeat(600);
    const messages = [
      { role: 'system', content: 'INSTRUCCIONES_INMUTABLES' },
      { role: 'user', content: 'turno 1: analiza' },
      { role: 'assistant', content: 'leyendo archivo 1' },
      { role: 'tool', content: bigTool },
      { role: 'user', content: 'turno 2: edita' },
      { role: 'assistant', content: 'leyendo archivo 2' },
      { role: 'tool', content: bigTool },
      { role: 'user', content: 'turno 3: verifica final' },
      { role: 'assistant', content: 'verificando' },
      { role: 'tool', content: 'resultado reciente' },
    ];

    const staged = compactTranscriptStaged(messages, { maxChars: 900, clipChars: 200 });
    assert.equal(staged.compacted, true);
    assert.ok(staged.maxLevel >= COMPACTION_LEVELS.OUTPUTS_CLIPPED);
    assert.equal(staged.messages[0].content, 'INSTRUCCIONES_INMUTABLES');
    assert.ok(staged.messages.some((m) => m.content.includes('turno 3: verifica final')));
    assert.ok(staged.messages.some((m) => m.content.includes('resultado reciente')));

    const viaCompact = compactTranscript(messages, { maxTotalChars: 900, clipChars: 200 });
    assert.equal(viaCompact.compacted, true);
    assert.equal(viaCompact.messages[0].content, 'INSTRUCCIONES_INMUTABLES');
    assert.ok(!/openrouter|deepseek|model_id|sk-/i.test(JSON.stringify(viaCompact.messages)));
  });
});
