'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-permissions-api');
const { extractPermissionsApi, buildPermissionsApiForFiles, renderPermissionsApiBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPermissionsApi('').total, 0);
  assert.equal(extractPermissionsApi(null).total, 0);
});

test('detects navigator.permissions.query', () => {
  const r = extractPermissionsApi("navigator.permissions.query({name: 'geolocation'})");
  assert.ok(r.entries.some((e) => e.name === 'permissions-query'));
});

test('detects getUserMedia', () => {
  const r = extractPermissionsApi('navigator.mediaDevices.getUserMedia({video: true})');
  assert.ok(r.entries.some((e) => e.name === 'getUserMedia'));
});

test('detects enumerateDevices', () => {
  const r = extractPermissionsApi('navigator.mediaDevices.enumerateDevices()');
  assert.ok(r.entries.some((e) => e.category === 'media'));
});

test('detects geolocation', () => {
  const r = extractPermissionsApi('navigator.geolocation.getCurrentPosition(cb)');
  assert.ok(r.entries.some((e) => e.category === 'location'));
});

test('detects Notification.requestPermission', () => {
  const r = extractPermissionsApi('Notification.requestPermission()');
  assert.ok(r.entries.some((e) => e.category === 'notification'));
});

test('detects clipboard readText', () => {
  const r = extractPermissionsApi('navigator.clipboard.readText()');
  assert.ok(r.entries.some((e) => e.category === 'clipboard'));
});

test('detects bluetooth.requestDevice', () => {
  const r = extractPermissionsApi('navigator.bluetooth.requestDevice({filters: []})');
  assert.ok(r.entries.some((e) => e.category === 'device'));
});

test('detects USB requestDevice', () => {
  const r = extractPermissionsApi('navigator.usb.requestDevice({filters: []})');
  assert.ok(r.entries.some((e) => e.name === 'usb'));
});

test('detects wakeLock', () => {
  const r = extractPermissionsApi('navigator.wakeLock.request("screen")');
  assert.ok(r.entries.some((e) => e.category === 'power'));
});

test('detects Web Share', () => {
  const r = extractPermissionsApi('navigator.share({title: "x"})');
  assert.ok(r.entries.some((e) => e.category === 'sharing'));
});

test('detects fullscreen', () => {
  const r = extractPermissionsApi('document.requestFullscreen()');
  assert.ok(r.entries.some((e) => e.category === 'display'));
});

test('detects indexedDB.open', () => {
  const r = extractPermissionsApi('indexedDB.open("mydb", 1)');
  assert.ok(r.entries.some((e) => e.category === 'storage'));
});

test('detects Cache API', () => {
  const r = extractPermissionsApi('caches.open("v1").then(c => c.match(req))');
  assert.ok(r.entries.some((e) => e.category === 'storage'));
});

test('dedupes identical entries', () => {
  const r = extractPermissionsApi('navigator.share({}) and navigator.share({})');
  assert.equal(r.entries.filter((e) => e.name === 'web-share').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `navigator.permissions.query({name: 'p${i}'}) `;
  const r = extractPermissionsApi(text);
  assert.ok(r.entries.length <= 18);
});

test('buildPermissionsApiForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.js', extractedText: 'navigator.share({})' },
    { name: 'b.js', extractedText: 'indexedDB.open("x")' },
  ];
  const r = buildPermissionsApiForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPermissionsApiBlock returns markdown when entries exist', () => {
  const files = [{ name: 'app.js', extractedText: 'navigator.share({})' }];
  const r = buildPermissionsApiForFiles(files);
  const md = renderPermissionsApiBlock(r);
  assert.match(md, /^## BROWSER PERMISSIONS/);
});

test('renderPermissionsApiBlock empty when nothing surfaces', () => {
  assert.equal(renderPermissionsApiBlock({ perFile: [] }), '');
  assert.equal(renderPermissionsApiBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPermissionsApiForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'navigator.share({})' },
  ]);
  assert.equal(r.perFile.length, 1);
});
