'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'backend/tests/fixtures/codex-fullstack-gvisor');
const { fullStackStarterFiles } = require(path.join(
  ROOT,
  'backend/src/services/codex/starter-files',
));

function requireSafeTarget(rawTarget) {
  if (!rawTarget || !path.isAbsolute(rawTarget)) {
    throw new Error('usage: node scripts/generate-gvisor-fullstack-fixture.js /absolute/target');
  }
  const requested = path.resolve(rawTarget);
  const parent = path.dirname(requested);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`fixture parent must be a real directory: ${parent}`);
  }
  const target = path.join(fs.realpathSync(parent), path.basename(requested));
  if (
    target === path.parse(target).root
    || target === ROOT
    || target.startsWith(`${ROOT}${path.sep}`)
    || ROOT.startsWith(`${target}${path.sep}`)
  ) {
    throw new Error(`refusing unsafe fixture target: ${target}`);
  }
  if (fs.existsSync(target)) throw new Error(`fixture target must not exist: ${target}`);
  return target;
}

function writeStarter(rawTarget) {
  const target = requireSafeTarget(rawTarget);
  const files = fullStackStarterFiles({ projectName: 'gVisor full-stack smoke' });
  const packageFile = files.find((file) => file.path === 'package.json');
  assert.ok(packageFile, 'fullStackStarterFiles must include package.json');

  const generatedPackage = JSON.parse(packageFile.content);
  const lockedPackage = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'package-lock.json'), 'utf8'));
  assert.deepStrictEqual(
    generatedPackage,
    lockedPackage,
    'the committed dependency fixture must exactly match fullStackStarterFiles',
  );
  assert.equal(packageLock.lockfileVersion, 3, 'package-lock.json must use lockfileVersion 3');
  assert.equal(packageLock.name, generatedPackage.name);
  assert.equal(packageLock.version, generatedPackage.version);
  assert.deepStrictEqual(packageLock.packages[''].dependencies, generatedPackage.dependencies);
  assert.deepStrictEqual(packageLock.packages[''].devDependencies, generatedPackage.devDependencies);

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const targetStat = fs.lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`fixture target is not a real directory: ${target}`);
  }
  for (const file of files) {
    const destination = path.resolve(target, file.path);
    if (!destination.startsWith(`${target}${path.sep}`)) {
      throw new Error(`starter emitted an unsafe path: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, file.content, { encoding: 'utf8', mode: 0o600 });
  }

  for (const lockName of ['package-lock.json', 'bun.lock']) {
    fs.copyFileSync(path.join(FIXTURE_DIR, lockName), path.join(target, lockName));
    fs.chmodSync(path.join(target, lockName), 0o600);
  }

  return { target, files: files.length };
}

if (require.main === module) {
  const result = writeStarter(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { requireSafeTarget, writeStarter };
