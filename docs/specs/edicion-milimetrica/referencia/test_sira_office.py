#!/usr/bin/env python3
"""Pruebas de sira_office.py — correr con:  python3 -m unittest -v test_sira_office.py"""
import os
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
        vals = so.recalc_values(dst, ["Presupuesto!D2", "Presupuesto!D6", "Resumen!B1"])
        self.assertEqual(vals["Presupuesto!D2"], 900)
        self.assertEqual(vals["Presupuesto!D6"], 900 + 380 + 720 + 231)
        self.assertEqual(vals["Resumen!B1"], 2231)


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
        rep = so.verify(self.xlsx, dst, self.out("v3"), dpi=80, expect={"cells": {"Presupuesto!D6": 2231, "Resumen!B1": 2231}})
        self.assertTrue(rep["ok"], rep["summary"])

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
