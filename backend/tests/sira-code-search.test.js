'use strict';

/**
 * SiraCode grep / glob — workspace jail, caps, Spanish errors.
 * Offline: temp workspace, no rg binary, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createWorkspace } = require('../src/services/sira-code/workspace');
const { executeTool, TOOL_DEFINITIONS } = require('../src/services/sira-code/tools');
const {
  matchGlob,
  expandBracePatterns,
  searchGrep,
  searchGlob,
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
} = require('../src/services/sira-code/search');

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

test('matchGlob follows ripgrep-style *.ext in any directory', () => {
  assert.equal(matchGlob('app.js', '*.js'), true);
  assert.equal(matchGlob('src/app.js', '*.js'), true);
  assert.equal(matchGlob('src/app.ts', '*.js'), false);
  assert.equal(matchGlob('src/deep/app.js', 'src/*.js'), false);
  assert.equal(matchGlob('src/app.js', 'src/*.js'), true);
  assert.equal(matchGlob('src/deep/app.js', 'src/**/*.js'), true);
});

test('expandBracePatterns expands *.{ts,tsx}', () => {
  assert.deepEqual(expandBracePatterns('*.{ts,tsx}').sort(), ['*.ts', '*.tsx']);
});

test('grep finds a line with Spanish heading and Línea label', async () => {
  await withWorkspace('sc-grep-hit', async (workspace) => {
    await workspace.writeFile('src/app.js', 'const n = 1;\nfunction greet() {}\n');
    const result = await executeTool(session('construir', workspace), 'grep', {
      pattern: 'function\\s+greet',
    });
    assert.equal(result.ok, true, result.error);
    assert.match(result.content, /Se encontraron 1 coincidencias/);
    assert.match(result.content, /src\/app\.js:/);
    assert.match(result.content, /Línea 2:/);
    assert.match(result.content, /function greet/);
    assert.equal(result.matches, 1);
  });
});

