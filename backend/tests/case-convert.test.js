'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { words, toCamel, toPascal, toSnake, toKebab, toTitle, convertKeys } = require('../src/utils/case-convert');

describe('words', () => {
  test('camelCase split', () => {
    assert.deepEqual(words('helloWorld'), ['hello', 'world']);
  });
  test('PascalCase split', () => {
    assert.deepEqual(words('HelloWorld'), ['hello', 'world']);
  });
  test('snake_case split', () => {
    assert.deepEqual(words('hello_world_foo'), ['hello', 'world', 'foo']);
  });
  test('kebab-case split', () => {
    assert.deepEqual(words('hello-world'), ['hello', 'world']);
  });
  test('handles UPPER ABBREV before next word: parseHTMLString', () => {
    assert.deepEqual(words('parseHTMLString'), ['parse', 'html', 'string']);
  });
  test('digits split cleanly', () => {
    assert.deepEqual(words('user2name'), ['user2name']); // sticks (no boundary)
    assert.deepEqual(words('user2Name'), ['user2', 'name']);
  });
  test('empty / null → []', () => {
    assert.deepEqual(words(''), []);
    assert.deepEqual(words(null), []);
  });
});

describe('converters', () => {
  const cases = [
    ['helloWorld', { camel: 'helloWorld', pascal: 'HelloWorld', snake: 'hello_world', kebab: 'hello-world', title: 'Hello World' }],
    ['hello_world', { camel: 'helloWorld', pascal: 'HelloWorld', snake: 'hello_world', kebab: 'hello-world', title: 'Hello World' }],
    ['Hello-World', { camel: 'helloWorld', pascal: 'HelloWorld', snake: 'hello_world', kebab: 'hello-world', title: 'Hello World' }],
    ['XMLParser', { camel: 'xmlParser', pascal: 'XmlParser', snake: 'xml_parser', kebab: 'xml-parser', title: 'Xml Parser' }],
  ];
  for (const [input, expected] of cases) {
    test(`toCamel(${input})`, () => assert.equal(toCamel(input), expected.camel));
    test(`toPascal(${input})`, () => assert.equal(toPascal(input), expected.pascal));
    test(`toSnake(${input})`, () => assert.equal(toSnake(input), expected.snake));
    test(`toKebab(${input})`, () => assert.equal(toKebab(input), expected.kebab));
    test(`toTitle(${input})`, () => assert.equal(toTitle(input), expected.title));
  }

  test('all converters handle empty input', () => {
    for (const fn of [toCamel, toPascal, toSnake, toKebab, toTitle]) {
      assert.equal(fn(''), '');
    }
  });
});

describe('convertKeys', () => {
  test('recursively renames keys in objects', () => {
    const input = { user_name: 'a', nested_obj: { inner_key: 1 } };
    const out = convertKeys(input, toCamel);
    assert.deepEqual(out, { userName: 'a', nestedObj: { innerKey: 1 } });
  });

  test('walks arrays without renaming indices', () => {
    const input = [{ first_name: 'a' }, { first_name: 'b' }];
    const out = convertKeys(input, toCamel);
    assert.deepEqual(out, [{ firstName: 'a' }, { firstName: 'b' }]);
  });

  test('leaves class instances / non-plain objects alone', () => {
    const d = new Date(123);
    const out = convertKeys({ created_at: d }, toCamel);
    assert.equal(out.createdAt, d);
  });

  test('non-function fn throws', () => {
    assert.throws(() => convertKeys({}, 'nope'), TypeError);
  });
});
