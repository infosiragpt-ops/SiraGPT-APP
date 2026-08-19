/**
 * Branch-coverage tests for services/agents/agent-tools.js.
 *
 * Targets pure helpers that the existing agent-tools.test.js does NOT
 * exercise directly (commentPrefixFor, formatChunkSeparator, stripStringLiterals)
 * and the validation paths of propose_patch, list_files, and static_checks
 * that earlier suites covered only superficially. No RAG/openai stubbing
 * is needed — every assertion targets a code path that does not require
 * collection access.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai so requiring the module hierarchy doesn't try to talk to a
// real provider. Mirrors the stub used in agent-tools.test.js.
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.embeddings = { create: async () => ({ data: [] }) };
    }
  },
};
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const tools = require('../src/services/agents/agent-tools');

// ─── commentPrefixFor ──────────────────────────────────────────────────────

test('commentPrefixFor: hash languages map to "#"', () => {
  for (const ext of ['py', 'rb', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'r']) {
    assert.equal(tools.commentPrefixFor(`a.${ext}`), '#', `expected '#' for .${ext}`);
  }
});

test('commentPrefixFor: HTML/XML/Markdown share the block-comment opener', () => {
  for (const ext of ['html', 'htm', 'xml', 'svg', 'md', 'markdown']) {
    assert.equal(tools.commentPrefixFor(`a.${ext}`), '<!--');
  }
});

test('commentPrefixFor: CSS family uses /*', () => {
  for (const ext of ['css', 'scss', 'less']) {
    assert.equal(tools.commentPrefixFor(`a.${ext}`), '/*');
  }
});

test('commentPrefixFor: SQL/Haskell/Lua use --', () => {
  for (const ext of ['sql', 'hs', 'lua', 'ada']) {
    assert.equal(tools.commentPrefixFor(`a.${ext}`), '--');
  }
});

test('commentPrefixFor: Lisp family uses ;;', () => {
  for (const ext of ['lisp', 'clj', 'scm', 'el']) {
    assert.equal(tools.commentPrefixFor(`a.${ext}`), ';;');
  }
});

test('commentPrefixFor: TeX/MATLAB use %, but never .m (Objective-C collision)', () => {
  assert.equal(tools.commentPrefixFor('a.tex'), '%');
  assert.equal(tools.commentPrefixFor('a.matlab'), '%');
  assert.equal(tools.commentPrefixFor('a.m'), '//', '.m must NOT route to "%"; collides with Objective-C');
});

test('commentPrefixFor: JSON returns empty string sentinel', () => {
  assert.equal(tools.commentPrefixFor('a.json'), '');
  assert.equal(tools.commentPrefixFor('a.jsonc'), '');
});

test('commentPrefixFor: unknown / extensionless / non-string fall back to "//"', () => {
  assert.equal(tools.commentPrefixFor('plainfile'), '//');
  assert.equal(tools.commentPrefixFor('a.unknown'), '//');
  assert.equal(tools.commentPrefixFor(undefined), '//');
  assert.equal(tools.commentPrefixFor(null), '//');
  assert.equal(tools.commentPrefixFor(42), '//');
});

// ─── formatChunkSeparator ──────────────────────────────────────────────────

test('formatChunkSeparator: HTML wraps both ends', () => {
  assert.equal(tools.formatChunkSeparator('<!--', 'header'), '<!-- header -->');
});

test('formatChunkSeparator: /* wraps both ends', () => {
  assert.equal(tools.formatChunkSeparator('/*', 'block'), '/* block */');
});

test('formatChunkSeparator: empty prefix returns empty (JSON has no comments)', () => {
  assert.equal(tools.formatChunkSeparator('', 'anything'), '');
});

test('formatChunkSeparator: line-comment languages prepend the prefix', () => {
  assert.equal(tools.formatChunkSeparator('//', 'foo'), '// foo');
  assert.equal(tools.formatChunkSeparator('#', 'bar'), '# bar');
  assert.equal(tools.formatChunkSeparator('--', 'baz'), '-- baz');
});

// ─── stripStringLiterals ───────────────────────────────────────────────────

test('stripStringLiterals: drops chars between matching quotes', () => {
  assert.equal(tools.stripStringLiterals('foo("bar")'), 'foo("")');
});

