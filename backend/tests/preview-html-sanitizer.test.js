const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeCss,
  sanitizePreviewHtml,
} = require('../src/services/preview-html-sanitizer');

test('preview sanitizer removes executable tags and event handlers', () => {
  const html = sanitizePreviewHtml(`
    <style>@import url("https://bad.test/x.css"); .ok{color:red;background:url(javascript:alert(1))}</style>
    <script>alert(1)</script>
    <div onclick="alert(1)" style="background:url(javascript:alert(1))">Hola</div>
    <iframe srcdoc="<script>alert(1)</script>"></iframe>
  `);

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /srcdoc/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(/i);
  assert.match(html, /Hola/);
});

test('preview sanitizer blocks javascript links but keeps safe document links', () => {
  const html = sanitizePreviewHtml(`
    <a id="bad" href="javascript:alert(1)">bad</a>
    <a id="good" href="https://example.com">good</a>
    <img id="remote" src="https://example.com/a.png">
    <img id="inline" src="data:image/png;base64,AAAA">
  `);

  assert.match(html, /id="bad"/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /id="remote"/);
  assert.doesNotMatch(html, /src="https:\/\/example.com\/a.png"/);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
});

test('css sanitizer strips network and script execution surfaces', () => {
  const css = sanitizeCss(`
    @import "https://example.com/a.css";
    .a { background-image: url("https://example.com/a.png"); width: expression(alert(1)); }
    .b { color: red; }
  `);

  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /url\(/i);
  assert.doesNotMatch(css, /expression/i);
  assert.match(css, /color: red/);
});
