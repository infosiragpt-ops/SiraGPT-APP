'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfficeDraftHandler } = require('../src/services/document-editor/office-draft');
const { deliverDocumentEdit } = require('../src/services/document-editor/deliver-edit');

function response() {
  return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
}
function fixture(kind, initial) {
  const field = `${kind}Content`;
  let content = initial;
  let writes = 0;
  const prisma = { chat: {
    findFirst: async ({ where }) => where.userId === 'owner' && where.id === 'chat' ? { [field]: content } : null,
    updateMany: async ({ where, data }) => {
      assert.equal(where.userId, 'owner');
      const previous = kind === 'excel' ? where[field].equals : where[field];
      if (JSON.stringify(previous) !== JSON.stringify(content)) return { count: 0 };
      writes++; content = data[field]; return { count: 1 };
    },
  } };
  return {
    prisma, get content() { return content; }, get writes() { return writes; },
    async save(value, expected, user = 'owner') {
      const res = response();
      await createOfficeDraftHandler({ prisma, kind, dbNull: null })({ params: { id: 'chat' }, user: { id: user }, body: { content: value, expectedContent: expected } }, res);
      return res;
    },
  };
}
test('Word manual edits persist, allow clearing, and reject stale writes', async () => {
  const f = fixture('word', '<p>Original</p>');
  assert.equal((await f.save('<p>Cambio</p>', f.content)).statusCode, 200);
  assert.equal((await f.save('<p>Viejo</p>', '<p>Original</p>')).statusCode, 409);
  assert.equal(f.content, '<p>Cambio</p>');
  assert.equal((await f.save('', f.content)).statusCode, 200);
  assert.equal(f.content, '');
});
test('Excel retains formulas, styles, charts and sheets in full workbook state', async () => {
  const f = fixture('excel', null);
  const workbook = { sheets: [{ name: 'Ventas', rows: [{ cells: [{ formula: '=SUM(B1:C1)', style: { fontWeight: 'bold' }, chart: [{ type: 'Column' }] }] }] }, { name: 'Resumen' }] };
  assert.equal((await f.save(workbook, null)).statusCode, 200);
  assert.deepEqual(f.content, workbook);
  assert.equal((await f.save(workbook, null)).statusCode, 200);
  assert.equal(f.writes, 1);
  assert.equal((await f.save({ sheets: [] }, null, 'other-user')).statusCode, 404);
  assert.equal((await f.save({ values: [] }, workbook)).statusCode, 400);
});
test('database errors never report a saved document', async () => {
  const f = fixture('word', 'original');
  f.prisma.chat.updateMany = async () => { throw new Error('unavailable'); };
  assert.equal((await f.save('new', 'original')).statusCode, 500);
  assert.equal(f.content, 'original');
});
test('a delivered file with failed history persistence is recoverable but not successful', async () => {
  const files = [{ artifactId: 'abc', filename: 'doc.docx' }];
  const result = await deliverDocumentEdit({ result: { ok: true, summary: 'Listo' }, files, persist: async () => null, chatId: 'chat' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DOCUMENT_HISTORY_SAVE_FAILED');
  assert.deepEqual(result.files, files);
});
test('partial file edits stay partial after successful persistence', async () => {
  const files = [{ artifactId: 'abc' }];
  const event = await deliverDocumentEdit({ result: { ok: false, code: 'DOCUMENT_EDIT_INCOMPLETE', message: 'Solo un archivo' }, files, persist: async (_, saved) => { assert.deepEqual(saved, files); return 'message'; }, chatId: 'chat' });
  assert.equal(event.ok, false);
  assert.equal(event.partial, true);
  assert.equal(event.assistantMessageId, 'message');
});