test('stripStringLiterals: handles escaped backslash followed by closing quote', () => {
  // The inner \\ is a single escape — the closing quote still terminates.
  const out = tools.stripStringLiterals('x = "abc\\"def"');
  // Closing quote present, contents stripped.
  assert.ok(out.endsWith('""'), `expected output to end with empty string literal: ${out}`);
});

test('stripStringLiterals: leaves non-string code intact', () => {
  assert.equal(tools.stripStringLiterals('const a = 1 + 2;'), 'const a = 1 + 2;');
});

test('stripStringLiterals: handles single quotes', () => {
  assert.equal(tools.stripStringLiterals("foo('bar')"), "foo('')");
});

test('stripStringLiterals: handles backticks (template literal-ish)', () => {
  assert.equal(tools.stripStringLiterals('`hello`'), '``');
});

// ─── buildCommentCodeMask ──────────────────────────────────────────────────

test('buildCommentCodeMask: marks code/comment lines correctly for JS', () => {
  const text = 'const a = 1;\n// pure comment\nconst b = 2;\n';
  const { lines, codeMask } = tools.buildCommentCodeMask(text, 'javascript');
  assert.equal(lines.length, 4);
  assert.equal(codeMask[0], true, 'line 0 is code');
  assert.equal(codeMask[1], false, 'line 1 is pure comment');
  assert.equal(codeMask[2], true, 'line 2 is code');
});

test('buildCommentCodeMask: handles Python triple-quoted strings spanning lines', () => {
  const text = 'def f():\n    """\n    docstring\n    """\n    return 1\n';
  const { codeMask } = tools.buildCommentCodeMask(text, 'python');
  // The lines fully inside the triple string have no code.
  assert.equal(codeMask[1], false);
  assert.equal(codeMask[2], false);
  // The return is real code.
  assert.equal(codeMask[4], true);
});

test('buildCommentCodeMask: block comment closes on same line', () => {
  const { codeMask } = tools.buildCommentCodeMask('/* comment */ const x = 1;', 'javascript');
  assert.equal(codeMask[0], true, 'code after block comment counts as code');
});

test('buildCommentCodeMask: block comment spans multiple lines', () => {
  const text = '/* start\nmiddle\nend */ const x = 1;';
  const { codeMask } = tools.buildCommentCodeMask(text, 'javascript');
  assert.equal(codeMask[0], false, 'opener line has only the comment');
  assert.equal(codeMask[1], false, 'middle of block comment');
  assert.equal(codeMask[2], true, 'after */ is code');
});

// ─── propose_patch validation paths ────────────────────────────────────────

test('propose_patch: rejects an inverted line range', async () => {
  const out = await tools.propose_patch.handler({
    source: 'a.js',
    start_line: 10,
    end_line: 5,
    replacement: 'foo',
  });
  assert.ok(out.error && /invalid range/i.test(out.error));
});

test('propose_patch: rejects oversized replacements', async () => {
  const big = 'x'.repeat(200001);
  const out = await tools.propose_patch.handler({
    source: 'a.js',
    replacement: big,
  });
  assert.ok(out.error && /exceeds/.test(out.error));
});

test('propose_patch: missing source returns error', async () => {
  const out = await tools.propose_patch.handler({ replacement: 'x' });
  assert.ok(out.error);
});

test('propose_patch: accepts equal start_line and end_line', async () => {
  const out = await tools.propose_patch.handler({
    source: 'a.js',
    start_line: 7,
    end_line: 7,
    replacement: 'foo',
    rationale: 'one-line fix',
  });
  assert.equal(out.proposed, true);
  assert.equal(out.start_line, 7);
  assert.equal(out.end_line, 7);
  assert.equal(out.rationale, 'one-line fix');
});

test('propose_patch: defaults rationale when none provided', async () => {
  const out = await tools.propose_patch.handler({
    source: 'a.js',
    replacement: 'foo',
  });
  assert.equal(out.proposed, true);
  assert.match(out.rationale, /no rationale/i);
});

test('propose_patch: ignores non-numeric line bounds gracefully', async () => {
  const out = await tools.propose_patch.handler({
    source: 'a.js',
    start_line: 'first',
    end_line: 'last',
    replacement: 'foo',
  });
  assert.equal(out.proposed, true);
  assert.equal(out.start_line, null);
  assert.equal(out.end_line, null);
});

