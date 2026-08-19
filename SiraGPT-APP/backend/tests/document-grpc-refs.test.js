'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-grpc-refs');
const { extractGrpcRefs, buildGrpcRefsForFiles, renderGrpcRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractGrpcRefs('').total, 0);
  assert.equal(extractGrpcRefs(null).total, 0);
});

test('detects package declaration', () => {
  const r = extractGrpcRefs('package foo.bar.v1;');
  assert.ok(r.entries.some((e) => e.kind === 'package' && e.name === 'foo.bar.v1'));
});

test('detects service declaration', () => {
  const r = extractGrpcRefs('service UserService { rpc GetUser(...) returns (User); }');
  assert.ok(r.entries.some((e) => e.kind === 'service' && e.name === 'UserService'));
});

test('detects rpc method with types', () => {
  const r = extractGrpcRefs('rpc GetUser (GetUserRequest) returns (User) {}');
  const entry = r.entries.find((e) => e.kind === 'rpc' && e.name === 'GetUser');
  assert.ok(entry);
  assert.equal(entry.request, 'GetUserRequest');
  assert.equal(entry.response, 'User');
});

test('detects streaming rpc', () => {
  const r = extractGrpcRefs('rpc StreamUsers (StreamReq) returns (stream User);');
  assert.ok(r.entries.some((e) => e.kind === 'rpc' && e.name === 'StreamUsers'));
});

test('detects wire path /pkg.Service/Method', () => {
  const r = extractGrpcRefs('Invoking /foo.bar.v1.UserService/GetUser via gRPC');
  assert.ok(r.entries.some((e) => e.kind === 'wire' && e.method === 'GetUser'));
});

test('extracts wire package + service + method', () => {
  const r = extractGrpcRefs('Hit /foo.bar.UserService/CreateUser');
  const entry = r.entries.find((e) => e.kind === 'wire');
  assert.ok(entry);
  assert.equal(entry.service, 'UserService');
  assert.equal(entry.method, 'CreateUser');
});

test('detects multiple services in one .proto', () => {
  const r = extractGrpcRefs(`
    service UserService { rpc GetUser(R) returns (User); }
    service PostService { rpc GetPost(R) returns (Post); }
  `);
  assert.ok(r.entries.filter((e) => e.kind === 'service').length >= 2);
});

test('dedupes identical entries', () => {
  const r = extractGrpcRefs('service UserService { } and service UserService { } again');
  assert.equal(r.entries.filter((e) => e.kind === 'service' && e.name === 'UserService').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `service Service${i} { }\n`;
  const r = extractGrpcRefs(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractGrpcRefs(`
    package foo.v1;
    service UserSvc { rpc GetX(Req) returns (Resp); }
    /foo.v1.UserSvc/GetX
  `);
  assert.ok(r.totals.package >= 1);
  assert.ok(r.totals.service >= 1);
  assert.ok(r.totals.rpc >= 1);
  assert.ok(r.totals.wire >= 1);
});

test('buildGrpcRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.proto', extractedText: 'service UserService { }' },
    { name: 'b.proto', extractedText: 'service PostService { }' },
  ];
  const r = buildGrpcRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGrpcRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'a.proto', extractedText: 'service UserService { }' }];
  const r = buildGrpcRefsForFiles(files);
  const md = renderGrpcRefsBlock(r);
  assert.match(md, /^## gRPC/);
});

test('renderGrpcRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderGrpcRefsBlock({ perFile: [] }), '');
  assert.equal(renderGrpcRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGrpcRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'service UserService { }' },
  ]);
  assert.equal(r.perFile.length, 1);
});
