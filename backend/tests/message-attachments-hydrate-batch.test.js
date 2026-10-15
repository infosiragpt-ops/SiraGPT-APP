'use strict';

// GET /api/chats/:id hydrates incomplete `message.files` snapshots (bare ids
// from addMessage / doc-sandbox, id-only stubs) from the File table. It must
// resolve the whole chat with one owner-scoped query, not one per message.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hydrateChatMessageAttachments,
  serializeMessageAttachments,
} = require('../src/services/message-attachments');
const { MAX_SIMULTANEOUS_DOCUMENTS } = require('../src/config/document-batch-limits');

function fileRow(id, userId = 'u', extra = {}) {
  return {
    id,
    userId,
    filename: `${id}.pdf`,
    originalName: `Doc ${id}.pdf`,
    mimeType: 'application/pdf',
    size: 10,
    path: `r2:uploads/${userId}/${id}.pdf`,
    extractedText: `texto ${id}`,
    openaiFileId: null,
    ...extra,
  };
}

function fakePrisma(rows, { fail = false } = {}) {
  const calls = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    calls,
    file: {
      async findMany(args) {
        calls.push(args);
        if (fail) throw new Error('db down');
        // Return in reverse order: the hydrator must not depend on DB order.
        return args.where.id.in
          .map((id) => byId.get(id))
          .filter((row) => row && row.userId === args.where.userId)
          .reverse();
      },
    },
  };
}

function longChat() {
  const rows = [];
  const messages = [];
  for (let i = 0; i < 100; i += 1) {
    const id = `f${i}`;
    rows.push(fileRow(id));
    let files = null;
    if (i % 4 === 0) files = [id];                                       // bare id
    else if (i % 4 === 1) files = [{ id, name: `Doc ${id}.pdf` }];       // id-only stub
    else if (i % 4 === 2) files = [{ id, name: 'x', path: `r2:uploads/u/${id}.pdf` }]; // durable
    messages.push({ id: `mu${i}`, role: 'USER', content: `q${i}`, files });
    messages.push({ id: `ma${i}`, role: 'ASSISTANT', content: `a${i}`, files: null });
  }
  return { rows, messages };
}

test('a 200-message chat hydrates with ONE owner-scoped File query', async () => {
  const { rows, messages } = longChat();
  const prisma = fakePrisma(rows);
  const out = await hydrateChatMessageAttachments(prisma, { userId: 'u', messages });
  assert.equal(prisma.calls.length, 1, `expected 1 findMany, got ${prisma.calls.length}`);
  assert.equal(prisma.calls[0].where.userId, 'u');
  assert.equal(prisma.calls[0].where.id.in.length, 50);
  assert.equal(out.length, 200);
  for (let i = 0; i < 100; i += 1) {
    const user = out[i * 2];
    if (i % 4 === 0 || i % 4 === 1) assert.equal(user.files[0].url, `/uploads/u/f${i}.pdf`);
    else assert.equal(user, messages[i * 2], 'messages that need no hydration keep identity');
  }
});

test('hydration reads only snapshot columns (no documentAnalysis/chunks/tables)', async () => {
  const prisma = fakePrisma([fileRow('f1')]);
  await hydrateChatMessageAttachments(prisma, { userId: 'u', messages: [{ id: 'm', files: ['f1'] }] });
  assert.equal(prisma.calls.length, 1);
  const { select, include } = prisma.calls[0];
  assert.equal(include, undefined);
  assert.deepEqual(Object.keys(select).sort(),
    ['extractedText', 'filename', 'id', 'mimeType', 'openaiFileId', 'originalName', 'size']);
});

test('ids shared across messages are queried once; large unions chunk by the document cap', async () => {
  const rows = Array.from({ length: 1800 }, (_, i) => fileRow(`f${i}`));
  const ids = rows.map((row) => row.id);
  const messages = [
    { id: 'm1', files: ids.slice(0, 600) },
    { id: 'm2', files: ids.slice(600, 1200) },
    { id: 'm3', files: ids.slice(1200, 1800) },
    { id: 'm4', files: ids.slice(0, 3) },
  ];
  const prisma = fakePrisma(rows);
  const out = await hydrateChatMessageAttachments(prisma, { userId: 'u', messages });
  assert.equal(
    prisma.calls.length,
    Math.ceil(1800 / MAX_SIMULTANEOUS_DOCUMENTS),
    'one query per document-cap chunk, not one per message',
  );
  const queried = prisma.calls.flatMap((call) => call.where.id.in);
  assert.equal(queried.length, 1800);
  assert.equal(new Set(queried).size, 1800);
  assert.deepEqual(out[0].files.map((f) => f.id), ids.slice(0, 600));
  assert.deepEqual(out[3].files.map((f) => f.url), ids.slice(0, 3).map((id) => `/uploads/u/${id}.pdf`));
});

test('order, ownership and fail-open are preserved', async () => {
  const rows = [fileRow('a'), fileRow('b'), fileRow('theirs', 'other')];
  const messages = [
    { id: 'm1', files: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }] },
    { id: 'm2', files: JSON.stringify(['theirs']) },
    { id: 'm3', files: [{ id: 'a', url: '/uploads/u/a.pdf' }] },
    null,
  ];
  const out = await hydrateChatMessageAttachments(fakePrisma(rows), { userId: 'u', messages });
  assert.deepEqual(out[0].files.map((f) => f.id), ['b', 'a']);
  assert.equal(out[0].files[0].url, '/uploads/u/b.pdf');
  assert.equal(out[1].files[0].url, null, "another user's file never resolves");
  assert.equal(out[1].files[0].name, 'Archivo 1');
  assert.equal(out[2], messages[2]);
  assert.equal(out[3], null);

  const down = await hydrateChatMessageAttachments(fakePrisma(rows, { fail: true }), { userId: 'u', messages });
  assert.equal(down[0].files[0].name, 'B');
  assert.equal(down[0].files[0].url, null);
});

test('serializeMessageAttachments (agent-task persistence) uses the slim select too', async () => {
  const prisma = fakePrisma([fileRow('f1')]);
  const files = await serializeMessageAttachments(prisma, { userId: 'u', fileIds: ['f1'] });
  assert.equal(files[0].url, '/uploads/u/f1.pdf');
  assert.equal(prisma.calls[0].select.documentAnalysis, undefined);
});
