'use strict';

/**
 * doc-agent-validate-dir-entries — ZIP directory entries are not OOXML parts.
 *
 * PptxGenJS (via JSZip) writes explicit directory entries (`ppt/`,
 * `ppt/slides/`, …) into every deck it generates — including the decks
 * SiraGPT's own pipeline produces. python-pptx round-trips drop those
 * entries (it only writes file parts). diffOoxml must not report them as
 * removed parts, or EVERY python-pptx edit of a generated deck hard-fails
 * with `parts_removed` and the user sees "No pude entregar un archivo
 * editado que superara la verificación" even for a perfect edit
 * (add-slide verified byte-for-byte in diagnosis).
 *
 * Offline: decks via the `pptxgenjs` npm dep, ZIP surgery via python3
 * stdlib (zipfile only). No network, no API keys.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexec = promisify(execFile);

const {
  listZipEntries,
  diffOoxml,
  validateEditedFile,
} = require('../src/services/doc-agent/validate');

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-dirs-'));
  try {
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function writeScript(tmp, name, lines) {
  const scriptPath = path.join(tmp, name);
  await fs.writeFile(scriptPath, lines.join('\n'));
  return scriptPath;
}

// A minimal OOXML-ish zip WITH explicit directory entries (what JSZip writes)
// and one WITHOUT (what python-pptx writes after a round-trip).
const ZIP_WITH_DIRS_PY = [
  'import sys, zipfile',
  'out = sys.argv[1]',
  'zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)',
  'zout.writestr("[Content_Types].xml", "<Types/>")',
  'zout.writestr(zipfile.ZipInfo("ppt/"), b"")',
  'zout.writestr(zipfile.ZipInfo("ppt/slides/"), b"")',
  'zout.writestr("ppt/slides/slide1.xml", b"<p:sld>uno</p:sld>")',
  'zout.close()',
  '',
];

test('validate: directory entries are not parts and never count as removed', async () => {
  await withTmp(async (tmp) => {
    const withDirs = path.join(tmp, 'with-dirs.zip');
    const script = await writeScript(tmp, 'mk.py', ZIP_WITH_DIRS_PY);
    await pexec('python3', [script, withDirs]);
    const entries = listZipEntries(await fs.readFile(withDirs));
    assert.ok(entries.some((e) => e.name === '[Content_Types].xml'));
    assert.equal(entries.filter((e) => e.name.endsWith('/')).length, 0);

    // Same logical package without directory entries + one added part:
    // python-pptx round-trip output. Nothing was removed.
    const noDirs = path.join(tmp, 'no-dirs.zip');
    const editScript = await writeScript(tmp, 'edit.py', [
      'import sys, zipfile',
      'src, out = sys.argv[1], sys.argv[2]',
      'zin = zipfile.ZipFile(src)',
      'zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)',
      'for it in zin.infolist():',
      '    if it.filename.endswith("/"): continue',
      '    zout.writestr(it.filename, zin.read(it.filename))',
      'zout.writestr("ppt/slides/slide2.xml", b"<p:sld>dos</p:sld>")',
      'zout.close()',
      '',
    ]);
    await pexec('python3', [editScript, withDirs, noDirs]);
    const diff = diffOoxml(await fs.readFile(withDirs), await fs.readFile(noDirs));
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.added, ['ppt/slides/slide2.xml']);
    const verdict = validateEditedFile({
      originalBuffer: await fs.readFile(withDirs),
      editedBuffer: await fs.readFile(noDirs),
      instruction: 'agrega una diapositiva',
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'valid');
  });
});

test('validate: removing a real part still fails with parts_removed', async () => {
  await withTmp(async (tmp) => {
    const withDirs = path.join(tmp, 'with-dirs.zip');
    const script = await writeScript(tmp, 'mk.py', ZIP_WITH_DIRS_PY);
    await pexec('python3', [script, withDirs]);
    const dropScript = await writeScript(tmp, 'drop.py', [
      'import sys, zipfile',
      'src, out = sys.argv[1], sys.argv[2]',
      'zin = zipfile.ZipFile(src)',
      'zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)',
      'for it in zin.infolist():',
      '    if it.filename.endswith("/") or it.filename == "ppt/slides/slide1.xml": continue',
      '    zout.writestr(it.filename, zin.read(it.filename))',
      'zout.close()',
      '',
    ]);
    const dropped = path.join(tmp, 'dropped.zip');
    await pexec('python3', [dropScript, withDirs, dropped]);
    const verdict = validateEditedFile({
      originalBuffer: await fs.readFile(withDirs),
      editedBuffer: await fs.readFile(dropped),
      instruction: 'cambia el título',
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'parts_removed');
    assert.ok(verdict.details.includes('ppt/slides/slide1.xml'));
  });
});

async function makePptxGenJsDeck(fileName) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  for (const title of ['Concepto y Proceso', 'Funciones Clave']) {
    const slide = pptx.addSlide();
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: 'F5F3FF' }, line: { color: 'F5F3FF' } });
    slide.addText(title, { x: 0.7, y: 0.4, w: 11.9, h: 0.8, fontSize: 28, bold: true, color: '1E1B4B' });
    slide.addText('Punto de ejemplo', { x: 0.9, y: 1.8, w: 11.5, h: 4.5, fontSize: 14, color: '333333' });
  }
  await pptx.writeFile({ fileName });
}

// Simulates exactly what a successful python-pptx add_slide round-trip
// produces on a PptxGenJS deck: same files minus directory entries, plus the
// new slide part + rels, sldIdLst entry and content-type override.
const ADD_SLIDE_PY = [
  'import sys, zipfile, re',
  'src, out = sys.argv[1], sys.argv[2]',
  'zin = zipfile.ZipFile(src)',
  'parts = {}',
  'for it in zin.infolist():',
  '    if it.filename.endswith("/"): continue',
  '    parts[it.filename] = zin.read(it.filename)',
  'slide_xml = parts["ppt/slides/slide1.xml"].decode("utf-8")',
  'parts["ppt/slides/slide3.xml"] = slide_xml.replace("Concepto y Proceso", "Ejemplo agregado")',
  'slide_rels = parts.get("ppt/slides/_rels/slide1.xml.rels", b"")',
  'parts["ppt/slides/_rels/slide3.xml.rels"] = slide_rels',
  'pres = parts["ppt/presentation.xml"].decode("utf-8")',
  'ids = [int(x) for x in re.findall(\'id="([0-9]+)"\', pres)]',
  'new_id = (max(ids) if ids else 256) + 1',
  'pres_rels = parts["ppt/_rels/presentation.xml.rels"].decode("utf-8")',
  'rids = [int(x) for x in re.findall(\'Id="rId([0-9]+)"\', pres_rels)]',
  'new_rid = "rId%d" % ((max(rids) if rids else 0) + 1)',
  'pres = pres.replace("</p:sldIdLst>", \'<p:sldId id="%d" r:id="%s"/></p:sldIdLst>\' % (new_id, new_rid))',
  'parts["ppt/presentation.xml"] = pres',
  'pres_rels = pres_rels.replace("</Relationships>", \'<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/></Relationships>\' % new_rid)',
  'parts["ppt/_rels/presentation.xml.rels"] = pres_rels',
  'ct = parts["[Content_Types].xml"].decode("utf-8")',
  'override = \'<Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\'',
  'parts["[Content_Types].xml"] = ct.replace("</Types>", override + "</Types>")',
  'zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)',
  'for name, data in parts.items():',
  '    zout.writestr(name, data if isinstance(data, bytes) else data.encode("utf-8"))',
  'zout.close()',
  '',
];

test('validate: add-slide on a PptxGenJS deck passes (user repro: agregar diapositiva)', async () => {
  await withTmp(async (tmp) => {
    const orig = path.join(tmp, 'orig.pptx');
    await makePptxGenJsDeck(orig);
    const origBuf = await fs.readFile(orig);
    // Sanity: PptxGenJS really does ship directory entries.
    const PizZip = require('pizzip');
    const names = Object.keys(new PizZip(origBuf).files);
    assert.ok(names.some((n) => n.endsWith('/')), 'expected directory entries in PptxGenJS output');

    const edited = path.join(tmp, 'edited.pptx');
    const script = await writeScript(tmp, 'addslide.py', ADD_SLIDE_PY);
    await pexec('python3', [script, orig, edited]);
    const verdict = validateEditedFile({
      originalBuffer: origBuf,
      editedBuffer: await fs.readFile(edited),
      instruction: 'puedes agregar una diapositiva mas como un ejemplo',
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'valid');
    assert.ok(verdict.diff.added.includes('ppt/slides/slide3.xml'));
    assert.deepEqual(verdict.diff.removed, []);
  });
});
