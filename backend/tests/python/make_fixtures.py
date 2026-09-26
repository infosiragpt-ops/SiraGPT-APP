#!/usr/bin/env python3
"""Genera documentos de ejemplo realistas (ficticios) para probar sira_office.py.

Solo este script usa python-docx / openpyxl / python-pptx; el módulo de referencia no los necesita.
"""
import os
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Mm
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from pptx import Presentation
from pptx.dml.color import RGBColor as PRGB
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Mm as PMm, Pt as PPt

BODY = ("El suelo arcilloso de la zona presenta baja capacidad portante y alta plasticidad, lo que limita su uso "
        "como subrasante en vías rurales. La estabilización con cal es una alternativa de bajo costo que reduce "
        "la plasticidad y mejora la resistencia mecánica del material.")
BODY2 = ("Se ensayaron especímenes con 0 %, 3 %, 5 % y 7 % de cal hidratada, curados durante 7, 14 y 28 días. "
         "Los resultados se compararon con los requisitos del Manual de Carreteras para subrasantes.")


def _field_run(paragraph, instr, result):
    """Inserta un campo complejo (como las citas de Mendeley/Zotero)."""
    def run_with(child):
        r = OxmlElement("w:r")
        r.append(child)
        paragraph._p.append(r)
        return r
    b = OxmlElement("w:fldChar"); b.set(qn("w:fldCharType"), "begin"); run_with(b)
    it = OxmlElement("w:instrText"); it.set(qn("xml:space"), "preserve"); it.text = instr; run_with(it)
    s = OxmlElement("w:fldChar"); s.set(qn("w:fldCharType"), "separate"); run_with(s)
    r = OxmlElement("w:r"); t = OxmlElement("w:t"); t.text = result; r.append(t); paragraph._p.append(r)
    e = OxmlElement("w:fldChar"); e.set(qn("w:fldCharType"), "end"); run_with(e)


def make_docx(path):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.left_margin = sec.right_margin = Mm(30)
    sec.top_margin = sec.bottom_margin = Mm(25)
    st = doc.styles["Normal"]
    st.font.name = "Times New Roman"
    st.font.size = Pt(12)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), "Times New Roman")

    def center(text, size=12, bold=False, space_after=6):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(space_after)
        r = p.add_run(text)
        r.bold = bold
        r.font.size = Pt(size)
        return p

    center("UNIVERSIDAD DEL EJEMPLO", 16, True, 4)                      # 0
    center("FACULTAD DE INGENIERÍA", 13, True, 4)                        # 1
    center("Carrera de Ingeniería Civil", 12, False, 48)                 # 2
    center("ADICIÓN DE CAL EN LAS PROPIEDADES MECÁNICAS DEL SUELO NATURAL", 14, True, 36)  # 3
    center("Tesis para optar el título profesional de:", 12, False, 2)   # 4
    center("Ingeniero Civil", 12, True, 36)                              # 5
    center("Autor: Juan Pérez Rojas", 12, False, 2)                      # 6
    center("Asesor: Mg. Ana Torres Díaz", 12, False, 60)                 # 7
    p = doc.add_paragraph()                                              # 8: «Lima, 20» + «24» (rojo) = runs partidos
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r1 = p.add_run("Lima, 20"); r1.bold = True
    r2 = p.add_run("24"); r2.bold = True; r2.font.color.rgb = RGBColor(0xC0, 0x00, 0x00)
    p.add_run().add_break(WD_BREAK.PAGE)

    h = doc.add_heading("I. INTRODUCCIÓN", level=1)                       # 9
    for run in h.runs:
        run.font.name = "Times New Roman"; run.font.color.rgb = RGBColor(0, 0, 0)

    def body(text):
        bp = doc.add_paragraph()
        bp.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        bp.paragraph_format.line_spacing = 1.5
        bp.paragraph_format.first_line_indent = Mm(12.5)
        bp.paragraph_format.space_after = Pt(6)
        bp.add_run(text)
        return bp

    body(BODY)                                                           # 10
    p = doc.add_paragraph()                                              # 11: runs con cursiva en medio
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.first_line_indent = Mm(12.5)
    p.add_run("Con 5 % de cal, la resistencia a la compresión no confinada ")
    it = p.add_run("aumentó"); it.italic = True
    p.add_run(" un 18 % respecto al suelo natural a los 28 días de curado.")
    p = doc.add_paragraph()                                              # 12: párrafo con cita (campo)
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.first_line_indent = Mm(12.5)
    p.add_run("Según estudios previos, la cal reduce el índice de plasticidad de las arcillas ")
    _field_run(p, ' ADDIN CSL_CITATION {"citationItems":[{"id":"garcia2020"}]} ', "(García, 2020)")
    p.add_run(" y mejora su trabajabilidad en obra.")
    body(BODY2)                                                          # 13
    doc.add_heading("Tabla 1. Resultados del ensayo CBR", level=2)       # 14
    t = doc.add_table(rows=4, cols=3)
    t.style = "Table Grid"
    rows = [("Cal (%)", "CBR (%)", "Índice de plasticidad"), ("0", "4,2", "24"), ("3", "9,8", "15"), ("5", "14,6", "9")]
    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            cell = t.cell(i, j)
            cell.text = val
            if i == 0:
                cell.paragraphs[0].runs[0].bold = True
    body("La tabla muestra que el CBR crece de forma sostenida con el contenido de cal hasta el 5 %.")
    doc.save(path)


