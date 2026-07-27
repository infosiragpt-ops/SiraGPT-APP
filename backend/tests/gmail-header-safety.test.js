'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { safeMailHeader } = require('../src/services/gmail');
const sales = require('../src/services/codex/company-operations/sales-pipeline');

test('mail headers reject CRLF injection', () => {
  assert.equal(safeMailHeader('ventas@example.com', 'recipient'), 'ventas@example.com');
  assert.throws(
    () => safeMailHeader('ventas@example.com\r\nBcc: victim@example.com', 'recipient'),
    /Invalid recipient/,
  );
  assert.throws(
    () => safeMailHeader('Asunto\nX-Header: injected', 'subject'),
    /Invalid subject/,
  );
});

test('sales drafts reject invalid recipients and model-generated header injection', () => {
  assert.equal(sales.validEmail('ventas@example.com'), 'ventas@example.com');
  assert.equal(sales.validEmail('ventas@example.com\nBcc:x@example.com'), null);
  assert.equal(sales.safeSubject('Asunto seguro'), 'Asunto seguro');
  assert.equal(sales.safeSubject('Asunto\r\nBcc: x@example.com'), '');
});
