'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-licenses');
const { extractLicenses, buildLicensesForFiles, renderLicensesBlock, _internal } = engine;
const { normaliseSpdx } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractLicenses('').total, 0);
  assert.equal(extractLicenses(null).total, 0);
});

test('normaliseSpdx: Apache 2.0 → Apache-2.0', () => {
  assert.equal(normaliseSpdx('Apache 2.0'), 'Apache-2.0');
  assert.equal(normaliseSpdx('MIT'), 'MIT');
});

test('detects SPDX MIT license', () => {
  const r = extractLicenses('This project is licensed under MIT.');
  assert.ok(r.entries.some((e) => e.value === 'MIT'));
});

test('detects SPDX Apache-2.0', () => {
  const r = extractLicenses('Licensed under Apache-2.0 license.');
  assert.ok(r.entries.some((e) => e.value === 'Apache-2.0'));
});

test('detects GPL-3.0', () => {
  const r = extractLicenses('See GPL-3.0 for terms.');
  assert.ok(r.entries.some((e) => e.value === 'GPL-3.0'));
});

test('detects BSD-3-Clause', () => {
  const r = extractLicenses('Distributed under BSD-3-Clause license.');
  assert.ok(r.entries.some((e) => e.value === 'BSD-3-Clause'));
});

test('detects SPDX-License-Identifier header', () => {
  const r = extractLicenses('// SPDX-License-Identifier: Apache-2.0\nconst foo = 1;');
  assert.ok(r.entries.some((e) => e.kind === 'header' && e.value === 'Apache-2.0'));
});

test('detects "Licensed under" attribution', () => {
  const r = extractLicenses('Licensed under the Apache License, Version 2.0');
  assert.ok(r.entries.some((e) => e.kind === 'licensedUnder'));
});

test('detects Copyright © YYYY Name', () => {
  const r = extractLicenses('Copyright © 2024 Acme Inc.');
  assert.ok(r.entries.some((e) => e.kind === 'copyright' && /Acme/.test(e.value)));
});

test('detects (c) YYYY Name', () => {
  const r = extractLicenses('(c) 2023 Foo Corp');
  assert.ok(r.entries.some((e) => e.kind === 'copyright'));
});

test('detects All Rights Reserved', () => {
  const r = extractLicenses('© 2024 Acme. All Rights Reserved.');
  assert.ok(r.entries.some((e) => e.kind === 'allRightsReserved'));
});

test('detects Spanish "Todos los derechos reservados"', () => {
  const r = extractLicenses('© 2024 Acme. Todos los derechos reservados.');
  assert.ok(r.entries.some((e) => e.kind === 'allRightsReserved'));
});

test('detects Apache 2.0 with space → normalises to Apache-2.0', () => {
  const r = extractLicenses('SPDX-License-Identifier: Apache 2.0');
  assert.ok(r.entries.some((e) => e.value === 'Apache-2.0'));
});

test('dedupes header + SPDX with same value', () => {
  const r = extractLicenses('SPDX-License-Identifier: MIT\nThis project uses MIT.');
  // Header takes priority; SPDX entry for MIT is deduped
  const mit = r.entries.filter((e) => e.value === 'MIT');
  assert.equal(mit.length, 1);
});

test('dedupes identical SPDX appearing twice', () => {
  const r = extractLicenses('We use MIT here. MIT also there.');
  assert.equal(r.entries.filter((e) => e.value === 'MIT').length, 1);
});

test('caps entries per file', () => {
  let text = 'SPDX-License-Identifier: MIT\n';
  for (let i = 0; i < 20; i++) text += `Copyright © 202${i} Author${i}\n`;
  const r = extractLicenses(text);
  assert.ok(r.entries.length <= 16);
});

test('totals reports breakdown', () => {
  const r = extractLicenses('SPDX-License-Identifier: MIT\nCopyright © 2024 Acme. All Rights Reserved.');
  assert.ok(r.totals.header >= 1);
  assert.ok(r.totals.copyright >= 1);
  assert.ok(r.totals.allRightsReserved >= 1);
});

test('buildLicensesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Licensed under MIT.' },
    { name: 'b.md', extractedText: 'Copyright © 2024 Foo' },
  ];
  const r = buildLicensesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderLicensesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Licensed under MIT.' }];
  const r = buildLicensesForFiles(files);
  const md = renderLicensesBlock(r);
  assert.match(md, /^## LICENSES \/ COPYRIGHT/);
});

test('renderLicensesBlock empty when nothing surfaces', () => {
  assert.equal(renderLicensesBlock({ perFile: [] }), '');
  assert.equal(renderLicensesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildLicensesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'MIT license' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('detects ISC and Unlicense', () => {
  const r1 = extractLicenses('Licensed under ISC.');
  assert.ok(r1.entries.some((e) => e.value === 'ISC'));
  const r2 = extractLicenses('See Unlicense for terms.');
  assert.ok(r2.entries.some((e) => e.value === 'Unlicense'));
});