test('grep reports Sin coincidencias when nothing matches', async () => {
  await withWorkspace('sc-grep-empty', async (workspace) => {
    await workspace.writeFile('a.txt', 'hola');
    const result = await executeTool(session('construir', workspace), 'grep', {
      pattern: 'zzz-no-esta',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.content, 'Sin coincidencias');
    assert.equal(result.matches, 0);
  });
});

test('grep missing pattern returns Spanish validation error', async () => {
  await withWorkspace('sc-grep-req', async (workspace) => {
    const result = await executeTool(session('construir', workspace), 'grep', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation');
    assert.match(result.error, /patrón es obligatorio/);
  });
});

test('grep invalid regex returns Spanish validation error', async () => {
  await withWorkspace('sc-grep-re', async (workspace) => {
    const result = await executeTool(session('construir', workspace), 'grep', {
      pattern: '[unterminated',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation');
    assert.match(result.error, /expresión regular válida/);
  });
});

test('grep blocks path escape outside the workspace', async () => {
  await withWorkspace('sc-grep-jail', async (workspace) => {
    await workspace.writeFile('ok.txt', 'dentro');
    for (const escape of ['../secret.txt', '/etc/passwd', '..\\..\\etc\\passwd']) {
      const result = await executeTool(session('construir', workspace), 'grep', {
        pattern: 'root',
        path: escape,
      });
      assert.equal(result.ok, false, escape);
      assert.equal(result.code, 'path_traversal', escape);
      assert.match(result.error, /fuera del workspace/);
    }
  });
});

test('grep include filters by glob including braces', async () => {
  await withWorkspace('sc-grep-inc', async (workspace) => {
    await workspace.writeFile('a.js', 'token ALPHA');
    await workspace.writeFile('b.ts', 'token BETA');
    await workspace.writeFile('c.md', 'token GAMMA');
    const jsOnly = await executeTool(session('construir', workspace), 'grep', {
      pattern: 'token',
      include: '*.js',
    });
    assert.equal(jsOnly.ok, true, jsOnly.error);
    assert.equal(jsOnly.matches, 1);
    assert.match(jsOnly.content, /a\.js/);
    assert.ok(!jsOnly.content.includes('b.ts'));
    const braced = await executeTool(session('construir', workspace), 'grep', {
      pattern: 'token',
      include: '*.{js,ts}',
    });
    assert.equal(braced.matches, 2);
    assert.match(braced.content, /a\.js/);
    assert.match(braced.content, /b\.ts/);
    assert.ok(!braced.content.includes('c.md'));
  });
});

test('grep limit truncates with Spanish note and caps at 100', async () => {
  await withWorkspace('sc-grep-lim', async (workspace) => {
    await workspace.writeFile('many.txt', Array.from({ length: 8 }, (_, i) => `hit ${i}`).join('\n'));
    const result = await executeTool(session('construir', workspace), 'grep', {
      pattern: 'hit',
      limit: 3,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.matches, 3);
    assert.equal(result.truncated, true);
    assert.match(result.content, /Resultados truncados/);
    assert.equal(MAX_RESULT_LIMIT, DEFAULT_RESULT_LIMIT);
    assert.equal(MAX_RESULT_LIMIT, 100);
  });
});

test('grep ignoreCase matches regardless of case', async () => {
  await withWorkspace('sc-grep-i', async (workspace) => {
    await workspace.writeFile('n.txt', 'Hola Mundo');
    const sensitive = await executeTool(session('construir', workspace), 'grep', {
      pattern: 'hola',
    });
    assert.equal(sensitive.matches, 0);
    const loose = await executeTool(session('construir', workspace), 'grep', {
      pattern: 'hola',
      ignoreCase: true,
    });
    assert.equal(loose.matches, 1);
  });
});

test('grep can target a single file path', async () => {
  await withWorkspace('sc-grep-file', async (workspace) => {
    await workspace.writeFile('keep.js', 'alpha');
    await workspace.writeFile('skip.js', 'alpha');
    const result = await executeTool(session('construir', workspace), 'grep', {
      pattern: 'alpha',
      path: 'keep.js',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.matches, 1);
    assert.match(result.content, /keep\.js/);
    assert.ok(!result.content.includes('skip.js'));
  });
});

test('grep skips binary files and oversized files', async () => {
  await withWorkspace('sc-grep-skip', async (workspace) => {
    await workspace.writeFile('plain.txt', 'needle visible');
    fs.writeFileSync(path.join(workspace.root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65]));
    const binary = await searchGrep(workspace, { pattern: 'nee' });
    assert.equal(binary.ok, true, binary.error);
    assert.equal(binary.matches, 1);
    assert.match(binary.content, /plain\.txt/);
    assert.equal(binary.partial, true);

    await workspace.writeFile('big.txt', 'needle ' + 'x'.repeat(40));
    const sized = await searchGrep(workspace, { pattern: 'needle' }, { maxFileBytes: 20 });
    assert.equal(sized.ok, true, sized.error);
    assert.ok(sized.matches >= 1);
    assert.equal(sized.partial, true);
    assert.match(sized.content, /no se pudieron leer/);
  });
});

test('grep skips symlinks so a host file cannot leak', async () => {
  await withWorkspace('sc-grep-link', async (workspace) => {
    await workspace.writeFile('ok.txt', 'workspace-ok');
    const outside = path.join(path.dirname(workspace.root), `sira-leak-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'LEAK_HOST_SECRET');
    try {
      fs.symlinkSync(outside, path.join(workspace.root, 'link.txt'));
      const result = await executeTool(session('construir', workspace), 'grep', {
        pattern: 'LEAK_HOST_SECRET',
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.matches, 0);
      assert.ok(!String(result.content).includes('LEAK_HOST_SECRET'));
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test('grep times out with Spanish error when the clock expires', async () => {
  await withWorkspace('sc-grep-to', async (workspace) => {
    await workspace.writeFile('a.txt', 'hola');
    let ticks = 0;
    const result = await searchGrep(workspace, { pattern: 'hola', timeoutMs: 5 }, {
      now: () => {
        ticks += 1;
        return ticks === 1 ? 0 : 20;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'timeout');
    assert.match(result.error, /tiempo máximo/);
  });
});

test('grep aborted signal returns Spanish cancelled error', async () => {
  await withWorkspace('sc-grep-ab', async (workspace) => {
    await workspace.writeFile('a.txt', 'hola');
    const ac = new AbortController();
    ac.abort();
    const result = await searchGrep(workspace, { pattern: 'hola' }, { signal: ac.signal });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'aborted');
    assert.match(result.error, /cancelada/);
  });
});

test('planificar and construir can grep; planificar cannot write', async () => {
  await withWorkspace('sc-grep-perm', async (workspace) => {
    await workspace.writeFile('n.txt', 'visible');
    const plan = await executeTool(session('planificar', workspace), 'grep', { pattern: 'visible' });
    assert.equal(plan.ok, true, plan.error);
    assert.equal(plan.permission.denied, false);
    const build = await executeTool(session('construir', workspace), 'grep', { pattern: 'visible' });
    assert.equal(build.ok, true, build.error);
    const write = await executeTool(session('planificar', workspace), 'write', {
      path: 'nope.txt',
      content: 'x',
    });
    assert.equal(write.ok, false);
    assert.equal(write.permission.denied, true);
  });
});

test('glob lists matching files and reports Sin archivos', async () => {
  await withWorkspace('sc-glob-hit', async (workspace) => {
    await workspace.writeFile('src/a.js', '1');
    await workspace.writeFile('src/b.ts', '2');
    const hit = await executeTool(session('construir', workspace), 'glob', { pattern: '**/*.js' });
    assert.equal(hit.ok, true, hit.error);
    assert.match(hit.content, /src\/a\.js/);
    assert.ok(!hit.content.includes('b.ts'));
    const miss = await executeTool(session('construir', workspace), 'glob', { pattern: '*.py' });
    assert.equal(miss.ok, true, miss.error);
    assert.equal(miss.content, 'Sin archivos');
  });
});

test('glob path acota the tree and blocks escape', async () => {
  await withWorkspace('sc-glob-path', async (workspace) => {
    await workspace.writeFile('src/in.js', '1');
    await workspace.writeFile('out.js', '2');
    const scoped = await executeTool(session('construir', workspace), 'glob', {
      pattern: '*.js',
      path: 'src',
    });
    assert.equal(scoped.ok, true, scoped.error);
    assert.match(scoped.content, /src\/in\.js/);
    assert.ok(!scoped.content.includes('out.js'));
    const escaped = await executeTool(session('construir', workspace), 'glob', {
      pattern: '*',
      path: '../',
    });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.code, 'path_traversal');
  });
});

test('glob rejects shell metacharacters with Spanish error', async () => {
  await withWorkspace('sc-glob-sh', async (workspace) => {
    const result = await executeTool(session('construir', workspace), 'glob', {
      pattern: '*.js; rm -rf /',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'validation');
    assert.match(result.error, /patrón de archivos/);
  });
});

test('glob missing pattern and list_files alias', async () => {
  await withWorkspace('sc-glob-alias', async (workspace) => {
    await workspace.writeFile('z.txt', 'z');
    const missing = await executeTool(session('construir', workspace), 'glob', {});
    assert.equal(missing.ok, false);
    assert.match(missing.error, /patrón es obligatorio/);
    const aliased = await executeTool(session('construir', workspace), 'list_files', {
      pattern: '*.txt',
    });
    assert.equal(aliased.ok, true, aliased.error);
    assert.equal(aliased.permission.tool, 'glob');
    assert.match(aliased.content, /z\.txt/);
  });
});

test('glob limit truncates and skips SKIP_DIRS', async () => {
  await withWorkspace('sc-glob-lim', async (workspace) => {
    await workspace.writeFile('one.js', '1');
    await workspace.writeFile('two.js', '2');
    await workspace.writeFile('three.js', '3');
    await workspace.writeFile('node_modules/hidden.js', 'no');
    const limited = await executeTool(session('construir', workspace), 'glob', {
      pattern: '*.js',
      limit: 2,
    });
    assert.equal(limited.ok, true, limited.error);
    assert.equal(limited.items.length, 2);
    assert.equal(limited.truncated, true);
    assert.match(limited.content, /Resultados truncados/);
    const all = await executeTool(session('construir', workspace), 'glob', { pattern: '*.js' });
    assert.ok(!all.content.includes('node_modules'));
    assert.match(all.content, /one\.js/);
  });
});

test('planificar can glob; composer read still allows search', async () => {
  await withWorkspace('sc-glob-perm', async (workspace) => {
    await workspace.writeFile('p.txt', 'p');
    const plan = await executeTool(session('planificar', workspace), 'glob', { pattern: '*.txt' });
    assert.equal(plan.ok, true, plan.error);
    const readOnly = await executeTool(session('construir', workspace, { permission: 'read' }), 'glob', {
      pattern: '*.txt',
    });
    assert.equal(readOnly.ok, true, readOnly.error);
    const blocked = await executeTool(session('construir', workspace, { permission: 'read' }), 'write', {
      path: 'x.txt',
      content: 'no',
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'composer_read_only');
  });
});

test('TOOL_DEFINITIONS expose OpenCode-style grep/glob parameters', () => {
  const names = TOOL_DEFINITIONS.map((item) => item.function.name);
  assert.ok(names.includes('grep'));
  assert.ok(names.includes('glob'));
  const grep = TOOL_DEFINITIONS.find((item) => item.function.name === 'grep');
  const glob = TOOL_DEFINITIONS.find((item) => item.function.name === 'glob');
  assert.deepEqual(Object.keys(grep.function.parameters.properties).sort(), [
    'include',
    'limit',
    'path',
    'pattern',
  ]);
  assert.deepEqual(Object.keys(glob.function.parameters.properties).sort(), [
    'limit',
    'path',
    'pattern',
  ]);
});

test('searchGlob times out with Spanish error', async () => {
  await withWorkspace('sc-glob-to', async (workspace) => {
    await workspace.writeFile('a.js', '1');
    let ticks = 0;
    const result = await searchGlob(workspace, { pattern: '*.js', timeoutMs: 5 }, {
      now: () => {
        ticks += 1;
        return ticks === 1 ? 0 : 20;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'timeout');
    assert.match(result.error, /tiempo máximo/);
  });
});
