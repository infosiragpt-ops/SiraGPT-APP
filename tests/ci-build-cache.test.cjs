'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const minimatch = require('minimatch');

const workflow = readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
// GitHub hashFiles uses @actions/glob, whose internal-pattern explicitly sets
// nobrace/noext. Tailwind's brace expansion is not the cache matcher contract.
// https://github.com/actions/toolkit/blob/main/packages/glob/src/internal-pattern.ts
const githubOptions = Object.freeze({
  dot: true, nobrace: true, nocase: false, nocomment: true, noext: true, nonegate: true,
});
const affectedFiles = [
  'package-lock.json',
  ...['app', 'components', 'lib', 'hooks'].flatMap((directory) =>
    ['ts', 'tsx', 'js', 'jsx', 'css'].map((extension) => `${directory}/nested/cache-input.${extension}`)),
  'app/globals.css', 'components/chat/integrated-browser-bar.tsx',
  'hooks/use-chat.ts', 'styles/globals.css',
  ...['src', 'pages'].flatMap((directory) => ['ts', 'tsx'].map((extension) => `${directory}/nested/input.${extension}`)),
  ...['js', 'ts', 'jsx', 'tsx', 'mdx'].map((extension) => `input.${extension}`),
  'next.config.mjs', 'tailwind.config.js', 'postcss.config.js', 'postcss.config.mjs',
];
const fixture = new Map(affectedFiles.map((file) => [file, Buffer.from(`fixture-before:${file}`)]));

function cacheStep(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, 'the existing Next cache step must remain');
  const end = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}
function patternsIn(step) {
  const key = step.match(/^\s*key: (.+)$/m)?.[1];
  assert.ok(key, 'cache key must exist');
  const expressions = [...key.matchAll(/hashFiles\(([^)]*)\)/g)];
  assert.ok(expressions.length > 0, 'cache key must hash inputs');
  return expressions.flatMap((expression) => [...expression[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
}
function fingerprint(patterns, files) {
  const selected = [...files.keys()].sort().filter((file) => patterns.some((pattern) => minimatch(file, pattern, githubOptions)));
  if (selected.length === 0) return '';
  const aggregate = createHash('sha256');
  for (const file of selected) aggregate.update(createHash('sha256').update(files.get(file)).digest());
  return aggregate.digest('hex');
}

test('the cache matcher treats brace alternatives literally, as GitHub does', () => {
  assert.equal(minimatch('app/globals.css', 'app/**/*.{ts,tsx,js,jsx,css}', githubOptions), false);
  assert.equal(minimatch('app/globals.css', 'app/**/*.css', githubOptions), true);
});

for (const name of ['Cache Next.js build', 'Cache Next.js e2e build']) {
  test(`${name} changes its key for each source, stylesheet, hook and build configuration`, () => {
    const step = cacheStep(name);
    assert.match(step, /^\s*path: \.next\/cache\s*$/m);
    assert.doesNotMatch(step, /^\s*restore-keys:/m, 'partial cache restores must remain disabled');
    const patterns = patternsIn(step);
    const before = fingerprint(patterns, fixture);
    for (const file of affectedFiles) {
      const changed = new Map(fixture);
      changed.set(file, Buffer.from(`fixture-after:${file}`));
      assert.notEqual(fingerprint(patterns, changed), before, `${name} must be invalidated by ${file}`);
    }
    const unrelated = new Map(fixture);
    unrelated.set('backend/private-fixture.txt', Buffer.from('unrelated fixture'));
    assert.equal(fingerprint(patterns, unrelated), before, 'unrelated backend files are not added to the frontend cache');
  });
}

test('the cache regression runs before both production frontend builds without ignoring failure', () => {
  for (const [name, command] of [['Next.js build', 'npm run build'], ['Next.js production build for the gate', 'npx next build --no-lint']]) {
    const step = cacheStep(name);
    const regression = step.indexOf('tests/ci-build-cache.test.cjs');
    assert.ok(regression >= 0 && regression < step.indexOf(command), 'cache regression must precede the build');
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true/);
  }
});
