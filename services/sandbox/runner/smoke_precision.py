#!/usr/bin/env python3
"""Functional, offline proofs for every new precision dependency.

--list-proofs requires only the Python standard library. Normal execution
creates and reopens actual artifacts; a missing dependency or failed assertion
returns a nonzero status. Run in the same read-only, non-root image as the agent.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import zipfile

PROOFS = {}


def proof(name):
    def register(function):
        if name in PROOFS:
            raise ValueError(f"duplicate proof {name}")
        PROOFS[name] = function
        return function
    return register


def rejects(function, *args, **kwargs):
    try:
        function(*args, **kwargs)
    except (ValueError, TypeError):
        return
    raise AssertionError("invalid input was silently accepted")


def test_font():
    candidates = [Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
    import matplotlib
    candidates.append(Path(matplotlib.get_data_path()) / 'fonts/ttf/DejaVuSans.ttf')
    return next(path for path in candidates if path.is_file())


@proof('typography')
def typography(root):
    import brotli
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from sira_layout import measure_text, fit_text, font_coverage, mm_to_emu, emu_to_mm
    font_path = test_font()
    original = hashlib.sha256(font_path.read_bytes()).hexdigest()
    av = measure_text(font_path, 'AV', 24)
    separate = sum(measure_text(font_path, c, 24)['lines'][0]['advance_pt'] for c in 'AV')
    assert av['complete'] and av['lines'][0]['advance_pt'] < separate, 'kerning must affect the measured advance'
    assert measure_text(font_path, 'office', 24)['lines'][0]['glyphs'] < 6, 'OpenType ligature shaping is active'
    accented = measure_text(font_path, 'Edición precisa — año 2026', 16)
    assert accented['complete'] and accented['width_mm'] > 20
    multiline = measure_text(font_path, 'Primera línea\nSegunda línea', 12)
    assert len(multiline['lines']) == 2 and multiline['height_pt'] > 24
    empty = measure_text(font_path, '', 12)
    assert empty['complete'] and empty['width_pt'] == 0 and empty['height_pt'] > 0
    assert empty['lines'][0]['glyphs'] == 0
    spaced = measure_text(font_path, 'a\n\nb', 12)
    assert len(spaced['lines']) == 3 and spaced['lines'][1]['glyphs'] == 0
    assert spaced['height_pt'] > measure_text(font_path, 'a\nb', 12)['height_pt']
    assert fit_text(font_path, '\n', 20, 20)['fits']
    fit = fit_text(font_path, 'Edición precisa', 30, 10, min_pt=8, max_pt=30)
    assert fit['fits'] and 8 <= fit['size_pt'] < 30
    assert fit['metrics']['width_mm'] <= 30 and fit['metrics']['height_mm'] <= 10
    assert not fit_text(font_path, 'A' * 100, 1, 1)['fits'], 'must not truncate to fit'
    assert not fit_text(font_path, 'missing \U0010ffff', 80, 20)['fits'], 'must not substitute missing glyphs'
    assert mm_to_emu('0.125') == 4500 and emu_to_mm(4500) == .125
    assert mm_to_emu('-0.125') == -4500
    rejects(mm_to_emu, 'NaN')
    rejects(measure_text, font_path, 'text', float('inf'))
    rejects(fit_text, font_path, 'text', 100, 30, min_pt=30, max_pt=10)
    rejects(measure_text, font_path, 'text\ttab')
    text = 'Precisión 2026'
    output = root / 'precision.woff2'
    with TTFont(font_path) as font:
        original_count = len(font.getGlyphOrder())
        options = subset.Options()
        options.notdef_glyph = True
        sub = subset.Subsetter(options=options)
        sub.populate(text=text)
        sub.subset(font)
        font.flavor = 'woff2'
        font.save(output)
    with TTFont(output) as restored:
        assert all(ord(ch) in restored.getBestCmap() for ch in text)
        assert len(restored.getGlyphOrder()) < original_count
    assert font_coverage(output, text)['complete']
    data = 'Texto de precisión — 2026'.encode()
    assert brotli.decompress(brotli.compress(data)) == data
    assert hashlib.sha256(font_path.read_bytes()).hexdigest() == original
    (root / 'text-fit.json').write_text(json.dumps(fit, ensure_ascii=False), encoding='utf8')
    return {"checks": 22, "artifacts": [output.name, 'text-fit.json']}


@proof('color')
def color(root):
    from sira_layout import color_contrast
    white_black = color_contrast('#ffffff', '#000000')
    assert math.isclose(white_black['ratio'], 21)
    assert white_black['normal_text_aaa']
    same = color_contrast('#777777', '#777777')
    assert math.isclose(same['ratio'], 1) and not same['normal_text_aa']
    assert color_contrast('#000000', '#ffffff')['ratio'] == white_black['ratio']
    rejects(color_contrast, 'rgb(0 0 0 / 50%)', 'white')
    rejects(color_contrast, 'color(srgb 2 0 0)', 'white')
    (root / 'contrast.json').write_text(json.dumps(white_black), encoding='utf8')
    return {"checks": 6, "artifacts": ['contrast.json']}


def replace_part(source, destination, name, edit):
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(destination, 'w') as after:
        for item in before.infolist():
            content = before.read(item.filename)
            after.writestr(item, edit(content) if item.filename == name else content)


@proof('preservation')
def preservation(root):
    from docx import Document
    from lxml import etree
    from xmldiff import main as xml_diff
    from defusedxml import ElementTree as safe_xml
    from defusedxml.common import DefusedXmlException
    import sira_preserve
    source = root / 'original.docx'
    doc = Document()
    p = doc.add_paragraph()
    p.add_run('Cambiar solo esto').bold = True
    p.add_run(' Texto protegido').italic = True
    doc.sections[0].header.paragraphs[0].text = 'Encabezado protegido'
    doc.save(source)
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    target = '/w:document/w:body/w:p[1]/w:r[1]/w:t'
    def modify(content, corrupt=False):
        tree = etree.fromstring(content)
        tree.xpath(target, namespaces=ns)[0].text = 'Edición verificada'
        if corrupt:
            tree.xpath('/w:document/w:body/w:p[1]/w:r[2]/w:t', namespaces=ns)[0].text = 'Cambio no pedido'
        return etree.tostring(tree)
    good, bad = root / 'precise.docx', root / 'collateral.docx'
    replace_part(source, good, 'word/document.xml', modify)
    replace_part(source, bad, 'word/document.xml', lambda raw: modify(raw, True))
    contract = {'version': 1, 'namespaces': ns,
                'allow': [{'part': 'word/document.xml', 'xpath': target, 'text': True}]}
    # Public entry point is shared by the agent's Office verifier.
    valid = sira_preserve.verify_preservation(str(source), str(good), contract)
    invalid = sira_preserve.verify_preservation(str(source), str(bad), contract)
    assert valid['ok'] and valid['complete'], valid
    assert not invalid['ok'] and invalid['complete'], invalid
    restored = Document(good)
    assert restored.paragraphs[0].runs[0].bold
    assert restored.paragraphs[0].runs[1].italic
    assert restored.sections[0].header.paragraphs[0].text == 'Encabezado protegido'
    assert xml_diff.diff_texts('<p value="1"/>', '<p value="2"/>'), 'XML change must have an explanation'
    try:
        safe_xml.fromstring('<!DOCTYPE p [<!ENTITY x "injected">]><p>&x;</p>')
    except DefusedXmlException:
        pass
    else:
        raise AssertionError('entity expansion was accepted')
    assert safe_xml.fromstring('<p>legitimate</p>').text == 'legitimate'
    (root / 'preservation.json').write_text(json.dumps({'valid': valid, 'invalid': invalid}), encoding='utf8')
    return {"checks": 8, "artifacts": [source.name, good.name, bad.name, 'preservation.json']}


@proof('pdf-geometry')
def pdf_geometry(root):
    from reportlab.pdfgen import canvas
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import DecodedStreamObject, NameObject, NumberObject
    import pypdfium2 as pdfium
    from PIL import Image
    from sira_layout import pdf_text_geometry
    output = root / 'measured.pdf'
    pdf = canvas.Canvas(str(output), pagesize=(210 * mm, 297 * mm))
    pdf.setFont('Helvetica', 12)
    pdf.drawString(20 * mm, 30 * mm, 'Precise PDF')
    pdf.showPage()
    pdf.save()
    geometry = pdf_text_geometry(output)
    assert geometry['complete'] and not geometry['text_missing']
    assert ''.join(c['text'] for c in geometry['characters']) == 'Precise PDF'
    first = geometry['characters'][0]['box_mm']
    assert 19.5 < first[0] < 22 and 29 < first[1] < 34, first
    assert math.isclose(geometry['visible_box_pt'][2] / mm, 210, abs_tol=.01)
    rejects(pdf_text_geometry, output, 99)
    rejects(pdf_text_geometry, output, max_chars=1)
    # Render through a different engine than the producer and reopen the PNG.
    preview = root / 'measured.png'
    with pdfium.PdfDocument(output) as check:
        page = check[0]
        bitmap = page.render(scale=2)
        bitmap.to_pil().save(preview)
        bitmap.close()
        page.close()
    with Image.open(preview) as png:
        assert png.width > 1100 and png.height > 1600
    reader = PdfReader(output)
    reader.pages[0][NameObject('/UserUnit')] = NumberObject(2)
    altered = root / 'nonstandard-unit.pdf'
    writer = PdfWriter()
    writer.add_page(reader.pages[0])
    writer.write(altered)
    rejects(pdf_text_geometry, altered)
    # A real embedded font and valid UTF-16 ToUnicode mapping exercise the
    # renderer's surrogate indices. Never decode single code units as strings.
    pdfmetrics.registerFont(TTFont('PrecisionUnicode', str(test_font())))
    unicode_source = root / 'unicode-source.pdf'
    pdf = canvas.Canvas(str(unicode_source))
    pdf.setFont('PrecisionUnicode', 14)
    pdf.drawString(30, 400, 'A\U0001f600B')
    pdf.save()

    def mapped_unicode_pdf(destination, mapping):
        unicode_reader = PdfReader(unicode_source)
        unicode_writer = PdfWriter()
        mapped = False
        for font_ref in unicode_reader.pages[0]['/Resources']['/Font'].values():
            font = font_ref.get_object()
            if '/ToUnicode' not in font:
                continue
            data = font['/ToUnicode'].get_object().get_data()
            # ReportLab versions can emit a scalar rather than the UTF-16BE
            # representation required by PDF. Normalize the fixture itself.
            for original in (b'<1F600>', b'<D83DDE00>'):
                if original in data:
                    data = data.replace(original, b'<' + mapping + b'>')
                    mapped = True
            stream = DecodedStreamObject()
            stream.set_data(data)
            font[NameObject('/ToUnicode')] = unicode_writer._add_object(stream)
        assert mapped, 'the embedded fixture must include an explicit emoji mapping'
        unicode_writer.add_page(unicode_reader.pages[0])
        unicode_writer.write(destination)

    unicode_pdf = root / 'unicode-astral.pdf'
    mapped_unicode_pdf(unicode_pdf, b'D83DDE00')
    with pdfium.PdfDocument(unicode_pdf) as check:
        unicode_page = check[0]
        unicode_text = unicode_page.get_textpage()
        assert unicode_text.get_text_bounded() == 'A\U0001f600B', 'fixture must contain valid Unicode'
        unicode_text.close()
        unicode_page.close()
    unicode_geometry = pdf_text_geometry(unicode_pdf)
    assert unicode_geometry['complete']
    assert ''.join(c['text'] for c in unicode_geometry['characters']) == 'A\U0001f600B'
    assert len(unicode_geometry['characters']) == 3
    assert [c['index_count'] for c in unicode_geometry['characters']] in ([1, 2, 1], [1, 1, 1])
    assert unicode_geometry['characters'][1]['box_pt'][2] > unicode_geometry['characters'][1]['box_pt'][0]
    for name, mapping in (('high-surrogate', b'D83D'), ('low-surrogate', b'DE00'), ('unmapped', b'0000')):
        malformed = root / f'unicode-{name}.pdf'
        mapped_unicode_pdf(malformed, mapping)
        rejects(pdf_text_geometry, malformed)
    (root / 'unicode-geometry.json').write_text(json.dumps(unicode_geometry, ensure_ascii=False), encoding='utf8')
    (root / 'pdf-geometry.json').write_text(json.dumps(geometry), encoding='utf8')
    return {"checks": 17, "artifacts": [output.name, preview.name, 'pdf-geometry.json',
                                       unicode_pdf.name, 'unicode-geometry.json']}


@proof('spreadsheet-roundtrip')
def spreadsheet(root):
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Font, PatternFill
    from python_calamine import CalamineWorkbook
    output = root / 'measured.xlsx'
    book = Workbook()
    sheet = book.active
    sheet.title = 'Medidas'
    sheet.append(['Objeto', 'Milímetros', 'Protegido'])
    sheet.append(['Margen', 12.375, 'áéíóú'])
    sheet['B2'].number_format = '0.000'
    sheet['B2'].font = Font(name='Calibri', bold=True, color='112233')
    sheet['B2'].fill = PatternFill('solid', fgColor='DDEEFF')
    sheet.freeze_panes = 'A2'
    book.save(output)
    with CalamineWorkbook.from_path(str(output)) as independent:
        data = independent.get_sheet_by_name('Medidas').to_python()
        assert data[1] == ['Margen', 12.375, 'áéíóú']
    revised = load_workbook(output)
    revised.active['B2'] = 12.5
    edited = root / 'measured-edited.xlsx'
    revised.save(edited)
    with CalamineWorkbook.from_path(str(edited)) as independent:
        values = independent.get_sheet_by_name('Medidas').to_python()
        assert values[1] == ['Margen', 12.5, 'áéíóú']
    reopened = load_workbook(edited)
    assert reopened.active['B2'].font.bold and reopened.active['B2'].font.color.rgb == '00112233'
    assert reopened.active['B2'].number_format == '0.000'
    assert reopened.active.freeze_panes == 'A2'
    assert reopened.active['B2'].fill.fgColor.rgb == '00DDEEFF'
    return {"checks": 6, "artifacts": [output.name, edited.name]}


@proof('encrypted-office-roundtrip')
def encrypted_office(root):
    import msoffcrypto
    import olefile
    from docx import Document
    from openpyxl import Workbook, load_workbook
    # Synthetic ephemeral password. Never used for an account or printed.
    password = 'synthetic-fixture-only'
    checks, artifacts = 0, []
    for ext in ('docx', 'xlsx'):
        source = io.BytesIO()
        if ext == 'docx':
            doc = Document()
            doc.add_paragraph('Contenido protegido de precisión')
            doc.save(source)
        else:
            book = Workbook()
            book.active.append(['Medida', 12.375])
            book.save(source)
        plain_bytes = source.getvalue()
        source.seek(0)
        encrypted = root / f'encrypted.{ext}'
        with encrypted.open('wb') as target:
            msoffcrypto.OfficeFile(source).encrypt(password, target)
        assert olefile.isOleFile(str(encrypted))
        with olefile.OleFileIO(str(encrypted)) as compound:
            assert compound.exists('EncryptionInfo') and compound.exists('EncryptedPackage')
        with encrypted.open('rb') as handle:
            protected = msoffcrypto.OfficeFile(handle)
            assert protected.is_encrypted()
            protected.load_key(password=password, verify_password=True)
            recovered = io.BytesIO()
            protected.decrypt(recovered, verify_integrity=True)
        assert recovered.getvalue() == plain_bytes
        recovered.seek(0)
        if ext == 'docx':
            assert Document(recovered).paragraphs[0].text == 'Contenido protegido de precisión'
        else:
            assert load_workbook(recovered).active['B1'].value == 12.375
        with encrypted.open('rb') as handle:
            protected = msoffcrypto.OfficeFile(handle)
            try:
                protected.load_key(password='wrong-fixture-password', verify_password=True)
            except msoffcrypto.exceptions.InvalidKeyError:
                pass
            else:
                raise AssertionError('wrong password accepted')
        checks += 6
        artifacts.append(encrypted.name)
    return {"checks": checks, "artifacts": artifacts}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', nargs='?')
    parser.add_argument('--list-proofs', action='store_true')
    parser.add_argument('--catalog', default=os.environ.get('SIRA_CAPABILITIES', str(Path(__file__).with_name('capabilities.json'))))
    args = parser.parse_args()
    if args.list_proofs:
        print(json.dumps(sorted(PROOFS)))
        return 0
    if not args.directory:
        parser.error('directory is required for functional proofs')
    catalog = json.loads(Path(args.catalog).read_text(encoding='utf8'))
    required = {item['proof'] for item in catalog['python'] if 'proof' in item}
    if not required or required - PROOFS.keys():
        print(json.dumps({'ok': False, 'error': 'missing precision proof', 'missing': sorted(required - PROOFS.keys())}))
        return 1
    root = Path(args.directory)
    root.mkdir(parents=True, exist_ok=True)
    results = []
    for name in sorted(PROOFS):
        directory = root / name
        directory.mkdir(exist_ok=True)
        try:
            result = PROOFS[name](directory)
            results.append({'id': name, 'ok': True, **result})
        except Exception as error:
            results.append({'id': name, 'ok': False, 'error': f'{type(error).__name__}: {error}'})
    report = {'ok': all(result['ok'] for result in results), 'proofs': results,
              'checks': sum(result.get('checks', 0) for result in results),
              'libraries': sum('proof' in item for item in catalog['python'])}
    (root / 'precision-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