// ─── pick / TOOLS_BY_NAME ──────────────────────────────────────────────────

test('pick: empty input returns empty array', () => {
  assert.deepEqual(tools.pick([]), []);
});

test('TOOLS_BY_NAME: exposes every default tool name', () => {
  for (const name of [
    'read_file', 'list_files', 'search_docs', 'search_code',
    'search_graph', 'get_symbol', 'static_checks', 'propose_patch',
  ]) {
    assert.ok(tools.TOOLS_BY_NAME.has(name), `missing ${name}`);
  }
});

// ─── static_checks: input validation paths ─────────────────────────────────

test('static_checks: rejects non-string content', async () => {
  const out = await tools.static_checks.handler(
    { source: 'a.js', content: 12345 },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.error && /must be a string/.test(out.error));
});

test('static_checks: truncates oversized content and reports it', async () => {
  const big = 'a = 1;\n'.repeat(40000); // ~280 KB > 200 KB cap
  const out = await tools.static_checks.handler(
    { source: 'a.js', content: big },
    { userId: 'u', collection: 'c' },
  );
  assert.equal(out.inputTruncated, true);
  assert.ok(out.scannedChars && out.scannedChars <= 200000);
});

test('static_checks: surfaces empty findings cleanly for trivial code', async () => {
  const out = await tools.static_checks.handler(
    { source: 'safe.js', content: 'const a = 1;\nconst b = a + 2;\n' },
    { userId: 'u', collection: 'c' },
  );
  assert.equal(out.counts.high, 0);
  assert.equal(out.counts.warn, 0);
  // long_source threshold is 80 lines — this stays well under.
  const longSrc = out.findings.filter(f => f.rule === 'long_source');
  assert.equal(longSrc.length, 0);
});

test('static_checks: ensure ctx validation is enforced', async () => {
  await assert.rejects(
    () => tools.static_checks.handler({ source: 'a.js', content: 'x' }, { userId: 'u' }),
    /collection/i,
  );
});

test('static_checks: weak_crypto flags md5/sha1 createHash but not sha256', async () => {
  const md5 = "const h = crypto.createHash('md5');\n";
  const sha1 = "const h = crypto.createHash('sha-1');\n";
  const sha256 = "const h = crypto.createHash('sha256');\n";
  const a = await tools.static_checks.handler({ source: 'a.js', content: md5 }, { userId: 'u', collection: 'c' });
  const b = await tools.static_checks.handler({ source: 'a.js', content: sha1 }, { userId: 'u', collection: 'c' });
  const c = await tools.static_checks.handler({ source: 'a.js', content: sha256 }, { userId: 'u', collection: 'c' });
  assert.ok(a.findings.some(f => f.rule === 'weak_crypto'));
  assert.ok(b.findings.some(f => f.rule === 'weak_crypto'));
  assert.equal(c.findings.filter(f => f.rule === 'weak_crypto').length, 0);
});

test('static_checks: disabled_ssl_verification flags rejectUnauthorized:false and verify=False', async () => {
  const js = 'const agent = new https.Agent({ rejectUnauthorized: false });\n';
  const py = 'requests.get(url, verify=False)\n';
  const a = await tools.static_checks.handler({ source: 'a.js', content: js }, { userId: 'u', collection: 'c' });
  const b = await tools.static_checks.handler({ source: 'a.py', content: py }, { userId: 'u', collection: 'c' });
  assert.ok(a.findings.some(f => f.rule === 'disabled_ssl_verification'));
  assert.ok(b.findings.some(f => f.rule === 'disabled_ssl_verification'));
});

test('static_checks: subprocess_shell_true flags vulnerable shell calls', async () => {
  const py = "subprocess.run('ls ' + path, shell=True)\n";
  const out = await tools.static_checks.handler({ source: 'a.py', content: py }, { userId: 'u', collection: 'c' });
  assert.ok(out.findings.some(f => f.rule === 'subprocess_shell_true'));
});

test('static_checks: insecure_random_secret only fires with sensitive context', async () => {
  const sensitive = 'const token = Math.random().toString(36);\n';
  const benign = 'const x = Math.random();\n';
  const a = await tools.static_checks.handler({ source: 'a.js', content: sensitive }, { userId: 'u', collection: 'c' });
  const b = await tools.static_checks.handler({ source: 'a.js', content: benign }, { userId: 'u', collection: 'c' });
  assert.ok(a.findings.some(f => f.rule === 'insecure_random_secret'));
  assert.equal(b.findings.filter(f => f.rule === 'insecure_random_secret').length, 0);
});

