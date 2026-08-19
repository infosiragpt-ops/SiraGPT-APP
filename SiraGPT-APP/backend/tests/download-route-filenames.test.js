const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('download route filenames', () => {
  let auth;
  let app;
  let originalMessageFindFirst;
  let messageContent = 'plain exported content';

  before(() => {
    auth = installAuthSessionMock();
    originalMessageFindFirst = prisma.message.findFirst;
    prisma.message.findFirst = async () => ({
      id: 'message-1',
      content: messageContent,
      chat: { userId: auth.user.id },
    });
    app = buildRouteTestApp('/api/download', reloadModule('../src/routes/download'));
  });

  after(() => {
    prisma.message.findFirst = originalMessageFindFirst;
    auth.restore();
  });

  test('sanitizes text export filenames before setting Content-Disposition', async () => {
    const res = await request(app)
      .post('/api/download/text')
      .set('Authorization', auth.authHeader)
      .send({
        messageId: 'message-1',
        filename: '../Quarterly Report\r\nbad.csv',
      })
      .expect(200);

    assert.equal(res.headers['content-disposition'], 'attachment; filename="Quarterly-Reportbad.txt"');
    assert.equal(res.text, 'plain exported content');
  });

  test('quotes CSV headers and neutralizes spreadsheet formulas', async () => {
    messageContent = [
      '| Name, full | Value |',
      '| --- | --- |',
      '| Alice | =IMPORTXML("https://example.invalid") |',
      '| Bob | +SUM(1,2) |',
    ].join('\n');

    const res = await request(app)
      .post('/api/download/csv')
      .set('Authorization', auth.authHeader)
      .send({ messageId: 'message-1', filename: 'report.csv' })
      .expect(200);

    assert.equal(res.headers['content-disposition'], 'attachment; filename="report.csv"');
    assert.match(res.text, /^"Name, full","Value"/);
    assert.match(res.text, /"Alice","'=IMPORTXML\(""https:\/\/example\.invalid""\)"/);
    assert.match(res.text, /"Bob","'\+SUM\(1,2\)"/);
  });
});
