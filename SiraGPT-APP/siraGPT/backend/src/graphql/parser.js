'use strict';

// Tiny GraphQL parser — supports the subset we need for the spike:
//   - query / mutation operations (named or anonymous)
//   - variable definitions:  query Q($id: ID!, $limit: Int = 10)
//   - field selections with arguments
//   - nested selection sets
//   - inline string / int / float / boolean / null / enum / list / object args
//   - $variable references in args
//
// Out of scope (intentional for a spike): fragments, directives, subscriptions,
// aliases, unions/interfaces, schema definition language. Keeping the surface
// small lets us audit the parser by hand.

class ParseError extends Error {
  constructor(message, pos) {
    super(`GraphQL parse error at ${pos}: ${message}`);
    this.name = 'ParseError';
    this.pos = pos;
  }
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (/\s|,/.test(c)) { i++; continue; }
    if ('{}()[]:!='.includes(c)) {
      tokens.push({ kind: 'punct', value: c, pos: i });
      i++; continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'var', value: src.slice(i + 1, j), pos: i });
      i = j; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { value += src[j + 1]; j += 2; continue; }
        value += src[j];
        j++;
      }
      if (j >= src.length) throw new ParseError('unterminated string', i);
      tokens.push({ kind: 'string', value, pos: i });
      i = j + 1; continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      const raw = src.slice(i, j);
      tokens.push({ kind: isFloat ? 'float' : 'int', value: raw, pos: i });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j), pos: i });
      i = j; continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)}`, i);
  }
  tokens.push({ kind: 'eof', value: '', pos: src.length });
  return tokens;
}

function parse(src) {
  if (typeof src !== 'string' || !src.trim()) {
    throw new ParseError('empty query', 0);
  }
  const tokens = tokenize(src);
  let p = 0;
  const peek = (n = 0) => tokens[p + n];
  const eat = () => tokens[p++];
  const expect = (kind, value) => {
    const t = tokens[p];
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new ParseError(`expected ${kind}${value ? ` "${value}"` : ''} got ${t.kind} "${t.value}"`, t.pos);
    }
    return eat();
  };

  function parseDocument() {
    const operations = [];
    while (peek().kind !== 'eof') {
      operations.push(parseOperation());
    }
    if (operations.length === 0) throw new ParseError('no operations', 0);
    return { operations };
  }

  function parseOperation() {
    let operation = 'query';
    let name = null;
    const variables = [];
    const t = peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = eat().value;
      if (peek().kind === 'name') name = eat().value;
      if (peek().kind === 'punct' && peek().value === '(') {
        eat();
        while (!(peek().kind === 'punct' && peek().value === ')')) {
          variables.push(parseVariableDef());
        }
        eat();
      }
    } else if (t.kind === 'punct' && t.value === '{') {
      // Anonymous shorthand query
    } else {
      throw new ParseError(`expected operation or "{", got ${t.kind} "${t.value}"`, t.pos);
    }
    const selectionSet = parseSelectionSet();
    return { operation, name, variables, selectionSet };
  }

  function parseVariableDef() {
    const v = expect('var');
    expect('punct', ':');
    const type = parseType();
    let defaultValue = null;
    if (peek().kind === 'punct' && peek().value === '=') {
      eat();
      defaultValue = parseValue();
    }
    return { name: v.value, type, defaultValue };
  }

  function parseType() {
    let listOf = null;
    if (peek().kind === 'punct' && peek().value === '[') {
      eat();
      listOf = parseType();
      expect('punct', ']');
    }
    let base = listOf ? { kind: 'list', of: listOf } : { kind: 'named', name: expect('name').value };
    if (peek().kind === 'punct' && peek().value === '!') {
      eat();
      base = { kind: 'nonNull', of: base };
    }
    return base;
  }

  function parseSelectionSet() {
    expect('punct', '{');
    const selections = [];
    while (!(peek().kind === 'punct' && peek().value === '}')) {
      selections.push(parseField());
    }
    eat();
    return selections;
  }

  function parseField() {
    const nameTok = expect('name');
    const args = {};
    if (peek().kind === 'punct' && peek().value === '(') {
      eat();
      while (!(peek().kind === 'punct' && peek().value === ')')) {
        const k = expect('name').value;
        expect('punct', ':');
        args[k] = parseValue();
      }
      eat();
    }
    let selectionSet = null;
    if (peek().kind === 'punct' && peek().value === '{') {
      selectionSet = parseSelectionSet();
    }
    return { name: nameTok.value, args, selectionSet };
  }

  function parseValue() {
    const t = peek();
    if (t.kind === 'var') { eat(); return { kind: 'var', name: t.value }; }
    if (t.kind === 'string') { eat(); return { kind: 'string', value: t.value }; }
    if (t.kind === 'int') { eat(); return { kind: 'int', value: parseInt(t.value, 10) }; }
    if (t.kind === 'float') { eat(); return { kind: 'float', value: parseFloat(t.value) }; }
    if (t.kind === 'name') {
      eat();
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      eat();
      const items = [];
      while (!(peek().kind === 'punct' && peek().value === ']')) items.push(parseValue());
      eat();
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      eat();
      const fields = {};
      while (!(peek().kind === 'punct' && peek().value === '}')) {
        const k = expect('name').value;
        expect('punct', ':');
        fields[k] = parseValue();
      }
      eat();
      return { kind: 'object', fields };
    }
    throw new ParseError(`unexpected value token ${t.kind} "${t.value}"`, t.pos);
  }

  return parseDocument();
}

function resolveValue(node, variables) {
  if (!node) return undefined;
  switch (node.kind) {
    case 'var': return variables[node.name];
    case 'string': case 'int': case 'float': case 'bool': case 'enum':
      return node.value;
    case 'null': return null;
    case 'list': return node.items.map((n) => resolveValue(n, variables));
    case 'object': {
      const out = {};
      for (const k of Object.keys(node.fields)) out[k] = resolveValue(node.fields[k], variables);
      return out;
    }
    default: return undefined;
  }
}

module.exports = { parse, tokenize, resolveValue, ParseError };
