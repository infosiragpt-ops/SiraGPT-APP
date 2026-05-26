'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const chatExport = require('../src/services/chat-export');

const sampleChat = {
  id: 'chat-1',
  title: 'My Chat / About AI!',
  model: 'gpt-4o',
  createdAt: new Date('2026-05-19T10:00:00Z'),
  updatedAt: new Date('2026-05-19T11:00:00Z'),
  isArchived: false,
  messages: [
    { id: 'm1', role: 'USER', content: 'Hello assistant', timestamp: new Date('2026-05-19T10:00:01Z') },
    { id: 'm2', role: 'ASSISTANT', content: 'Hi! Here is code:\n```js\nconst x = 1;\n```', timestamp: new Date('2026-05-19T10:00:05Z') },
  ],
};

describe('chat-export · markdown', () => {
  test('renders title + role headers + timestamps', () => {
    const md = chatExport.buildMarkdown(sampleChat);
    assert.match(md, /^# My Chat \/ About AI!$/m);
    assert.match(md, /## User — 2026-05-19T10:00:01\.000Z/);
    assert.match(md, /## Assistant — 2026-05-19T10:00:05\.000Z/);
    assert.match(md, /```js\nconst x = 1;\n```/);
  });

  test('handles empty / missing fields without throwing', () => {
    const md = chatExport.buildMarkdown({});
    assert.match(md, /Untitled chat/);
  });
});

describe('chat-export · html', () => {
  test('escapes HTML metacharacters', () => {
    const evil = { title: '<script>alert(1)</script>', messages: [{ role: 'USER', content: '"&<>' }] };
    const html = chatExport.buildHtml(evil);
    assert.ok(!html.includes('<script>alert(1)'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot;&amp;&lt;&gt;/);
  });

  test('preserves fenced code blocks as <pre><code>', () => {
    const html = chatExport.buildHtml(sampleChat);
    assert.match(html, /<pre><code class="lang-js">const x = 1;<\/code><\/pre>/);
  });
});

describe('chat-export · json', () => {
  test('is parseable and contains all messages', () => {
    const json = chatExport.buildJson(sampleChat);
    const parsed = JSON.parse(json);
    assert.equal(parsed.title, sampleChat.title);
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0].role, 'USER');
  });
});

describe('chat-export · pdf', () => {
  test('returns a readable pdfkit doc', async () => {
    const doc = chatExport.buildPdfStream(sampleChat);
    const chunks = [];
    for await (const chunk of doc) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    // PDF files start with "%PDF-"
    assert.equal(buf.slice(0, 5).toString('ascii'), '%PDF-');
    assert.ok(buf.length > 200);
  });
});

describe('chat-export · helpers', () => {
  test('contentTypeFor maps each format', () => {
    assert.equal(chatExport.contentTypeFor('md'), 'text/markdown; charset=utf-8');
    assert.equal(chatExport.contentTypeFor('html'), 'text/html; charset=utf-8');
    assert.equal(chatExport.contentTypeFor('json'), 'application/json; charset=utf-8');
    assert.equal(chatExport.contentTypeFor('pdf'), 'application/pdf');
    assert.equal(chatExport.contentTypeFor('bogus'), 'application/octet-stream');
  });

  test('filenameFor slugifies title safely', () => {
    assert.equal(chatExport.filenameFor({ title: 'My Chat / About AI!' }, 'md'), 'my-chat-about-ai.md');
    assert.equal(chatExport.filenameFor({}, 'pdf'), 'chat.pdf');
  });

  test('FORMATS is the canonical list', () => {
    assert.deepEqual(chatExport.FORMATS, ['md', 'html', 'pdf', 'json']);
  });
});
