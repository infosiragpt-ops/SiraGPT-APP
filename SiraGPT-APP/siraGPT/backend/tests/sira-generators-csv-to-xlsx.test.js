"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  generateCsvToXlsx,
  parseCsv,
  autoDetectDelimiter,
  colLetter,
  MIME,
  EXT,
} = require("../src/services/sira/generators/csv-to-xlsx");
const { zipParse } = require("../src/services/sira/generators/zip-utils");

const decoder = (buf) => buf.toString("utf8");

function entriesByName(buf) {
  const out = {};
  for (const e of zipParse(buf)) out[e.name] = decoder(e.data);
  return out;
}

test("colLetter maps 1→A, 26→Z, 27→AA, 52→AZ, 703→AAA", () => {
  assert.equal(colLetter(1), "A");
  assert.equal(colLetter(26), "Z");
  assert.equal(colLetter(27), "AA");
  assert.equal(colLetter(52), "AZ");
  assert.equal(colLetter(703), "AAA");
});

test("parseCsv: simple comma-separated rows", () => {
  const rows = parseCsv("a,b,c\n1,2,3\n4,5,6");
  assert.deepEqual(rows, [["a","b","c"],["1","2","3"],["4","5","6"]]);
});

test("parseCsv: handles quoted fields with commas, doubled quotes and newlines", () => {
  const csv = `name,note\n"Smith, J.","says ""hi"""\n"multi\nline","ok"`;
  const rows = parseCsv(csv);
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Smith, J.", 'says "hi"'],
    ["multi\nline", "ok"],
  ]);
});

test("parseCsv: handles \\r\\n and trailing newline", () => {
  const rows = parseCsv("a,b\r\n1,2\r\n");
  assert.deepEqual(rows, [["a","b"],["1","2"]]);
});

test("parseCsv: strips UTF-8 BOM", () => {
  const csv = "﻿a,b\n1,2";
  const rows = parseCsv(csv);
  assert.deepEqual(rows, [["a","b"],["1","2"]]);
});

test("parseCsv: alternative delimiter (semicolon)", () => {
  const rows = parseCsv("a;b;c\n1;2;3", { delimiter: ";" });
  assert.deepEqual(rows, [["a","b","c"],["1","2","3"]]);
});

test("autoDetectDelimiter: picks the most frequent outside quotes", () => {
  assert.equal(autoDetectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(autoDetectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(autoDetectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  // Quoted commas don't bias the count
  assert.equal(autoDetectDelimiter('"a,still";"b";"c"\n1;2;3'), ";");
});

test("generateCsvToXlsx: returns a valid xlsx zip with required parts", () => {
  const out = generateCsvToXlsx({ csv: "name,age\nAlice,30\nBob,25" });
  assert.equal(out.mime, MIME);
  assert.equal(out.extension, EXT);
  assert.ok(Buffer.isBuffer(out.buffer));
  // ZIP local-file-header magic
  assert.equal(out.buffer.readUInt32LE(0), 0x04034b50);

  const files = entriesByName(out.buffer);
  for (const required of [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/worksheets/sheet1.xml",
    "xl/styles.xml",
  ]) {
    assert.ok(files[required], `missing ${required}`);
  }
});

test("generateCsvToXlsx: writes string and numeric cells correctly", () => {
  const out = generateCsvToXlsx({ csv: "name,age\nAlice,30\nBob,25" });
  const sheet = entriesByName(out.buffer)["xl/worksheets/sheet1.xml"];
  // Row count + dimension
  assert.match(sheet, /<dimension ref="A1:B3"\/>/);
  // String cell uses inlineStr
  assert.match(sheet, /<c r="A1"[^>]*t="inlineStr"><is><t[^>]*>name<\/t><\/is><\/c>/);
  // Numeric cell stays as <v>
  assert.match(sheet, /<c r="B2"><v>30<\/v><\/c>/);
  assert.match(sheet, /<c r="B3"><v>25<\/v><\/c>/);
});

test("generateCsvToXlsx: leading-zero numeric is treated as string (not number)", () => {
  const out = generateCsvToXlsx({ csv: "id\n00123\n42" });
  const sheet = entriesByName(out.buffer)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="A2"[^>]*t="inlineStr"><is><t[^>]*>00123<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A3"><v>42<\/v><\/c>/);
});

test("generateCsvToXlsx: escapes XML special chars", () => {
  const out = generateCsvToXlsx({ csv: 'a,b\n"<x&y>","\\"q\\""' });
  const sheet = entriesByName(out.buffer)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /&lt;x&amp;y&gt;/);
  assert.ok(!/<x&y>/.test(sheet));
});

test("generateCsvToXlsx: header=true bolds first row via style 1", () => {
  const out = generateCsvToXlsx({ csv: "h1,h2\nv1,v2", header: true });
  const sheet = entriesByName(out.buffer)["xl/worksheets/sheet1.xml"];
  // First row gets s="1"; second row does not
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr">/);
  assert.ok(!/<c r="A2"[^>]*s="1"/.test(sheet));
});

test("generateCsvToXlsx: empty cells are skipped (no <c> emitted)", () => {
  const out = generateCsvToXlsx({ csv: "a,b,c\n1,,3" });
  const sheet = entriesByName(out.buffer)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="A2"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="C2"><v>3<\/v><\/c>/);
  // No B2 cell
  assert.ok(!/<c r="B2"/.test(sheet));
});

test("generateCsvToXlsx: sanitises sheet name (length and forbidden chars)", () => {
  const out = generateCsvToXlsx({
    csv: "a\n1",
    sheetName: "bad/name:with[chars]?*\\and-extra-very-long-tail-here",
  });
  const wb = entriesByName(out.buffer)["xl/workbook.xml"];
  const m = /name="([^"]+)"/.exec(wb);
  assert.ok(m, "sheet name attr present");
  assert.ok(m[1].length <= 31, "sheet name capped at 31 chars");
  assert.ok(!/[:\\/?*\[\]]/.test(m[1]), "no forbidden characters");
});

test("generateCsvToXlsx: accepts a Buffer csv input", () => {
  const buf = Buffer.from("x,y\n1,2", "utf8");
  const out = generateCsvToXlsx({ csv: buf });
  const sheet = entriesByName(out.buffer)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="A2"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="B2"><v>2<\/v><\/c>/);
});

test("generateCsvToXlsx: accepts a plain CSV string as the plan", () => {
  const out = generateCsvToXlsx("a,b\n1,2");
  assert.equal(out.mime, MIME);
  assert.equal(out.rowCount, 2);
});

test("generateCsvToXlsx: throws on missing csv", () => {
  assert.throws(() => generateCsvToXlsx({}), /plan\.csv/);
  assert.throws(() => generateCsvToXlsx(null), /plan must be/);
});

test("generateCsvToXlsx: passthrough preserves row/col counts (no re-parse loss)", () => {
  const lines = ["c1,c2,c3,c4"];
  for (let i = 0; i < 50; i++) lines.push(`${i},foo${i},${i * 2},"q,${i}"`);
  const csv = lines.join("\n");
  const out = generateCsvToXlsx({ csv });
  assert.equal(out.rowCount, 51);
  const sheet = entriesByName(out.buffer)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<dimension ref="A1:D51"\/>/);
  // The quoted comma should survive as part of the string cell
  assert.match(sheet, /q,49/);
});

test("generateCsvToXlsx: boolean detection", () => {
  const out = generateCsvToXlsx({ csv: "flag\nTRUE\nfalse" });
  const sheet = entriesByName(out.buffer)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="A2" t="b"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="A3" t="b"><v>0<\/v><\/c>/);
});
