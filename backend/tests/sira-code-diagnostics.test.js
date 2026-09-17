'use strict';

/**
 * SiraCode diagnostics summary — workspace jail, injectable runner,
 * OpenCode report contract, Spanish errors. Offline: temp workspace,
 * no language server, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspace } = require('../src/services/sira-code/workspace');
const { executeTool, TOOL_DEFINITIONS } = require('../src/services/sira-code/tools');
const { authorizeTool } = require('../src/services/sira-code/permissions');
const {
  ERRORS,
  MAX_PER_FILE,
  pretty,
  reportFile,
  formatDiagnostics,
  formatSummaryHeader,
  normalizeSeverity,
  minSeverityFromFilter,
  normalizeDiagnostic,
  coerceRunnerPayload,
  sanitizeMessage,
  offsetToLineCol,
  parseSyntaxLocation,
  neutralizeModuleSyntax,
  syntaxIssuesFor,
  runDiagnostics,
} = require('../src/services/sira-code/diagnostics');

function session(agentId, workspace, extra = {}) {
  return { agentId, workspace, permission: 'default', ...extra };
}

async function withWorkspace(id, fn) {
  const workspace = await createWorkspace(id);
  try {
    return await fn(workspace);
  } finally {
    await workspace.destroy();
  }
}

function lspMap(file, issues) {
  return { [file]: issues };
}

test('pretty matches the OpenCode ERROR [line:col] contract', () => {
  assert.equal(pretty({ severity: 1, line: 12, col: 3, message: 'Missing ;' }), 'ERROR [12:3] Missing ;');
  assert.equal(pretty({ severity: 2, line: 1, col: 1, message: 'unused' }), 'WARN [1:1] unused');
  assert.equal(pretty({ severity: 3, line: 4, col: 8, message: 'note' }), 'INFO [4:8] note');
  assert.equal(pretty({ severity: 4, line: 2, col: 2, message: 'tip' }), 'HINT [2:2] tip');
});

test('pretty defaults missing severity and position to ERROR [1:1]', () => {
  assert.equal(pretty({ message: 'x' }), 'ERROR [1:1] x');
});

test('reportFile emits the OpenCode <diagnostics file> block', () => {
  const block = reportFile('src/a.js', [
    { severity: 1, line: 3, col: 10, message: 'Unexpected token' },
    { severity: 2, line: 8, col: 1, message: 'unused' },
  ]);
  assert.match(block, /<diagnostics file="src\/a\.js">/);
  assert.match(block, /ERROR \[3:10\] Unexpected token/);
  assert.match(block, /WARN \[8:1\] unused/);
  assert.match(block, /<\/diagnostics>/);
});

test('reportFile errorsOnly drops warnings like OpenCode report()', () => {
  const block = reportFile('a.js', [
    { severity: 2, line: 1, col: 1, message: 'warn' },
    { severity: 1, line: 2, col: 2, message: 'boom' },
  ], { errorsOnly: true });
  assert.match(block, /ERROR \[2:2\] boom/);
  assert.doesNotMatch(block, /WARN/);
});

test('reportFile returns empty when there are no matching issues', () => {
  assert.equal(reportFile('a.js', []), '');
  assert.equal(reportFile('a.js', [{ severity: 2, line: 1, col: 1, message: 'w' }], { errorsOnly: true }), '');
});

test('reportFile caps at MAX_PER_FILE and adds a Spanish overflow', () => {
  const issues = Array.from({ length: MAX_PER_FILE + 5 }, (_, i) => ({
    severity: 1,
    line: i + 1,
    col: 1,
    message: `e${i}`,
  }));
  const block = reportFile('big.js', issues);
  assert.match(block, /\.\.\. y 5 más/);
  assert.equal((block.match(/^ERROR /gm) || []).length, MAX_PER_FILE);
});

test('normalizeDiagnostic maps 0-based LSP ranges to 1-based line/col', () => {
  const diag = normalizeDiagnostic({
    severity: 1,
    message: 'Cannot find name x',
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 5 } },
  }, 'src/a.js', '/tmp/ws');
  assert.equal(diag.line, 3);
  assert.equal(diag.col, 5);
  assert.equal(diag.path, 'src/a.js');
});

test('normalizeSeverity accepts numbers and bilingual names', () => {
  assert.equal(normalizeSeverity(2), 2);
  assert.equal(normalizeSeverity('warning'), 2);
  assert.equal(normalizeSeverity('error'), 1);
  assert.equal(normalizeSeverity('hint'), 4);
  assert.equal(normalizeSeverity('nope'), 1);
});

test('minSeverityFromFilter treats all as 0 and warn as 2', () => {
  assert.equal(minSeverityFromFilter('all'), 0);
  assert.equal(minSeverityFromFilter('warn'), 2);
  assert.equal(minSeverityFromFilter(1), 1);
  assert.equal(minSeverityFromFilter(''), 0);
});

test('coerceRunnerPayload accepts an OpenCode Record<path, Diagnostic[]>', () => {
  const items = coerceRunnerPayload({
    'src/a.js': [{
      severity: 1,
      message: 'x',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }],
  }, '/tmp/ws');
  assert.equal(items.length, 1);
  assert.equal(items[0].path, 'src/a.js');
  assert.equal(items[0].line, 1);
});

test('coerceRunnerPayload rejects a non-list non-map runner payload', () => {
  assert.throws(() => coerceRunnerPayload('nope', '/tmp/ws'), /lista o un mapa/);
});

test('sanitizeMessage redacts forbidden vendor tokens and caps length', () => {
  assert.match(sanitizeMessage('usa OpenRouter ya'), /Modelo/);
  assert.equal(sanitizeMessage('a'.repeat(600)).length, 501);
  assert.equal(sanitizeMessage('   '), 'diagnóstico');
});

test('offsetToLineCol and parseSyntaxLocation recover JSON positions', () => {
  const text = '{\n  "a": 1,\n}';
  const loc = offsetToLineCol(text, 12);
  assert.equal(loc.line, 3);
  const err = new Error('Unexpected token } in JSON at position 12');
  const parsed = parseSyntaxLocation(err, text);
  assert.equal(parsed.line, loc.line);
});

test('neutralizeModuleSyntax lets compileFunction accept import/export', () => {
  const src = neutralizeModuleSyntax("import { x } from './m.js';\nexport const y = 1;\n");
  assert.doesNotMatch(src, /^import /m);
  assert.doesNotMatch(src, /^export /m);
});

test('syntaxIssuesFor reports a JSON syntax error and a clean object as empty', () => {
  const bad = syntaxIssuesFor('pkg.json', '{');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].severity, 1);
  assert.equal(bad[0].source, 'json');
  assert.equal(syntaxIssuesFor('ok.json', '{"a":1}').length, 0);
});

test('syntaxIssuesFor reports a JS syntax error', () => {
  const bad = syntaxIssuesFor('a.js', 'function ( {\n');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].source, 'syntax');
  assert.match(bad[0].message, /./);
});

test('TOOL_DEFINITIONS expose OpenCode-style diagnostics parameters', () => {
  const names = TOOL_DEFINITIONS.map((item) => item.function.name);
  assert.ok(names.includes('diagnostics'));
  const def = TOOL_DEFINITIONS.find((item) => item.function.name === 'diagnostics');
  assert.deepEqual(Object.keys(def.function.parameters.properties).sort(), [
    'limit',
    'path',
    'severity',
  ]);
});

test('formatSummaryHeader is Spanish and Sin diagnósticos when empty', () => {
  assert.equal(formatSummaryHeader([], 0), 'Sin diagnósticos');
  assert.match(
    formatSummaryHeader([{ severity: 1, path: 'a.js' }, { severity: 2, path: 'b.js' }], 2),
    /Se encontraron 1 error, 1 aviso en 2 archivos/,
  );
});

test('formatDiagnostics joins header and file blocks', () => {
  const text = formatDiagnostics([
    { path: 'a.js', severity: 1, line: 2, col: 1, message: 'boom' },
  ]);
  assert.match(text, /Se encontraron 1 error en 1 archivo/);
  assert.match(text, /<diagnostics file="a\.js">/);
});

test('planificar and construir can read diagnostics; write stays denied in plan', async () => {
  await withWorkspace('sc-diag-perm', async (workspace) => {
    await workspace.writeFile('ok.json', '{"ok":true}');
    const plan = await executeTool(session('planificar', workspace), 'diagnostics', { path: 'ok.json' });
    assert.equal(plan.ok, true, plan.error);
    const build = await executeTool(session('construir', workspace), 'diagnostics', { path: 'ok.json' });
    assert.equal(build.ok, true, build.error);
    const general = authorizeTool('general', 'diagnostics');
    assert.equal(general.allowed, true);
    const write = await executeTool(session('planificar', workspace), 'write', {
      path: 'x.txt',
      content: 'no',
    });
    assert.equal(write.ok, false);
    assert.equal(write.permission.denied, true);
  });
});

test('composer Solo lectura still allows diagnostics', async () => {
  await withWorkspace('sc-diag-read', async (workspace) => {
    await workspace.writeFile('ok.json', '{}');
    const result = await executeTool(
      session('construir', workspace, { permission: 'read' }),
      'diagnostics',
      { path: 'ok.json' },
    );
    assert.equal(result.ok, true, result.error);
    const blocked = authorizeTool('construir', 'write', { permission: 'read' });
    assert.equal(blocked.denied, true);
  });
});

test('alias lsp_diagnostics maps to the diagnostics tool', () => {
  const auth = authorizeTool('planificar', 'lsp_diagnostics');
  assert.equal(auth.tool, 'diagnostics');
  assert.equal(auth.allowed, true);
  assert.equal(authorizeTool('construir', 'diagnostic').tool, 'diagnostics');
});

test('path traversal is rejected in Spanish before the runner runs', async () => {
  await withWorkspace('sc-diag-trav', async (workspace) => {
    let called = 0;
    const result = await executeTool(session('construir', workspace), 'diagnostics', {
      path: '../secret.json',
    }, {
      diagnosticsRunner: async () => {
        called += 1;
        return [];
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'path_traversal');
    assert.equal(result.error, ERRORS.path_traversal);
    assert.equal(called, 0);
  });
});

test('missing path returns ruta no encontrada', async () => {
  await withWorkspace('sc-diag-miss', async (workspace) => {
    const result = await executeTool(session('construir', workspace), 'diagnostics', {
      path: 'no-esta.js',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'path_not_found');
    assert.match(result.error, /ruta no encontrada/);
  });
});

test('null-byte path is invalid', async () => {
  await withWorkspace('sc-diag-nul', async (workspace) => {
    const result = await runDiagnostics(workspace, { path: 'a\0.js' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'path_invalid');
    assert.equal(result.error, ERRORS.path_invalid);
  });
});

test('injectable runner supplies OpenCode LSP diagnostics', async () => {
  await withWorkspace('sc-diag-lsp', async (workspace) => {
    await workspace.writeFile('src/a.js', 'const x = 1;\n');
    const result = await executeTool(session('planificar', workspace), 'diagnostics', {
      path: 'src/a.js',
    }, {
      diagnosticsRunner: async ({ path: rel }) => {
        assert.equal(rel, 'src/a.js');
        return lspMap('src/a.js', [{
          severity: 1,
          message: 'Cannot find name x',
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        }]);
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /ERROR \[1:7\] Cannot find name x/);
    assert.equal(result.counts.errors, 1);
    assert.equal(result.diagnostics[0].line, 1);
  });
});

test('injectable runner array form is jailed and escaped paths are dropped', async () => {
  await withWorkspace('sc-diag-drop', async (workspace) => {
    await workspace.writeFile('in.js', '1');
    const result = await runDiagnostics(workspace, { path: '.' }, {
      diagnosticsRunner: async () => ([
        { path: 'in.js', severity: 1, line: 1, col: 1, message: 'local' },
        { path: '/etc/passwd', severity: 1, line: 1, col: 1, message: 'escape' },
        { path: '../outside.js', severity: 1, line: 1, col: 1, message: 'out' },
      ]),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].path, 'in.js');
    assert.doesNotMatch(result.content, /passwd|outside/);
  });
});

test('runner throw becomes a Spanish runner_failed', async () => {
  await withWorkspace('sc-diag-runerr', async (workspace) => {
    await workspace.writeFile('a.js', '1');
    const result = await runDiagnostics(workspace, { path: 'a.js' }, {
      diagnosticsRunner: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'runner_failed');
    assert.equal(result.error, ERRORS.runner_failed);
  });
});

test('default runner finds a JSON syntax error in the workspace', async () => {
  await withWorkspace('sc-diag-json', async (workspace) => {
    await workspace.writeFile('bad.json', '{');
    const result = await executeTool(session('construir', workspace), 'diagnostics', {
      path: 'bad.json',
    });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /<diagnostics file="bad\.json">/);
    assert.match(result.content, /ERROR \[/);
    assert.equal(result.counts.errors, 1);
  });
});

test('default runner reports Sin diagnósticos on a clean file', async () => {
  await withWorkspace('sc-diag-clean', async (workspace) => {
    await workspace.writeFile('ok.json', '{"a":1}');
    const result = await executeTool(session('planificar', workspace), 'diagnostics', {
      path: 'ok.json',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.content, 'Sin diagnósticos');
    assert.equal(result.counts.total, 0);
  });
});

test('default runner finds a JS syntax error', async () => {
  await withWorkspace('sc-diag-js', async (workspace) => {
    await workspace.writeFile('broke.js', 'const = ;\n');
    const result = await executeTool(session('construir', workspace), 'diagnostics', {
      path: 'broke.js',
    });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /broke\.js/);
    assert.ok(result.counts.errors >= 1);
  });
});

test('severity=error hides warnings from the injectable runner', async () => {
  await withWorkspace('sc-diag-sev', async (workspace) => {
    await workspace.writeFile('a.js', '1');
    const result = await runDiagnostics(workspace, { path: 'a.js', severity: 'error' }, {
      runner: async () => ([
        { path: 'a.js', severity: 1, line: 1, col: 1, message: 'err' },
        { path: 'a.js', severity: 2, line: 2, col: 1, message: 'warn' },
      ]),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.counts.errors, 1);
    assert.equal(result.counts.warnings, 0);
    assert.doesNotMatch(result.content, /WARN/);
  });
});

test('limit truncates with a Spanish hint', async () => {
  await withWorkspace('sc-diag-lim', async (workspace) => {
    await workspace.writeFile('a.js', '1');
    const result = await runDiagnostics(workspace, { path: 'a.js', limit: 2 }, {
      diagnosticsRunner: async () => ([
        { path: 'a.js', severity: 1, line: 1, col: 1, message: 'a' },
        { path: 'a.js', severity: 1, line: 2, col: 1, message: 'b' },
        { path: 'a.js', severity: 1, line: 3, col: 1, message: 'c' },
      ]),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.truncated, true);
    assert.equal(result.diagnostics.length, 2);
    assert.match(result.content, /Resultados truncados/);
  });
});

test('abort signal returns diagnósticos cancelados', async () => {
  await withWorkspace('sc-diag-abort', async (workspace) => {
    await workspace.writeFile('a.js', '1');
    const ac = new AbortController();
    ac.abort();
    const result = await runDiagnostics(workspace, { path: 'a.js' }, { signal: ac.signal });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'aborted');
    assert.equal(result.error, ERRORS.aborted);
  });
});

test('timeout clock returns Spanish timeout', async () => {
  await withWorkspace('sc-diag-to', async (workspace) => {
    await workspace.writeFile('a.js', '1');
    let ticks = 0;
    const result = await runDiagnostics(workspace, { path: 'a.js', timeoutMs: 5 }, {
      now: () => {
        ticks += 1;
        return ticks === 1 ? 0 : 20;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'timeout');
    assert.equal(result.error, ERRORS.timeout);
  });
});

test('default runner skips node_modules', async () => {
  await withWorkspace('sc-diag-skip', async (workspace) => {
    await workspace.writeFile('ok.json', '{}');
    const hidden = path.join(workspace.root, 'node_modules', 'pkg.json');
    fs.mkdirSync(path.dirname(hidden), { recursive: true });
    fs.writeFileSync(hidden, '{');
    const result = await executeTool(session('construir', workspace), 'diagnostics', {});
    assert.equal(result.ok, true, result.error);
    assert.doesNotMatch(result.content, /node_modules/);
    assert.equal(result.content, 'Sin diagnósticos');
  });
});

test('symlink that points outside the workspace is blocked', async () => {
  await withWorkspace('sc-diag-link', async (workspace) => {
    const outside = path.join(os.tmpdir(), `sira-diag-out-${Date.now()}.json`);
    fs.writeFileSync(outside, '{');
    const link = path.join(workspace.root, 'escape.json');
    fs.symlinkSync(outside, link);
    try {
      const result = await executeTool(session('construir', workspace), 'diagnostics', {
        path: 'escape.json',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'path_traversal');
    } finally {
      try { fs.unlinkSync(outside); } catch { /* ignore */ }
    }
  });
});

test('file:// URIs inside the workspace are accepted from the runner', async () => {
  await withWorkspace('sc-diag-uri', async (workspace) => {
    await workspace.writeFile('src/b.js', '1');
    const abs = path.join(workspace.root, 'src', 'b.js');
    const result = await runDiagnostics(workspace, { path: 'src/b.js' }, {
      diagnosticsRunner: async () => ([
        {
          uri: `file://${abs}`,
          severity: 2,
          message: 'unused',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ]),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.diagnostics[0].path, 'src/b.js');
    assert.match(result.content, /WARN \[1:1\] unused/);
  });
});
