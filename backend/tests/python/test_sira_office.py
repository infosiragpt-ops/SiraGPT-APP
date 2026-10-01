#!/usr/bin/env python3
"""Pruebas de sira_office.py — correr con:  python3 -m unittest -v test_sira_office.py"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
# En el repo: backend/tests/python/ → el motor vive en backend/src/services/agent-runner/
for candidate in (HERE, os.path.join(HERE, "..", "..", "src", "services", "agent-runner")):
    if os.path.exists(os.path.join(candidate, "sira_office.py")):
        sys.path.insert(0, os.path.abspath(candidate))
        break
import sira_office as so  # noqa: E402

try:
    import make_fixtures  # noqa: E402  (requiere python-docx, openpyxl y python-pptx)
    BODY = make_fixtures.BODY
except ImportError:  # con SIRA_FIXTURES_DIR no hace falta generarlos
    make_fixtures = None
    BODY = ("El suelo arcilloso de la zona presenta baja capacidad portante y alta plasticidad, lo que limita su uso "
            "como subrasante en vías rurales. La estabilización con cal es una alternativa de bajo costo que reduce "
            "la plasticidad y mejora la resistencia mecánica del material.")

HAS_LO = bool(shutil.which("soffice") or shutil.which("libreoffice")) and bool(shutil.which("pdftoppm"))
W = so.W


def parts(path):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist()}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="sira-test-")
        cls.docx = os.path.join(cls.tmp, "tesis.docx")
        cls.xlsx = os.path.join(cls.tmp, "presupuesto.xlsx")
        cls.pptx = os.path.join(cls.tmp, "defensa.pptx")
        cls.long_docx = os.path.join(cls.tmp, "tesis_larga.docx")
        fixed = os.environ.get("SIRA_FIXTURES_DIR")
        if fixed:  # fixtures binarios versionados (CI sin python-docx/openpyxl/python-pptx)
            for name, dst in (("tesis_demo.docx", cls.docx), ("presupuesto_demo.xlsx", cls.xlsx),
                              ("defensa_demo.pptx", cls.pptx), ("tesis_larga_demo.docx", cls.long_docx)):
                shutil.copy(os.path.join(fixed, name), dst)
        else:
            make_fixtures.make_docx(cls.docx)
            make_fixtures.make_xlsx(cls.xlsx)
            make_fixtures.make_pptx(cls.pptx)
            make_fixtures.make_long_docx(cls.long_docx)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def out(self, name):
        return os.path.join(self.tmp, f"{self.id().split('.')[-1]}-{name}")


# ───────────────────────────── WORD ─────────────────────────────
class TestDocx(Base):
    def para(self, path, i):
        return so.docx_paragraphs(so.OfficePackage(path))[i]

    def test_split_run_replace_keeps_red_run(self):
        dst = self.out("a.docx")
        res = so.edit(self.docx, dst, [{"op": "replace_text", "find": "2024", "replace": "2025", "paragraph": 8}])
        self.assertTrue(res["ok"], res)
        p = self.para(dst, 8)
        self.assertEqual(so.docx_para_text(p), "Lima, 2025\n")
        runs = [r for r in p.iter(W("r")) if r.find(W("t")) is not None]
        self.assertEqual([r.find(W("t")).text for r in runs], ["Lima, 20", "25"])
        self.assertEqual(runs[1].find(f"{W('rPr')}/{W('color')}").get(W("val")), "C00000")  # el rojo sigue
        self.assertIsNotNone(runs[1].find(f"{W('rPr')}/{W('b')}"))

    def test_only_document_xml_changes(self):
        dst = self.out("b.docx")
        so.edit(self.docx, dst, [{"op": "replace_text", "find": "2024", "replace": "2025", "paragraph": 8}])
        a, b = parts(self.docx), parts(dst)
        self.assertEqual(sorted(a), sorted(b))
        self.assertEqual([n for n in a if a[n] != b[n]], ["word/document.xml"])

    def test_italic_run_survives_number_change(self):
        dst = self.out("c.docx")
        res = so.edit(self.docx, dst, [{"op": "replace_text", "find": "un 18 %", "replace": "un 21 %", "paragraph": 11}])
        self.assertTrue(res["ok"], res)
        p = self.para(dst, 11)
        italic = [r for r in p.iter(W("r")) if r.find(f"{W('rPr')}/{W('i')}") is not None]
        self.assertEqual(italic[0].find(W("t")).text, "aumentó")
        self.assertIn("un 21 % respecto", so.docx_para_text(p))

    def test_ambiguous_find_is_rejected(self):
        res = so.edit(self.docx, self.out("d.docx"), [{"op": "replace_text", "find": "cal", "replace": "CAL"}])
        self.assertFalse(res["ok"])
        self.assertIn("veces", res["errors"][0]["error"])
        self.assertFalse(os.path.exists(self.out("d.docx")))

    def test_atomic_when_one_op_fails(self):
        dst = self.out("e.docx")
        res = so.edit(self.docx, dst, [
            {"op": "replace_text", "find": "2024", "replace": "2025", "paragraph": 8},
            {"op": "replace_text", "find": "texto que no existe", "replace": "x"},
        ])
        self.assertFalse(res["ok"])
        self.assertFalse(res["written"])
        self.assertFalse(os.path.exists(dst))

    def test_citation_field_is_protected(self):
        res = so.edit(self.docx, self.out("f.docx"), [{"op": "replace_text", "find": "García", "replace": "Garcia", "paragraph": 12}])
        self.assertFalse(res["ok"])
        self.assertIn("campo", res["errors"][0]["error"])

    def test_paraphrase_keeps_citation_field(self):
        dst = self.out("g.docx")
        new = ("Investigaciones anteriores indican que la cal disminuye el índice de plasticidad de las arcillas "
               "(García, 2020) y facilita su manejo en obra.")
        res = so.edit(self.docx, dst, [{"op": "set_paragraph_text", "paragraph": 12, "text": new}])
        self.assertTrue(res["ok"], res)
        p = self.para(dst, 12)
        self.assertEqual(so.docx_para_text(p), new)
        kinds = [f.get(W("fldCharType")) for f in p.iter(W("fldChar"))]
        self.assertEqual(kinds, ["begin", "separate", "end"])
        self.assertIn("CSL_CITATION", "".join(t.text for t in p.iter(W("instrText"))))

    def test_set_format_on_fragment_splits_runs(self):
        dst = self.out("h.docx")
        res = so.edit(self.docx, dst, [{"op": "set_format", "paragraph": 10, "find": "baja capacidad portante", "bold": True}])
        self.assertTrue(res["ok"], res)
        p = self.para(dst, 10)
        bold = ["".join(t.text for t in r.iter(W("t"))) for r in p.iter(W("r")) if r.find(f"{W('rPr')}/{W('b')}") is not None]
        self.assertEqual(bold, ["baja capacidad portante"])
        self.assertEqual(so.docx_para_text(p), BODY)

    def test_tracked_change(self):
        dst = self.out("i.docx")
        res = so.edit(self.docx, dst, [{"op": "replace_text", "find": "2024", "replace": "2025", "paragraph": 8}],
                      track_changes=True)
        self.assertTrue(res["ok"], res)
        p = self.para(dst, 8)
        dels, inss = list(p.iter(W("del"))), list(p.iter(W("ins")))
        self.assertEqual(len(dels), 1)
        self.assertEqual(len(inss), 1)
        self.assertEqual("".join(t.text for t in dels[0].iter(W("delText"))), "4")
        self.assertEqual("".join(t.text for t in inss[0].iter(W("t"))), "5")
        self.assertEqual(inss[0].get(W("author")), "SiraGPT")
        self.assertEqual(so.docx_para_text(p), "Lima, 2025\n")  # texto visible "aceptado"

    def test_insert_paragraph_clones_format(self):
        dst = self.out("j.docx")
        res = so.edit(self.docx, dst, [{"op": "insert_paragraph_after", "paragraph": 13, "text": "Párrafo añadido."}])
        self.assertTrue(res["ok"], res)
        ref, new = self.para(dst, 13), self.para(dst, 14)
        self.assertEqual(so.docx_para_text(new), "Párrafo añadido.")
        self.assertEqual(etree.tostring(ref.find(W("pPr"))), etree.tostring(new.find(W("pPr"))))

    def test_set_cell_text(self):
        dst = self.out("k.docx")
        res = so.edit(self.docx, dst, [{"op": "set_cell_text", "table": 0, "row": 3, "col": 1, "text": "15,1"}])
        self.assertTrue(res["ok"], res)
        tbl = next(so.OfficePackage(dst).xml("word/document.xml").iter(W("tbl")))
        cell = [c for c in [r for r in tbl if r.tag == W("tr")][3] if c.tag == W("tc")][1]
        self.assertEqual(so.docx_para_text(cell.find(W("p"))), "15,1")

    def test_paragraph_format_mm(self):
        dst = self.out("l.docx")
        res = so.edit(self.docx, dst, [{"op": "set_paragraph_format", "paragraph": 10, "first_line_mm": 10, "line_spacing": 2}])
        self.assertTrue(res["ok"], res)
        ppr = self.para(dst, 10).find(W("pPr"))
        self.assertEqual(ppr.find(W("ind")).get(W("firstLine")), str(so.mm_to_twips(10)))
        self.assertEqual(ppr.find(W("spacing")).get(W("line")), "480")
        order = [c.tag for c in ppr]
        self.assertLess(order.index(W("spacing")), order.index(W("ind")))  # orden del esquema
        self.assertLess(order.index(W("ind")), order.index(W("jc")))


    def test_tab_bookmark_and_prooferr_survive(self):
        src = self.out("edge-src.docx")
        pkg = so.OfficePackage(self.docx)
        p = so.docx_paragraphs(pkg)[10]
        r = p.find(W("r"))
        t = r.find(W("t"))
        rest = t.text[len("El suelo "):]
        t.text = "El suelo"
        etree.SubElement(r, W("tab"))
        r2 = etree.Element(W("r"))
        etree.SubElement(r2, W("t")).text = rest
        pe = etree.Element(W("proofErr")); pe.set(W("type"), "spellStart")
        bm = etree.Element(W("bookmarkStart")); bm.set(W("id"), "77"); bm.set(W("name"), "_Toc1")
        r.addnext(pe); pe.addnext(bm); bm.addnext(r2)
        pkg.touch("word/document.xml"); pkg.save(src)
        dst = self.out("edge-dst.docx")
        res = so.edit(src, dst, [
            {"op": "replace_text", "paragraph": 10, "find": "suelo\tarcilloso", "replace": "terreno arcilloso"},
            {"op": "replace_text", "paragraph": 10, "find": "de la zona", "replace": "de la zona norte"},
        ])
        self.assertTrue(res["ok"], res)
        p2 = self.para(dst, 10)
        self.assertTrue(so.docx_para_text(p2).startswith("El terreno arcilloso de la zona norte presenta"))
        self.assertIsNotNone(p2.find(W("bookmarkStart")))
        self.assertIsNotNone(p2.find(W("proofErr")))

# ───────────────────────────── EXCEL ─────────────────────────────
class TestXlsx(Base):
    def cell(self, path, sheet, ref):
        pkg = so.OfficePackage(path)
        part = so._xl_sheet_part(pkg, sheet)
        return so._xl_get_cell(pkg.xml(part), ref, create=False), pkg

    def test_set_number_keeps_style_and_marks_recalc(self):
        dst = self.out("a.xlsx")
        c0, _ = self.cell(self.xlsx, "Presupuesto", "C3")
        res = so.edit(self.xlsx, dst, [{"op": "set_cell", "sheet": "Presupuesto", "ref": "C3", "value": 99.5}])
        self.assertTrue(res["ok"], res)
        c1, pkg = self.cell(dst, "Presupuesto", "C3")
        self.assertEqual(c1.get("s"), c0.get("s"))
        self.assertEqual(c1.find(so.S("v")).text, "99.5")
        self.assertEqual(pkg.xml("xl/workbook.xml").find(so.S("calcPr")).get("fullCalcOnLoad"), "1")

    def test_set_text_uses_shared_strings(self):
        dst = self.out("b.xlsx")
        res = so.edit(self.xlsx, dst, [{"op": "set_cell", "sheet": "Presupuesto", "ref": "A5", "value": "Cal viva (bolsa 25 kg)"}])
        self.assertTrue(res["ok"], res)
        c, pkg = self.cell(dst, "Presupuesto", "A5")
        self.assertEqual(so._xl_cell_value(c, so._xl_shared_strings(pkg))[0], "Cal viva (bolsa 25 kg)")

    def test_new_row_and_formula(self):
        dst = self.out("c.xlsx")
        res = so.edit(self.xlsx, dst, [
            {"op": "set_cell", "sheet": "Presupuesto", "ref": "A8", "value": "Nota"},
            {"op": "set_cell", "sheet": "Presupuesto", "ref": "D8", "formula": "=D6*1.18"},
        ])
        self.assertTrue(res["ok"], res)
        pkg = so.OfficePackage(dst)
        root = pkg.xml(so._xl_sheet_part(pkg, "Presupuesto"))
        self.assertEqual([r.get("r") for r in root.iter(so.S("row"))], ["1", "2", "3", "4", "5", "6", "8"])
        self.assertEqual(root.find(so.S("dimension")).get("ref"), "A1:D8")

    def test_style_derivation_does_not_touch_other_cells(self):
        dst = self.out("d.xlsx")
        before_c2, _ = self.cell(self.xlsx, "Presupuesto", "C2")
        res = so.edit(self.xlsx, dst, [{"op": "set_cell_style", "sheet": "Presupuesto", "range": "C3", "fill": "FFF2CC", "bold": True}])
        self.assertTrue(res["ok"], res)
        c3, pkg = self.cell(dst, "Presupuesto", "C3")
        c2, _ = self.cell(dst, "Presupuesto", "C2")
        self.assertEqual(c2.get("s"), before_c2.get("s"))
        st = so.XlStyles(pkg).describe(int(c3.get("s")))
        self.assertEqual(st.get("fill"), "FFF2CC")
        self.assertTrue(st.get("bold"))
        self.assertEqual(st.get("numfmt"), "#,##0.00")  # conserva el formato numérico que ya tenía

    def test_bad_sheet_name(self):
        res = so.edit(self.xlsx, self.out("e.xlsx"), [{"op": "set_cell", "sheet": "Hoja9", "ref": "A1", "value": 1}])
        self.assertFalse(res["ok"])
        self.assertIn("Presupuesto", res["errors"][0]["error"])

    @unittest.skipUnless(HAS_LO, "LibreOffice/poppler no disponibles")
    def test_recalculated_values(self):
        dst = self.out("f.xlsx")
        so.edit(self.xlsx, dst, [{"op": "set_cell", "sheet": "Presupuesto", "ref": "B2", "value": 5}])
        before = parts(dst)
        vals = so.recalc_values(dst, ["Presupuesto!D2", "Presupuesto!D6", "Resumen!B1"])
        self.assertEqual(vals["Presupuesto!D2"], 900)
        self.assertEqual(vals["Presupuesto!D6"], 900 + 380 + 720 + 231)
        self.assertEqual(vals["Resumen!B1"], 2231)
        self.assertEqual(parts(dst), before, "consultar resultados no debe modificar el documento")

    def test_formula_cache_types_and_shared_array_metadata(self):
        dst, recalculated = self.out("cache.xlsx"), self.out("calculated.xlsx")
        original = so.OfficePackage(self.xlsx)
        sheet = so._xl_sheet_part(original, "Presupuesto")
        for other in so.xl_sheets(original):
            if other['part'] != sheet:
                # This cache-type fixture has formulas only in Presupuesto.
                original.data[other['part']] = re.sub(rb'<f(?:\s[^>]*)?(?:/>|>.*?</f>)', b'', original.data[other['part']])
        header = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x="urn:fixture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x"><sheetData>'
        body = '''<row r="1"><c r="A1" s="1"><f t="shared" ref="A1:A2" si="7"><![CDATA[B1*2]]></f><v>0</v></c><c x:hint="note r='A1' t='str' > text" r="B1"><v>4</v></c><c x:hint="note t='s' > text" r="C1" t="str"><f>"A&amp;B"</f><x:v>999</x:v><v>antiguo</v></c><c r="D1" t="b"><f>TRUE()</f><v>0</v></c><c r="E1" t="e"><f>1/0</f><v>#N/A</v></c><c r="F1"><f t="shared" ref="F1:F3" si="8">B1*5</f><v>0</v></c></row>
<row r="2"><c r="A2"><f t="shared" si="7"/><v>0</v></c><c r="B2"><v>5</v></c><c r="C2" t="str"><f>""</f><v>antiguo</v></c><c r="F2" t="inlineStr"><is><t>Etiqueta intacta</t></is></c></row>
<row r="3"><c r="A3"><f t="array" ref="A3:A4">B1:B2*3</f><v>0</v></c><c r="F3"><f t="shared" si="8"/><v>0</v></c></row><row r="4"><c r="A4"/></row>'''
        pi = '<?note <c r="A1"><f>fake</f><v>777</v></c>?>'
        foreign = '<extLst><ext uri="fixture"><x:c r="A1"><x:f>fake</x:f><x:v>666</x:v></x:c></ext></extLst>'
        original.data[sheet] = (header + pi + body + '</sheetData>' + foreign + '</worksheet>').encode()
        original.save(dst)
        computed = so.OfficePackage(dst)
        computed.data[sheet] = (header + '''<row r="1"><c r="A1"><v>8</v></c><c r="C1" t="s"><v>0</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#DIV/0!</v></c><c r="F1"><v>20</v></c></row>
<row r="2"><c r="A2"><v>10</v></c><c r="C2" t="str"><v/></c><c r="F2" t="str"><v>Otro texto</v></c></row><row r="3"><c r="A3"><v>12</v></c><c r="F3"><v>24</v></c></row><row r="4"><c r="A4"><v>15</v></c></row></sheetData></worksheet>''').encode()
        computed.data['xl/sharedStrings.xml'] = b'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>A&amp;B</t></si></sst>'
        if not any(i.filename == 'xl/sharedStrings.xml' for i in computed.infos):
            computed.infos.append(zipfile.ZipInfo('xl/sharedStrings.xml'))
        computed.save(recalculated)
        before = parts(dst)
        result = so._sync_formula_caches(dst, so.OfficePackage(recalculated))
        after = parts(dst)
        self.assertEqual(result['updated'], 10)
        self.assertEqual(set(after), set(before), "no copiar partes de LibreOffice ni su tabla de strings")
        for name in before:
            if name != sheet:
                self.assertEqual(after[name], before[name], name)
        self.assertEqual(re.findall(rb'<f(?:\s[^>]*?)?(?:/>|>.*?</f>)', after[sheet]),
                         re.findall(rb'<f(?:\s[^>]*?)?(?:/>|>.*?</f>)', before[sheet]))
        root = etree.fromstring(after[sheet])
        expected = {'A1': ('n', '8'), 'A2': ('n', '10'), 'A3': ('n', '12'), 'A4': ('n', '15'),
                    'C1': ('str', 'A&B'), 'C2': ('str', ''), 'D1': ('b', '1'), 'E1': ('e', '#DIV/0!'),
                    'F1': ('n', '20'), 'F3': ('n', '24')}
        for ref, (kind, value) in expected.items():
            cell = root.find(f'.//{so.S("c")}[@r="{ref}"]')
            self.assertEqual(cell.get('t', 'n'), kind, ref)
            self.assertEqual(cell.find(so.S('v')).text or '', value, ref)
        self.assertEqual(root.find(f'.//{so.S("c")}[@r="A1"]').get('s'), '1')
        self.assertIn(b'<c x:hint="note r=\'A1\' t=\'str\' > text" r="B1"><v>4</v></c>', after[sheet])
        self.assertIn(b'x:hint="note t=\'s\' > text" r="C1" t="str"', after[sheet])
        self.assertIn(pi.encode(), after[sheet], 'las instrucciones XML son datos intactos')
        self.assertIn(foreign.encode(), after[sheet], 'los metadatos de otro namespace no son celdas')
        self.assertIn(b'<x:v>999</x:v>', after[sheet], 'sólo el v directo del namespace Excel se recalcula')
        self.assertIn(b'<![CDATA[B1*2]]>', after[sheet])
        self.assertIn(b'<c r="B2"><v>5</v></c>', after[sheet])
        self.assertIn(b'<c r="F2" t="inlineStr"><is><t>Etiqueta intacta</t></is></c>', after[sheet],
                      "un rango shared no autoriza modificar celdas que el usuario convirtió a texto")

    def test_invalid_formula_cache_does_not_write_partial_workbook(self):
        dst = self.out('invalid-cache.xlsx')
        shutil.copy(self.xlsx, dst)
        before = parts(dst)
        computed = so.OfficePackage(dst)  # fixture formula caches are empty
        with self.assertRaises(so.EditError):
            so._sync_formula_caches(dst, computed)
        self.assertEqual(parts(dst), before)

    def test_implicit_or_duplicate_formula_references_fail_without_writing(self):
        for cell_xml in ('<c><f>2*2</f><v>0</v></c>',
                         '<c r="A1"><f t="array" ref="A1:B1">{4,5}</f><v>0</v></c><c><v>0</v></c>',
                         '<c r="A1"><f>2*2</f><v>0</v></c><c r="A1"><f>3*3</f><v>0</v></c>'):
            with self.subTest(cells=cell_xml):
                dst = self.out('unmapped-cache.xlsx')
                pkg = so.OfficePackage(self.xlsx)
                sheet = so._xl_sheet_part(pkg, 'Presupuesto')
                pkg.data[sheet] = ('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                                   '<sheetData><row r="1">' + cell_xml + '</row></sheetData></worksheet>').encode()
                pkg.save(dst)
                before = parts(dst)
                with self.assertRaisesRegex(so.EditError, 'implícitas|duplicada'):
                    so._sync_formula_caches(dst, so.OfficePackage(self.xlsx))
                self.assertEqual(parts(dst), before, 'un resultado no localizable nunca permite guardar el libro')


# ─────────────────────────── POWERPOINT ───────────────────────────
class TestPptx(Base):
    def test_replace_keeps_run_format(self):
        dst = self.out("a.pptx")
        res = so.edit(self.pptx, dst, [{"op": "replace_text", "slide": 1, "find": "2024", "replace": "2025"}])
        self.assertTrue(res["ok"], res)
        info = so.inspect(dst, slide=1)
        self.assertIn("Sustentación 2025", info["slides"][0]["shapes"][1]["text"])

    def test_move_2mm_is_72000_emu(self):
        dst = self.out("b.pptx")
        res = so.edit(self.pptx, dst, [{"op": "set_geometry", "slide": 2, "shape": "Nota", "dx_mm": 2}])
        self.assertTrue(res["ok"], res)
        b = res["applied"][0]
        self.assertAlmostEqual(b["after"]["x_mm"] - b["before"]["x_mm"], 2.0, places=2)
        pkg = so.OfficePackage(dst)
        el, _, _ = so._pp_find_shape(pkg, so._pp_slide_part(pkg, 2), "Nota")
        self.assertEqual(int(so._pp_xfrm(el).find(so.A("off")).get("x")), so.mm_to_emu(172) + 72000)

    def test_inherited_placeholder_gets_explicit_xfrm(self):
        dst = self.out("c.pptx")
        res = so.edit(self.pptx, dst, [{"op": "set_geometry", "slide": 2, "shape": "Title 1", "dy_mm": 5}])
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["applied"][0]["inherited_position_made_explicit"])
        after = so.inspect(dst, slide=2)["slides"][0]["shapes"][0]
        self.assertNotIn("inherited_position", after)
        self.assertAlmostEqual(after["y_mm"], 7.63 + 5, places=1)

    def test_group_transform_roundtrip(self):
        # grupo escalado al 150 %: las coordenadas de los hijos NO son las de la lámina
        src = self.out("group-src.pptx")
        pkg = so.OfficePackage(self.pptx)
        part = so._pp_slide_part(pkg, 3)
        grp, _, _ = so._pp_find_shape(pkg, part, "Montaje")
        ext = so._pp_xfrm(grp).find(so.A("ext"))
        ext.set("cx", str(int(int(ext.get("cx")) * 1.5)))
        pkg.touch(part)
        pkg.save(src)
        shapes = {s["name"]: s for s in so.inspect(src, slide=3)["slides"][0]["shapes"]}
        self.assertAlmostEqual(shapes["Prensa"]["x_mm"], 40 + (120 - 40) * 1.5, places=1)
        dst = self.out("group-dst.pptx")
        res = so.edit(src, dst, [{"op": "set_geometry", "slide": 3, "shape": "Prensa", "x_mm": 200}])
        self.assertTrue(res["ok"], res)
        again = {s["name"]: s for s in so.inspect(dst, slide=3)["slides"][0]["shapes"]}
        self.assertAlmostEqual(again["Prensa"]["x_mm"], 200, places=1)

    def test_fill_and_multiline_text(self):
        dst = self.out("d.pptx")
        res = so.edit(self.pptx, dst, [
            {"op": "set_fill", "slide": 2, "shape": "Nota", "color": "#C00000"},
            {"op": "set_shape_text", "slide": 2, "shape": "Content Placeholder 2",
             "text": "El CBR sube de 4,2 % a 14,6 % con 5 % de cal\nEl índice de plasticidad baja de 24 a 9"},
        ])
        self.assertTrue(res["ok"], res)
        shapes = {s["name"]: s for s in so.inspect(dst, slide=2)["slides"][0]["shapes"]}
        self.assertEqual(shapes["Nota"]["fill"], "C00000")
        self.assertEqual(shapes["Content Placeholder 2"]["text"].count("\n"), 1)


    def test_replace_across_line_break(self):
        import copy as _copy
        src = self.out("br-src.pptx")
        pkg = so.OfficePackage(self.pptx)
        part = so._pp_slide_part(pkg, 2)
        el, _, _ = so._pp_find_shape(pkg, part, "Nota")
        ap = next(el.iter(so.A("p")))
        r = ap.find(so.A("r"))
        r.find(so.A("t")).text = "Cumple el Manual"
        br = etree.Element(so.A("br"))
        r2 = _copy.deepcopy(r); r2.find(so.A("t")).text = "de Carreteras"
        r.addnext(br); br.addnext(r2)
        pkg.touch(part); pkg.save(src)
        dst = self.out("br-dst.pptx")
        res = so.edit(src, dst, [{"op": "replace_text", "slide": 2, "shape": "Nota", "find": "Manual\n", "replace": "Manual\n(MTC) "}])
        self.assertTrue(res["ok"], res)
        text = [s for s in so.inspect(dst, slide=2)["slides"][0]["shapes"] if s["name"] == "Nota"][0]["text"]
        self.assertEqual(text, "Cumple el Manual\n(MTC) de Carreteras")
        for r in so.OfficePackage(dst).xml(part).iter(so.A("r")):  # todo a:r conserva su a:t
            self.assertIsNotNone(r.find(so.A("t")))

# ─────────────────────── RENDER Y VERIFICACIÓN ───────────────────────
@unittest.skipUnless(HAS_LO, "LibreOffice/poppler no disponibles")
class TestVerify(Base):
    def test_render_all_pages(self):
        res = so.render(self.docx, self.out("render"), dpi=80)
        self.assertGreaterEqual(res["page_count"], 2)
        self.assertEqual(len(res["pages"]), res["page_count"])
        self.assertTrue(all(os.path.exists(p["png"]) for p in res["pages"]))

    def test_identical_copy_has_no_visual_change(self):
        copy_path = self.out("copia.docx")
        shutil.copy(self.docx, copy_path)
        rep = so.verify(self.docx, copy_path, self.out("v0"), dpi=80)
        self.assertEqual(rep["visual"]["pages_changed"], [])
        self.assertEqual(rep["parts"]["changed"], [])

    def test_verify_finds_the_date_zone(self):
        dst = self.out("fecha.docx")
        so.edit(self.docx, dst, [{"op": "replace_text", "find": "2024", "replace": "2025", "paragraph": 8}])
        rep = so.verify(self.docx, dst, self.out("v1"), dpi=100,
                        expect={"contains": [{"text": "Lima, 2025", "page": 1}], "not_contains": [{"text": "2024", "page": 1}],
                                "only_pages": [1], "allowed_parts": ["word/document.xml"]})
        self.assertTrue(rep["ok"], rep["summary"])
        self.assertEqual(rep["visual"]["pages_changed"], [1])
        box = rep["visual"]["pages"][0]["boxes_mm"][0]
        self.assertTrue(130 < box["y"] < 170, box)  # la línea «Lima, 2025» de la portada
        self.assertLess(box["w"], 8)                 # solo cambió el último dígito (≈ 3 mm)
        self.assertTrue(os.path.exists(rep["composites"][0]))

    def test_verify_flags_failed_expectation(self):
        dst = self.out("fecha2.docx")
        so.edit(self.docx, dst, [{"op": "replace_text", "find": "2024", "replace": "2025", "paragraph": 8}])
        rep = so.verify(self.docx, dst, self.out("v2"), dpi=80, expect={"contains": [{"text": "2026", "page": 1}]})
        self.assertFalse(rep["ok"])
        self.assertIn("✗", rep["summary"])

    def test_xlsx_verify_with_recalc(self):
        dst = self.out("pres.xlsx")
        so.edit(self.xlsx, dst, [{"op": "set_cell", "sheet": "Presupuesto", "ref": "B4", "value": 15}])
        pkg = so.OfficePackage(dst)
        sheet = so._xl_sheet_part(pkg, 'Presupuesto')
        fake_cell = b'<!-- <c r="D4"><f>B4*C4</f><v>123456</v></c> -->'
        fake_value = b'<!-- <v>876543</v> -->'
        pkg.data[sheet] = re.sub(rb'(<c r="D4"[^>]*>)', lambda m: m.group(0) + fake_value, pkg.data[sheet])
        pkg.data[sheet] = pkg.data[sheet].replace(b'<sheetData>', b'<sheetData>' + fake_cell)
        pkg.save(dst)
        edited = parts(dst)
        rep = so.verify(self.xlsx, dst, self.out("v3"), dpi=80,
                        expect={"cells": {"Presupuesto!D4": 900, "Presupuesto!D6": 2231, "Resumen!B1": 2231}},
                        persist_formula_cache=True)
        self.assertTrue(rep["ok"], rep["summary"])
        delivered = parts(dst)
        self.assertIn(fake_cell, delivered[sheet])
        self.assertIn(fake_value, delivered[sheet])
        self.assertGreater(rep['formula_cache']['updated'], 0)
        for name in edited:
            if name not in rep['formula_cache']['parts']:
                self.assertEqual(delivered[name], edited[name], name)
            else:
                # The original formulas (including attributes) and every
                # other byte survive; only <v> results are inserted/replaced.
                strip_values = lambda xml: re.sub(rb'<v(?:\s[^>]*)?(?:/>|>.*?</v>)', b'', xml)
                self.assertEqual(strip_values(delivered[name]), strip_values(edited[name]), name)
        for name, values in (('Presupuesto', {'D4': '900', 'D6': '2231'}), ('Resumen', {'B1': '2231'})):
            pkg = so.OfficePackage(dst)
            root = pkg.xml(so._xl_sheet_part(pkg, name))
            for ref, expected in values.items():
                cell = root.find(f'.//{so.S("c")}[@r="{ref}"]')
                self.assertEqual(cell.find(so.S('v')).text, expected)

    def test_failed_xlsx_verification_does_not_persist_caches(self):
        dst = self.out('wrong-pres.xlsx')
        so.edit(self.xlsx, dst, [{"op": "set_cell", "sheet": "Presupuesto", "ref": "B4", "value": 15}])
        before = parts(dst)
        rep = so.verify(self.xlsx, dst, self.out('v-wrong'), dpi=60,
                        expect={"cells": {"Presupuesto!D6": 1}}, persist_formula_cache=True)
        self.assertFalse(rep['ok'])
        self.assertNotIn('formula_cache', rep)
        self.assertEqual(parts(dst), before)

    def test_long_document_fast_scan(self):
        paras = so.docx_paragraphs(so.OfficePackage(self.long_docx))
        target = next(i for i, p in enumerate(paras) if so.docx_para_text(p).startswith("[5.7] "))
        dst = self.out("larga.docx")
        res = so.edit(self.long_docx, dst, [{"op": "replace_text", "paragraph": target, "find": "[5.7] ", "replace": "[5.7-rev] "}])
        self.assertTrue(res["ok"], res)
        rep = so.verify(self.long_docx, dst, self.out("v-larga"), dpi=90)
        v = rep["visual"]
        self.assertGreater(v["page_count_after"], 12)
        self.assertTrue(v["fast_scan"])
        self.assertEqual(len(v["pages_changed"]), 1, rep["summary"])
        self.assertTrue(rep["composites"] and os.path.exists(rep["thumbs"][0]))

    def test_new_document_mode(self):
        rep = so.verify(None, self.pptx, self.out("v-nuevo"), dpi=60, expect={"contains": ["Resultados"]})
        self.assertTrue(rep["ok"], rep["summary"])
        self.assertTrue(rep["visual"]["new_document"])
        self.assertTrue(rep["composites"][0].endswith("contact.png"))

    def test_kerning_shift_is_not_a_content_change(self):
        # colorear solo el inicio del título parte el run: LibreOffice re-posiciona glifos sub-píxel
        dst = self.out("parcial.docx")
        so.edit(self.docx, dst, [{"op": "set_format", "paragraph": 3, "find": "ADICIÓN DE CAL", "color": "1F3864"}])
        rep = so.verify(self.docx, dst, self.out("v-kerning"), dpi=110)
        page = rep["visual"]["pages"][0]
        self.assertEqual(page["status"], "cambió")
        self.assertEqual(page["zones"], 1, rep["summary"])          # solo «ADICIÓN DE CAL» en azul
        self.assertGreaterEqual(page.get("micro_zones", 0), 1)      # el resto: micro-desplazamientos
        self.assertIn("micro-desplazamiento", rep["summary"])

    def test_cli_roundtrip(self):
        dst = self.out("cli.pptx")
        import json
        r = subprocess.run([sys.executable, so.__file__, "edit",
                            json.dumps({"src": self.pptx, "dst": dst, "ops": [{"op": "set_fill", "slide": 2, "shape": "Nota", "color": "2E7D32"}]})],
                           capture_output=True, text=True, timeout=120)
        out = json.loads(r.stdout)
        self.assertTrue(out["ok"], out)
        r = subprocess.run([sys.executable, so.__file__, "edit",
                            json.dumps({"src": self.pptx, "dst": dst, "ops": [{"op": "volar"}]})],
                           capture_output=True, text=True, timeout=120)
        self.assertFalse(json.loads(r.stdout)["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