def make_xlsx(path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Presupuesto"
    head_fill = PatternFill("solid", fgColor="1F4E78")
    thin = Side(style="thin", color="A6A6A6")
    ws.append(["Partida", "Cantidad", "Precio unitario (S/)", "Subtotal (S/)"])
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = head_fill
        c.alignment = Alignment(horizontal="center")
    items = [("Ensayo CBR", 4, 180.0), ("Límites de Atterberg", 4, 95.0), ("Compresión no confinada", 12, 60.0),
             ("Cal hidratada (bolsa 25 kg)", 6, 38.5)]
    for i, (name, qty, price) in enumerate(items, start=2):
        ws.cell(row=i, column=1, value=name)
        ws.cell(row=i, column=2, value=qty)
        ws.cell(row=i, column=3, value=price).number_format = "#,##0.00"
        ws.cell(row=i, column=4, value=f"=B{i}*C{i}").number_format = "#,##0.00"
    ws.cell(row=6, column=1, value="TOTAL").font = Font(bold=True)
    tot = ws.cell(row=6, column=4, value="=SUM(D2:D5)")
    tot.number_format = "#,##0.00"
    tot.font = Font(bold=True)
    for row in ws.iter_rows(min_row=1, max_row=6, max_col=4):
        for c in row:
            c.border = Border(top=thin, bottom=thin, left=thin, right=thin)
    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 11
    ws.column_dimensions["C"].width = 20
    ws.column_dimensions["D"].width = 16
    ws2 = wb.create_sheet("Resumen")
    ws2["A1"] = "Costo total del estudio (S/)"
    ws2["A1"].font = Font(bold=True)
    ws2["B1"] = "=Presupuesto!D6"
    ws2["B1"].number_format = "#,##0.00"
    ws2.column_dimensions["A"].width = 30
    ws2.column_dimensions["B"].width = 16
    wb.save(path)


def make_pptx(path):
    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[0])
    s1.shapes.title.text = "Adición de cal en las propiedades mecánicas del suelo natural"
    s1.placeholders[1].text = "Juan Pérez Rojas · Sustentación 2024"
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = "Resultados"
    body = s2.placeholders[1].text_frame
    body.text = "El CBR sube de 4,2 % a 14,6 % con 5 % de cal"
    for line in ("El índice de plasticidad baja de 24 a 9", "La compresión no confinada aumenta un 18 %"):
        body.add_paragraph().text = line
    box = s2.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, PMm(172), PMm(150), PMm(70), PMm(25))
    box.name = "Nota"
    box.fill.solid(); box.fill.fore_color.rgb = PRGB(0x1F, 0x4E, 0x78)
    box.text_frame.text = "Cumple el Manual de Carreteras"
    for r in box.text_frame.paragraphs[0].runs:
        r.font.size = PPt(14); r.font.color.rgb = PRGB(0xFF, 0xFF, 0xFF)
    s3 = prs.slides.add_slide(prs.slide_layouts[5])
    s3.shapes.title.text = "Esquema del ensayo"
    a = s3.shapes.add_shape(MSO_SHAPE.RECTANGLE, PMm(40), PMm(70), PMm(60), PMm(40)); a.name = "Muestra"
    b = s3.shapes.add_shape(MSO_SHAPE.RECTANGLE, PMm(120), PMm(70), PMm(60), PMm(40)); b.name = "Prensa"
    grp = s3.shapes.add_group_shape([a, b]); grp.name = "Montaje"
    prs.save(path)


def make_long_docx(path, chapters=6, paras_per_chapter=14):
    """Tesis larga (~30 páginas) para probar el barrido rápido de verify."""
    make_docx(path)
    doc = Document(path)
    for c in range(2, chapters + 2):
        h = doc.add_heading(f"CAPÍTULO {c}. DESARROLLO {c}", level=1)
        for run in h.runs:
            run.font.name = "Times New Roman"; run.font.color.rgb = RGBColor(0, 0, 0)
        for k in range(paras_per_chapter):
            bp = doc.add_paragraph()
            bp.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            bp.paragraph_format.line_spacing = 1.5
            bp.paragraph_format.first_line_indent = Mm(12.5)
            bp.add_run(f"[{c}.{k + 1}] " + (BODY if k % 2 == 0 else BODY2))
    doc.save(path)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "fixtures"
    os.makedirs(out, exist_ok=True)
    make_docx(os.path.join(out, "tesis_demo.docx"))
    make_xlsx(os.path.join(out, "presupuesto_demo.xlsx"))
    make_pptx(os.path.join(out, "defensa_demo.pptx"))
    make_long_docx(os.path.join(out, "tesis_larga_demo.docx"))
    print("ok:", sorted(os.listdir(out)))
