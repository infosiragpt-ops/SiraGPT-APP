'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-linux-distros');
const { extractLinuxDistros, buildLinuxDistrosForFiles, renderLinuxDistrosBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractLinuxDistros('').total, 0);
  assert.equal(extractLinuxDistros(null).total, 0);
});

test('detects Ubuntu 22.04', () => {
  const r = extractLinuxDistros('Built on Ubuntu 22.04 LTS');
  assert.ok(r.entries.some((e) => e.distro === 'Ubuntu' && e.version === '22.04'));
});

test('detects Ubuntu codename (jammy)', () => {
  const r = extractLinuxDistros('Ubuntu jammy base image');
  assert.ok(r.entries.some((e) => e.distro === 'Ubuntu'));
});

test('detects Debian 12', () => {
  const r = extractLinuxDistros('Running on Debian 12');
  assert.ok(r.entries.some((e) => e.distro === 'Debian' && e.version === '12'));
});

test('detects Debian codename (bookworm)', () => {
  const r = extractLinuxDistros('Debian bookworm release');
  assert.ok(r.entries.some((e) => e.distro === 'Debian'));
});

test('detects Alpine 3.19', () => {
  const r = extractLinuxDistros('FROM alpine:3.19 ... Alpine 3.19 image');
  assert.ok(r.entries.some((e) => e.distro === 'Alpine'));
});

test('detects RHEL 9', () => {
  const r = extractLinuxDistros('Deployed to RHEL 9 fleet');
  assert.ok(r.entries.some((e) => e.distro === 'RHEL' && e.version === '9'));
});

test('detects Rocky Linux 9', () => {
  const r = extractLinuxDistros('Rocky Linux 9 hosts');
  assert.ok(r.entries.some((e) => e.distro === 'Rocky'));
});

test('detects AlmaLinux 9', () => {
  const r = extractLinuxDistros('AlmaLinux 9 alternative');
  assert.ok(r.entries.some((e) => e.distro === 'AlmaLinux'));
});

test('detects Fedora 39', () => {
  const r = extractLinuxDistros('Fedora 39 workstation');
  assert.ok(r.entries.some((e) => e.distro === 'Fedora'));
});

test('detects openSUSE', () => {
  const r = extractLinuxDistros('openSUSE Leap 15.5 production');
  assert.ok(r.entries.some((e) => e.distro === 'openSUSE'));
});

test('detects Amazon Linux AL2023', () => {
  const r = extractLinuxDistros('Using AL2023 AMIs');
  assert.ok(r.entries.some((e) => e.distro === 'Amazon Linux'));
});

test('detects Arch Linux', () => {
  const r = extractLinuxDistros('Daily driver: Arch Linux');
  assert.ok(r.entries.some((e) => e.distro === 'Arch'));
});

test('dedupes identical entries', () => {
  const r = extractLinuxDistros('Ubuntu 22.04 here and Ubuntu 22.04 again');
  assert.equal(r.entries.filter((e) => e.distro === 'Ubuntu' && e.version === '22.04').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `Ubuntu ${20 + i}.04 `;
  const r = extractLinuxDistros(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by distro', () => {
  const r = extractLinuxDistros('Ubuntu 22.04, Debian 12, Alpine 3.19, RHEL 9');
  assert.equal(r.totals.Ubuntu, 1);
  assert.equal(r.totals.Debian, 1);
});

test('buildLinuxDistrosForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.dockerfile', extractedText: 'FROM ubuntu:22.04 ... Ubuntu 22.04' },
    { name: 'b.dockerfile', extractedText: 'FROM alpine:3.19 ... Alpine 3.19' },
  ];
  const r = buildLinuxDistrosForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderLinuxDistrosBlock returns markdown when entries exist', () => {
  const files = [{ name: 'os.md', extractedText: 'Ubuntu 22.04' }];
  const r = buildLinuxDistrosForFiles(files);
  const md = renderLinuxDistrosBlock(r);
  assert.match(md, /^## LINUX DISTRIBUTIONS/);
});

test('renderLinuxDistrosBlock empty when nothing surfaces', () => {
  assert.equal(renderLinuxDistrosBlock({ perFile: [] }), '');
  assert.equal(renderLinuxDistrosBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildLinuxDistrosForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Ubuntu 22.04' },
  ]);
  assert.equal(r.perFile.length, 1);
});
