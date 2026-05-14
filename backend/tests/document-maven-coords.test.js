'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-maven-coords');
const { extractMavenCoords, buildMavenCoordsForFiles, renderMavenCoordsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractMavenCoords('').total, 0);
  assert.equal(extractMavenCoords(null).total, 0);
});

test('detects bare GAV string', () => {
  const r = extractMavenCoords('Add org.springframework:spring-core:5.3.20 to classpath');
  assert.ok(r.entries.some((e) => e.kind === 'gav'));
});

test('detects pom.xml dependency', () => {
  const r = extractMavenCoords('<groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.15.2</version>');
  assert.ok(r.entries.some((e) => e.kind === 'pom'));
});

test('detects Gradle string-style dependency', () => {
  const r = extractMavenCoords("implementation 'org.apache.commons:commons-lang3:3.12.0'");
  assert.ok(r.entries.some((e) => e.kind === 'gradle'));
});

test('detects Gradle map-style dependency', () => {
  const r = extractMavenCoords("group: 'org.example', name: 'lib', version: '1.0.0'");
  assert.ok(r.entries.some((e) => e.kind === 'gradle'));
});

test('detects Maven Central URL', () => {
  const r = extractMavenCoords('https://repo1.maven.org/maven2/org/example/lib/1.0.0/lib-1.0.0.jar');
  assert.ok(r.entries.some((e) => e.kind === 'mavenUrl'));
});

test('extracts groupId/artifactId/version', () => {
  const r = extractMavenCoords('org.springframework:spring-core:5.3.20');
  const entry = r.entries.find((e) => e.kind === 'gav');
  assert.ok(entry);
  assert.equal(entry.artifactId, 'spring-core');
  assert.equal(entry.version, '5.3.20');
});

test('dedupes identical GAVs', () => {
  const r = extractMavenCoords('org.x:lib:1.0 and org.x:lib:1.0');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `org.example:lib-${i}:1.${i}.0 `;
  const r = extractMavenCoords(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractMavenCoords(`
    <groupId>org.a</groupId><artifactId>x</artifactId><version>1.0</version>
    implementation 'org.b:y:2.0'
    org.c:z:3.0
  `);
  assert.ok(r.totals.pom >= 1);
  assert.ok(r.totals.gradle >= 1);
});

test('buildMavenCoordsForFiles aggregates across batch', () => {
  const files = [
    { name: 'pom.xml', extractedText: '<groupId>x</groupId><artifactId>y</artifactId><version>1</version>' },
    { name: 'build.gradle', extractedText: "implementation 'org.a:b:1.0'" },
  ];
  const r = buildMavenCoordsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMavenCoordsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'pom.xml', extractedText: 'org.x:lib:1.0' }];
  const r = buildMavenCoordsForFiles(files);
  const md = renderMavenCoordsBlock(r);
  assert.match(md, /^## MAVEN/);
});

test('renderMavenCoordsBlock empty when nothing surfaces', () => {
  assert.equal(renderMavenCoordsBlock({ perFile: [] }), '');
  assert.equal(renderMavenCoordsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMavenCoordsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'org.x:lib:1.0' },
  ]);
  assert.equal(r.perFile.length, 1);
});