test('static_checks: unsafe_innerhtml flags innerHTML, document.write, dangerouslySetInnerHTML', async () => {
  const cases = [
    'el.innerHTML = userInput;',
    'document.write(userInput);',
    'return <div dangerouslySetInnerHTML={{__html: x}} />;',
  ];
  for (const c of cases) {
    const out = await tools.static_checks.handler({ source: 'a.js', content: `${c}\n` }, { userId: 'u', collection: 'c' });
    assert.ok(out.findings.some(f => f.rule === 'unsafe_innerhtml'), `case not flagged: ${c}`);
  }
});

test('static_checks: empty_catch flags JS empty catch and Python except: pass', async () => {
  const js = 'try { doX(); } catch (e) {}\n';
  const py = 'try:\n    do_x()\nexcept:\n    pass\n';
  const a = await tools.static_checks.handler({ source: 'a.js', content: js }, { userId: 'u', collection: 'c' });
  const b = await tools.static_checks.handler({ source: 'a.py', content: py }, { userId: 'u', collection: 'c' });
  assert.ok(a.findings.some(f => f.rule === 'empty_catch'));
  assert.ok(b.findings.some(f => f.rule === 'empty_catch'));
});

test('static_checks: dynamic_require flags non-literal require()', async () => {
  const out = await tools.static_checks.handler(
    { source: 'a.js', content: 'const m = require(name);\n' },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.findings.some(f => f.rule === 'dynamic_require'));
});

test('static_checks: dynamic_require does NOT flag literal string require()', async () => {
  const out = await tools.static_checks.handler(
    { source: 'a.js', content: "const m = require('fs');\n" },
    { userId: 'u', collection: 'c' },
  );
  assert.equal(out.findings.filter(f => f.rule === 'dynamic_require').length, 0);
});

test('static_checks: unsafe_pickle flags pickle.load(s)', async () => {
  const out = await tools.static_checks.handler(
    { source: 'a.py', content: 'import pickle\nobj = pickle.loads(data)\n' },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.findings.some(f => f.rule === 'unsafe_pickle'));
});

test('static_checks: unsafe_yaml_load flags yaml.load without Loader=', async () => {
  const bad = 'cfg = yaml.load(stream)\n';
  const safe = 'cfg = yaml.safe_load(stream)\n';
  const safe2 = 'cfg = yaml.load(stream, Loader=yaml.SafeLoader)\n';
  const a = await tools.static_checks.handler({ source: 'a.py', content: bad }, { userId: 'u', collection: 'c' });
  const b = await tools.static_checks.handler({ source: 'a.py', content: safe }, { userId: 'u', collection: 'c' });
  const c = await tools.static_checks.handler({ source: 'a.py', content: safe2 }, { userId: 'u', collection: 'c' });
  assert.ok(a.findings.some(f => f.rule === 'unsafe_yaml_load'));
  assert.equal(b.findings.filter(f => f.rule === 'unsafe_yaml_load').length, 0);
  assert.equal(c.findings.filter(f => f.rule === 'unsafe_yaml_load').length, 0);
});

test('static_checks: os_system_call flags os.system / os.popen', async () => {
  const out = await tools.static_checks.handler(
    { source: 'a.py', content: "os.system('rm ' + p)\nos.popen('ls')\n" },
    { userId: 'u', collection: 'c' },
  );
  assert.ok(out.findings.filter(f => f.rule === 'os_system_call').length >= 1);
});

test('static_checks: counts findings sorted by line', async () => {
  const code = [
    "// TODO: at line 1",
    "const k = 'sk-aaaaaaaaaaaaaaaaaaaa'; // hardcoded_secret line 2",
    "eval(x); // eval line 3",
  ].join('\n') + '\n';
  const out = await tools.static_checks.handler(
    { source: 'a.js', content: code }, { userId: 'u', collection: 'c' },
  );
  const lines = out.findings.map(f => f.line);
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i] >= lines[i - 1], 'findings should be ordered by line ascending');
  }
});
