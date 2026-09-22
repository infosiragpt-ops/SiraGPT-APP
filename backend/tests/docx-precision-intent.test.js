'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDocxPrecisionRequest: parse } = require('../src/services/document-editing/docx-precision-intent');

test('one-character and empty replacements are literal; punctuation, accents and spaces survive', () => {
  assert.deepEqual(parse('Cambia "a" por "á".'), { edit: { needle: 'a', replacement: 'á' } });
  assert.deepEqual(parse('Reemplaza « A  & B » por « » sin cambiar el formato.'), { edit: { needle: ' A  & B ', replacement: ' ' } });
  assert.deepEqual(parse('Sustituye “x” por “”'), { edit: { needle: 'x', replacement: '' } });
  assert.deepEqual(parse('Change "Résumé" to "RESUME"'), { edit: { needle: 'Résumé', replacement: 'RESUME' } });
});

test('quoted content cannot leak instructions into location or all selectors', () => {
  const needle = 'Título de la página';
  const replacement = 'cambia todas las coincidencias en el encabezado';
  assert.deepEqual(parse(`Cambia "${needle}" por "${replacement}"`), { edit: { needle, replacement } });
});

test('finds exact context before or after the replacement, not the first quoted pair', () => {
  assert.deepEqual(parse('En el párrafo que contiene "Casa azul", cambia "a" por "á" en la segunda coincidencia.'), {
    edit: { needle: 'a', replacement: 'á', context: 'Casa azul', occurrence: 2 },
  });
  assert.deepEqual(parse('Cambia "a" por "á" en el párrafo que comienza con "  Casa azul".'), {
    edit: { needle: 'a', replacement: 'á', context: '  Casa azul', contextPosition: 'start' },
  });
});

test('supports paragraph, occurrence, all, and Word story selectors', () => {
  assert.deepEqual(parse('En el párrafo 12 cambia "1" por "2"'), { edit: { needle: '1', replacement: '2', paragraph: 12 } });
  assert.deepEqual(parse('En el tercer párrafo del cuerpo cambia "1" por "2"'), { edit: { needle: '1', replacement: '2', paragraph: 3, scope: 'body' } });
  for (const [word, scope] of [['encabezado', 'header'], ['pie de página', 'footer'], ['notas al pie', 'footnote'], ['notas finales', 'endnote']]) {
    assert.deepEqual(parse(`Cambia "A" por "B" en el ${word}`), { edit: { needle: 'A', replacement: 'B', scope } });
  }
  assert.deepEqual(parse('Reemplaza "a" por "á" en todas las coincidencias'), { edit: { needle: 'a', replacement: 'á', all: true } });
});

test('a source filename is not a location selector', () => {
  assert.deepEqual(parse('En "Mi tabla.docx", cambia "x" por "y".'), { edit: { needle: 'x', replacement: 'y' }, sourceFilename: 'Mi tabla.docx' });
  assert.deepEqual(parse('Cambia "x" por "y" en informe.docx'), { edit: { needle: 'x', replacement: 'y' }, sourceFilename: 'informe.docx' });
  assert.deepEqual(parse('Cambia "original.docx" por "final.docx"'), { edit: { needle: 'original.docx', replacement: 'final.docx' } });
  assert.equal(parse('Cambia "a" por "b" en archivo.docx y segundo.docx').error.code, 'DOCX_EDIT_SOURCE_AMBIGUOUS');
});

test('unsupported or contradictory scopes fail closed instead of silently dropping the location', () => {
  for (const prompt of [
    'Cambia "a" por "á" en la página 2',
    'Cambia "a" por "á" en el título',
    'Cambia "a" por "á" en la tabla 2',
    'Cambia "a" por "á" en el párrafo 1 y 2',
    'Cambia "a" por "á" en el párrafo 0',
    'Cambia "a" por "á" en la última coincidencia',
    'Cambia "a" por "á" en todas las coincidencias excepto la primera',
    'Cambia "a" por "á" en todas las coincidencias y en la primera coincidencia',
    'Cambia "a" por "á" en el encabezado y pie de página',
    'Cambia "a" por "á" en el párrafo que contiene ""',
  ]) assert.match(parse(prompt)?.error?.code || '', /^DOCX_EDIT_/, prompt);
});

test('never partially executes a composite replacement or extra action', () => {
  for (const prompt of [
    'Cambia "a" por "á" y reemplaza "e" por "é"',
    'Cambia "a" por "á" y agrega una conclusión',
    'Cambia "a" por "á" y borra el resto',
    'Cambia "a" por "á" y revisa la ortografía',
    'No cambia "a" por "á"',
    'Cambia "" por "a"',
    'Cambia "a" por "b" en "otro lugar"',
  ]) assert.match(parse(prompt)?.error?.code || '', /^DOCX_EDIT_/, prompt);
});

test('nonliteral requests keep their existing flow unless exact preservation was requested', () => {
  for (const prompt of ['Agrega una conclusión', 'Cambia el título', 'Reemplaza BORRADOR por FINAL', 'Explica cómo cambia "a" por "b"'])
    assert.equal(parse(prompt), null, prompt);
  assert.equal(parse('Edita el documento sin cambiar el formato').error.code, 'DOCX_EDIT_INSTRUCTION_REQUIRED');
  assert.equal(parse('Cambia la letra a por b').error.code, 'DOCX_EDIT_INSTRUCTION_REQUIRED');
});

test('unknown location qualifiers, negations and conditional edits cannot be silently ignored', () => {
  for (const prompt of [
    'Cambia "a" por "b" en las páginas 2 y 3',
    'Cambia "a" por "b" en los párrafos 2 y 3',
    'Cambia "a" por "b" en el párrafo dos',
    'Cambia "a" por "b" solo en la segunda línea',
    'Cambia "a" por "b" entre los caracteres 6 y 9',
    'Cambia "a" por "b" en el segundo encabezado',
    'Change "a" to "b" in paragraph 5',
    'No quiero que cambies "a" por "b"',
    'Cambia "a" por "b" en el párrafo 2, pero no en el cuerpo',
    'Cambia "a" por "b", luego ponlo en negrita',
    'Cambia "a" por "b" si el documento no tiene errores',
  ]) assert.match(parse(prompt)?.error?.code || '', /^DOCX_EDIT_/, prompt);
});
