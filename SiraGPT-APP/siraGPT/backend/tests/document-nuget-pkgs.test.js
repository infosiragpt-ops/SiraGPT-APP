'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-nuget-pkgs');
const { extractNugetPkgs, buildNugetPkgsForFiles, renderNugetPkgsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractNugetPkgs('').total, 0);
  assert.equal(extractNugetPkgs(null).total, 0);
});

test('detects PackageReference', () => {
  const r = extractNugetPkgs('<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />');
  assert.ok(r.entries.some((e) => e.name === 'Newtonsoft.Json'));
});

test('detects packages.config legacy', () => {
  const r = extractNugetPkgs('<package id="EntityFramework" version="6.4.4" />');
  assert.ok(r.entries.some((e) => e.kind === 'packagesConfig'));
});

test('detects dotnet add package command', () => {
  const r = extractNugetPkgs('dotnet add package Serilog -v 3.1.1');
  assert.ok(r.entries.some((e) => e.kind === 'command'));
});

test('detects dotnet add package without version', () => {
  const r = extractNugetPkgs('dotnet add package AutoMapper');
  assert.ok(r.entries.some((e) => e.kind === 'command'));
});

test('detects paket dependency', () => {
  const r = extractNugetPkgs('nuget FSharp.Core 7.0.0');
  assert.ok(r.entries.some((e) => e.kind === 'paket'));
});

test('captures version', () => {
  const r = extractNugetPkgs('<PackageReference Include="Foo" Version="1.2.3" />');
  assert.equal(r.entries[0].version, '1.2.3');
});

test('dedupes identical entries', () => {
  const r = extractNugetPkgs('<PackageReference Include="X" Version="1.0" />\n<PackageReference Include="X" Version="1.0" />');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `<PackageReference Include="Pkg${i}" Version="1.${i}" />\n`;
  const r = extractNugetPkgs(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractNugetPkgs(`
    <PackageReference Include="A" Version="1.0" />
    <package id="B" version="2.0" />
    dotnet add package C
  `);
  assert.ok(r.totals.packageRef >= 1);
  assert.ok(r.totals.packagesConfig >= 1);
  assert.ok(r.totals.command >= 1);
});

test('buildNugetPkgsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.csproj', extractedText: '<PackageReference Include="A" Version="1.0" />' },
    { name: 'b.csproj', extractedText: '<PackageReference Include="B" Version="2.0" />' },
  ];
  const r = buildNugetPkgsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderNugetPkgsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'app.csproj', extractedText: '<PackageReference Include="X" Version="1.0" />' }];
  const r = buildNugetPkgsForFiles(files);
  const md = renderNugetPkgsBlock(r);
  assert.match(md, /^## .NET/);
});

test('renderNugetPkgsBlock empty when nothing surfaces', () => {
  assert.equal(renderNugetPkgsBlock({ perFile: [] }), '');
  assert.equal(renderNugetPkgsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildNugetPkgsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '<PackageReference Include="X" Version="1.0" />' },
  ]);
  assert.equal(r.perFile.length, 1);
});
