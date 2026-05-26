'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const p = require('../src/utils/posix-path');

describe('isAbsolute', () => {
  test('detects leading /', () => {
    assert.equal(p.isAbsolute('/a/b'), true);
    assert.equal(p.isAbsolute('a/b'), false);
    assert.equal(p.isAbsolute(''), false);
  });
});

describe('normalize', () => {
  test('collapses //', () => {
    assert.equal(p.normalize('//a///b//c'), '/a/b/c');
  });
  test('resolves .', () => {
    assert.equal(p.normalize('a/./b/./c'), 'a/b/c');
  });
  test('resolves ..', () => {
    assert.equal(p.normalize('a/b/../c'), 'a/c');
  });
  test('absolute .. cannot escape root', () => {
    assert.equal(p.normalize('/a/../../b'), '/b');
  });
  test('relative .. preserved when no parent', () => {
    assert.equal(p.normalize('../a'), '../a');
  });
  test('preserves trailing slash', () => {
    assert.equal(p.normalize('a/b/'), 'a/b/');
  });
  test('empty / non-string → .', () => {
    assert.equal(p.normalize(''), '.');
    assert.equal(p.normalize(null), '.');
  });
});

describe('join', () => {
  test('joins parts with normalization', () => {
    assert.equal(p.join('a', 'b', 'c'), 'a/b/c');
    assert.equal(p.join('/a', 'b', '../c'), '/a/c');
  });
  test('skips empty parts', () => {
    assert.equal(p.join('a', '', 'b'), 'a/b');
  });
  test('zero parts → .', () => {
    assert.equal(p.join(), '.');
  });
});

describe('dirname / basename / extname', () => {
  test('dirname strips last segment', () => {
    assert.equal(p.dirname('/a/b/c'), '/a/b');
    assert.equal(p.dirname('a/b'), 'a');
    assert.equal(p.dirname('/single'), '/');
    assert.equal(p.dirname('alone'), '.');
  });
  test('basename returns last segment', () => {
    assert.equal(p.basename('/a/b/c.txt'), 'c.txt');
    assert.equal(p.basename('alone'), 'alone');
  });
  test('basename with extension strip', () => {
    assert.equal(p.basename('a/b/file.txt', '.txt'), 'file');
    assert.equal(p.basename('a/b/.bashrc', '.bashrc'), '.bashrc'); // never strip the whole name
  });
  test('extname returns dotted suffix', () => {
    assert.equal(p.extname('a/b/c.txt'), '.txt');
    assert.equal(p.extname('a/b/c'), '');
    assert.equal(p.extname('.hidden'), '');
  });
});

describe('isSafeRelative', () => {
  test('safe relative paths', () => {
    assert.equal(p.isSafeRelative('a/b/c'), true);
    assert.equal(p.isSafeRelative('a/./b'), true);
  });
  test('rejects absolute paths', () => {
    assert.equal(p.isSafeRelative('/etc/passwd'), false);
  });
  test('rejects paths that escape root via ..', () => {
    assert.equal(p.isSafeRelative('../etc/passwd'), false);
    assert.equal(p.isSafeRelative('a/../../b'), false);
  });
  test('rejects empty / non-string', () => {
    assert.equal(p.isSafeRelative(''), false);
    assert.equal(p.isSafeRelative(null), false);
  });
});
