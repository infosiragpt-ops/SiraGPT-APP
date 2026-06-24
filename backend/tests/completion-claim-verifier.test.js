'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractClaims,
  verifyClaims,
  buildCorrectionInstruction,
  normalizeExecuted,
} = require('../src/services/agents/completion-claim-verifier');

test('detects first-person past-tense completion claims (ES)', () => {
  const kinds = (t) => extractClaims(t).map((c) => c.kind);
  assert.ok(kinds('Busqué en la web y encontré la cifra actual.').includes('web_research'));
  assert.ok(kinds('Creé el documento PDF con el resumen solicitado.').includes('file_created'));
  assert.ok(kinds('Ejecuté el código y todas las pruebas pasaron.').includes('code_executed'));
  assert.ok(kinds('Actualicé tu Word con los cambios pedidos.').includes('doc_edited'));
  assert.ok(kinds('Hice push a la rama main del repositorio.').includes('repo_modified'));
});

test('does NOT match offers / future / conditional phrasing', () => {
  const kinds = (t) => extractClaims(t).map((c) => c.kind);
  assert.deepEqual(kinds('Puedo crear un archivo PDF si lo necesitas.'), []);
  assert.deepEqual(kinds('Voy a buscar en internet la información.'), []);
  assert.deepEqual(kinds('Para ejecutar el código necesitarías Python.'), []);
  assert.deepEqual(kinds('Te recomiendo generar un documento con esto.'), []);
});

test('verifyClaims marks a claim supported only when a backing tool ran', () => {
  const text = 'Busqué en la web y creé el documento.';
  // web_search ran, but no document tool → file_created is unsupported.
  const res = verifyClaims(text, ['web_search']);
  assert.equal(res.ok, false);
  assert.equal(res.supported.length, 1);
  assert.equal(res.supported[0].kind, 'web_research');
  assert.equal(res.unsupported.length, 1);
  assert.equal(res.unsupported[0].kind, 'file_created');
  assert.equal(res.severity, 'high', 'an unbacked file_created is high severity');
});

test('verifyClaims is ok when every claim has evidence', () => {
  const res = verifyClaims('Busqué en la web y leí la fuente.', ['web_search', 'read_url']);
  assert.equal(res.ok, true);
  assert.equal(res.unsupported.length, 0);
  assert.equal(res.severity, 'none');
});

test('verifyClaims with no claims is trivially ok', () => {
  const res = verifyClaims('Aquí tienes una explicación del concepto.', []);
  assert.equal(res.ok, true);
  assert.equal(res.claims.length, 0);
  assert.equal(res.severity, 'none');
});

test('unbacked read-only claim is low severity, side-effecting is high', () => {
  assert.equal(verifyClaims('Busqué en la web la respuesta.', []).severity, 'low');
  assert.equal(verifyClaims('Ejecuté el código del proyecto.', []).severity, 'high');
  assert.equal(verifyClaims('Hice commit y push de los cambios.', []).severity, 'high');
});

test('buildCorrectionInstruction is empty when ok and actionable when not', () => {
  assert.equal(buildCorrectionInstruction(verifyClaims('Hola, ¿cómo estás?', [])), '');
  const msg = buildCorrectionInstruction(verifyClaims('Creé el archivo Excel.', []));
  assert.match(msg, /HONESTY CHECK FAILED/);
  assert.match(msg, /file_created/);
});

test('normalizeExecuted accepts arrays of strings, tool objects, and Sets', () => {
  assert.ok(normalizeExecuted(['a', 'b']).has('a'));
  assert.ok(normalizeExecuted([{ name: 'web_search' }, { name: 'read_url' }]).has('web_search'));
  const s = new Set(['x']);
  assert.equal(normalizeExecuted(s), s);
  assert.equal(normalizeExecuted(null).size, 0);
});

test('English claims are detected too', () => {
  assert.ok(extractClaims('I searched the web for current data.').some((c) => c.kind === 'web_research'));
  assert.ok(extractClaims('I created the report document for you.').some((c) => c.kind === 'file_created'));
  assert.ok(extractClaims('I ran the tests and they passed.').some((c) => c.kind === 'code_executed'));
});
