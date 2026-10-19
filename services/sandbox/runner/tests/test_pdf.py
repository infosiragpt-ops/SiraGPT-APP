"""PDF deliverables: generate, convert, inspect, OCR, encrypt and sign PDFs.

Each test produces a PDF (or an image from one) with one tool and verifies it
with an independent reader: pypdf against reportlab, pdfplumber against a
ruled table, pikepdf against pypdf, the poppler/mupdf/ghostscript/qpdf CLIs
against the Python libraries, and tesseract on text we rendered ourselves.
Spanish text with accents and ñ travels through every step.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
TITULO = "Facturación anual — Región Andina"
FILAS = [["Producto", "Unidades", "Precio"], ["Café molido", "120", "18,50 €"], ["Té de jazmín", "80", "9,75 €"]]


def _reportlab_table_pdf(path: Path, pages: int = 1) -> Path:
    """Shared source PDF: heading, paragraph and a ruled (GRID) table, optional extra pages."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import (
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    styles = getSampleStyleSheet()
    story = [
        Paragraph(TITULO, styles["Heading1"]),
        Paragraph("Existencias al cierre del trimestre en el almacén de Málaga.", styles["Normal"]),
        Spacer(1, 14),
    ]
    table = Table(FILAS, colWidths=[150, 90, 90])
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.75, colors.black),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDEBF7")),
    ]))
    story.append(table)
    for index in range(2, pages + 1):
        story += [PageBreak(), Paragraph(f"Anexo {index}: notas adicionales con ñ y acentos.", styles["Normal"])]
    SimpleDocTemplate(str(path), pagesize=A4, title=TITULO, author="SiraGPT").build(story)
    return path


def _text_image(path: Path, text: str = "Facturación España 2026", size=(1400, 320)) -> Path:
    """A clean PNG with large rendered text, the input for OCR tests."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(DEJAVU, 72)
    draw.text((60, 110), text, fill="black", font=font)
    image.save(path, dpi=(200, 200))
    return path


# ------------------------------------------------------------------ generators


@pytest.mark.covers("reportlab", "pdfplumber")
def test_reportlab_table_read_back_by_pdfplumber(out, check):
    """reportlab builds a 2-page PDF with a ruled table; pdfplumber extracts the exact rows."""
    import pdfplumber

    pdf = _reportlab_table_pdf(out / "inventario.pdf", pages=2)
    check.nonempty(pdf, 1500)
    assert check.pdf_pages(pdf) == 2

    with pdfplumber.open(str(pdf)) as document:
        assert len(document.pages) == 2
        first = document.pages[0]
        text = first.extract_text()
        assert TITULO in text and "Málaga" in text
        tables = first.extract_tables()
        assert len(tables) == 1
        assert tables[0] == FILAS
        assert any(word["text"] == "Málaga." for word in first.extract_words())
        assert "Anexo 2" in document.pages[1].extract_text()
        assert document.metadata.get("Title") == TITULO


@pytest.mark.covers("fpdf", "pdfinfo", "pdftotext")
def test_fpdf_unicode_report_checked_by_poppler_cli(out, check):
    """fpdf2 writes a 2-page report with a TrueType font and a table; pdfinfo and pdftotext verify it."""
    from fpdf import FPDF
    from fpdf.fonts import FontFace

    pdf = FPDF()
    pdf.set_title("Informe de gestión")
    pdf.add_font("DejaVu", "", DEJAVU)
    pdf.set_font("DejaVu", size=14)
    pdf.add_page()
    pdf.cell(text="Informe de gestión — Año 2026", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("DejaVu", size=11)
    pdf.multi_cell(0, 6, "Resumen: la compañía abrió oficinas en Bogotá, Quito y A Coruña, con un equipo de 45 personas.")
    pdf.ln(4)
    with pdf.table(headings_style=FontFace(emphasis="", fill_color=(221, 235, 247))) as table:
        for row in FILAS:
            line = table.row()
            for cell in row:
                line.cell(cell)
    pdf.add_page()
    pdf.cell(text="Página dos: conclusiones y próximos pasos.")
    path = out / "gestion.pdf"
    pdf.output(str(path))
    check.nonempty(path, 5000)

    info = check.run(["pdfinfo", str(path)], timeout=30).stdout
    assert "Pages:" in info
    assert int(next(line.split()[-1] for line in info.splitlines() if line.startswith("Pages:"))) == 2
    assert "Informe de gestión" in info

    text = check.run(["pdftotext", "-layout", str(path), "-"], timeout=30).stdout
    assert "Año 2026" in text and "A Coruña" in text
    assert "Té de jazmín" in text and "9,75 €" in text
    assert "Página dos" in text
    assert check.pdf_pages(path) == 2


@pytest.mark.covers("weasyprint", "pymupdf")
def test_weasyprint_html_css_to_pdf_read_by_pymupdf(out, check):
    """WeasyPrint lays out HTML+CSS (page size, page break, table) into a 2-page PDF that PyMuPDF reads."""
    import pymupdf
    import weasyprint

    html = """<!doctype html><html lang="es"><head><meta charset="utf-8">
    <style>
      @page { size: A4; margin: 2cm; @bottom-center { content: "Página " counter(page); } }
      h1 { color: #1f3b73; font-family: 'DejaVu Sans', sans-serif; }
      table { border-collapse: collapse; } td, th { border: 1px solid #333; padding: 4px 10px; }
      .salto { page-break-before: always; }
    </style></head><body>
    <h1>Memoria anual de la Fundación Ñandú</h1>
    <p>Actividades realizadas en Asunción, Córdoba y Medellín.</p>
    <table><tr><th>Programa</th><th>Beneficiarios</th></tr>
           <tr><td>Educación</td><td>1.250</td></tr><tr><td>Salud</td><td>830</td></tr></table>
    <p class="salto">Segunda página: agradecimientos.</p>
    </body></html>"""
    path = out / "memoria.pdf"
    weasyprint.HTML(string=html).write_pdf(str(path))
    check.nonempty(path, 3000)

    with pymupdf.open(str(path)) as document:
        assert document.page_count == 2
        first = " ".join(document[0].get_text().split())  # line wrapping is layout, not content
        assert "Fundación Ñandú" in first and "Medellín" in first
        assert "Educación" in first and "1.250" in first
        assert "Página 1" in first, "the @bottom-center page counter must be rendered"
        assert "Segunda página" in document[1].get_text()
        width, height = document[0].rect.width, document[0].rect.height
        assert abs(width - 595) < 2 and abs(height - 842) < 2, "A4 in points"
        # The table is drawn as vector lines, not text.
        assert len(document[0].get_drawings()) >= 4


@pytest.mark.covers("xhtml2pdf", "pdfminer")
def test_xhtml2pdf_report_read_by_pdfminer(out, check):
    """xhtml2pdf (pisa) renders an HTML invoice to PDF; pdfminer.six extracts its text and layout."""
    from pdfminer.high_level import extract_pages, extract_text
    from pdfminer.layout import LTTextContainer
    from xhtml2pdf import pisa

    html = """<html><head><meta charset="utf-8"><style>
      @page { size: a4 portrait; margin: 1.5cm; }
      body { font-family: Helvetica; } h1 { color: #333; }
      table { width: 100%; } td { border: 1px solid #999; padding: 3px; }
    </style></head><body>
    <h1>Factura Nº 0042</h1>
    <p>Cliente: Señora Ibáñez · Dirección: Calle Alcalá 12, Madrid</p>
    <table><tr><td>Concepto</td><td>Importe</td></tr><tr><td>Diseño gráfico</td><td>1.200,00 €</td></tr></table>
    <pdf:nextpage />
    <p>Condiciones de pago: 30 días.</p>
    </body></html>"""
    path = out / "factura.pdf"
    with path.open("wb") as handle:
        status = pisa.CreatePDF(html, dest=handle, encoding="utf-8")
    assert not status.err, f"xhtml2pdf reported {status.err} errors"
    check.nonempty(path, 1500)
    assert check.pdf_pages(path) == 2

    text = extract_text(str(path))
    assert "Factura Nº 0042" in text
    assert "Señora Ibáñez" in text and "Diseño gráfico" in text
    assert "Condiciones de pago" in text
    pages = list(extract_pages(str(path)))
    assert len(pages) == 2
    boxes = [el for el in pages[0] if isinstance(el, LTTextContainer)]
    assert boxes, "pdfminer must see text boxes with positions"
    assert all(box.x0 >= 0 and box.y0 >= 0 for box in boxes)


# -------------------------------------------------------------- manipulation


@pytest.mark.covers("pypdf", "pikepdf")
def test_pypdf_merges_rotates_and_sets_metadata_verified_by_pikepdf(out, check):
    """pypdf merges two PDFs, rotates a page, writes metadata; pikepdf verifies pages, rotation and info."""
    import pikepdf
    from pypdf import PdfReader, PdfWriter

    first = _reportlab_table_pdf(out / "a.pdf", pages=2)
    second = _reportlab_table_pdf(out / "b.pdf", pages=1)

    writer = PdfWriter()
    for source in (first, second):
        writer.append(str(source))
    writer.pages[2].rotate(90)
    writer.add_metadata({"/Title": "Expediente único", "/Author": "Departamento Jurídico", "/Subject": "Año 2026 · ñ"})
    writer.add_outline_item("Inicio", 0)
    writer.add_outline_item("Anexo", 2)
    merged = out / "expediente.pdf"
    with merged.open("wb") as handle:
        writer.write(handle)
    check.nonempty(merged, 2000)

    with pikepdf.open(str(merged)) as pdf:
        assert len(pdf.pages) == 3
        assert pdf.docinfo["/Title"] == "Expediente único"
        assert pdf.docinfo["/Subject"] == "Año 2026 · ñ"
        assert int(pdf.pages[2].obj.get("/Rotate", 0)) == 90
        assert pdf.pages[0].obj.get("/Rotate", 0) == 0
        with pdf.open_outline() as outline:
            assert [item.title for item in outline.root] == ["Inicio", "Anexo"]

    reader = PdfReader(str(merged))
    assert reader.metadata.author == "Departamento Jurídico"
    assert TITULO in reader.pages[0].extract_text()
    assert "Anexo 2" in reader.pages[1].extract_text()


@pytest.mark.covers("pikepdf", "qpdf")
def test_pikepdf_encrypts_and_attaches_qpdf_decrypts_and_checks(out, check):
    """pikepdf encrypts a PDF (AES-256) and embeds an attachment; qpdf decrypts with the password and reports the structure."""
    import pikepdf

    source = _reportlab_table_pdf(out / "fuente.pdf")
    encrypted = out / "cifrado.pdf"
    with pikepdf.open(str(source)) as pdf:
        pdf.attachments["anexo.txt"] = pikepdf.AttachedFileSpec(pdf, "Datos adjuntos: ñandú\n".encode(), mime_type="text/plain")
        pdf.save(str(encrypted), encryption=pikepdf.Encryption(owner="dueño", user="secreto", R=6))

    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(str(encrypted))
    with pikepdf.open(str(encrypted), password="secreto") as pdf:
        assert pdf.is_encrypted
        assert pdf.encryption.R == 6
        assert "anexo.txt" in pdf.attachments
        assert pdf.attachments["anexo.txt"].get_file().read_bytes().decode("utf-8").startswith("Datos adjuntos: ñandú")

    decrypted = out / "descifrado.pdf"
    check.run(["qpdf", "--password=secreto", "--decrypt", str(encrypted), str(decrypted)], timeout=60)
    check.run(["qpdf", "--check", str(decrypted)], timeout=60)
    assert TITULO in check.pdf_text(decrypted)

    shown = check.run(["qpdf", "--show-encryption", "--password=secreto", str(encrypted)], timeout=60).stdout
    assert "R = 6" in shown
    listing = check.run(["qpdf", "--list-attachments", str(decrypted)], timeout=60).stdout
    assert "anexo.txt" in listing

    pages_json = json.loads(check.run(["qpdf", "--json", "--json-key=pages", str(decrypted)], timeout=60).stdout)
    assert len(pages_json["pages"]) == 1


@pytest.mark.covers("pymupdf", "mutool")
def test_pymupdf_builds_pdf_with_text_image_and_renders_mutool_rasterises(out, check):
    """PyMuPDF writes a PDF (Unicode text, vector shape, embedded PNG), renders it to PNG; mutool rasterises and extracts text."""
    import pymupdf

    logo = out / "logo.png"
    _text_image(logo, "Ñ", size=(200, 200))

    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((72, 90), "Certificado de participación — Ángel Núñez", fontsize=16, fontname="helv")
    page.insert_text((72, 120), "Taller de análisis de datos, Bogotá, 2026.", fontsize=11, fontname="helv")
    shape = page.new_shape()
    shape.draw_rect(pymupdf.Rect(72, 150, 300, 200))
    shape.finish(color=(0, 0, 0.5), fill=(0.85, 0.9, 1))
    shape.commit()
    page.insert_image(pymupdf.Rect(350, 150, 450, 250), filename=str(logo))
    page2 = document.new_page()
    page2.insert_text((72, 90), "Segunda página", fontsize=12, fontname="helv")
    path = out / "certificado.pdf"
    document.save(str(path), garbage=3, deflate=True)
    document.close()
    check.nonempty(path, 2000)

    with pymupdf.open(str(path)) as again:
        assert again.page_count == 2
        text = again[0].get_text()
        assert "Ángel Núñez" in text and "Bogotá" in text
        assert len(again[0].get_images(full=True)) == 1
        pixmap = again[0].get_pixmap(dpi=96)
        png = out / "pagina1.png"
        pixmap.save(str(png))
    (width, height), mode = check.image(png)
    assert width == 794 and height == 1123 and mode == "RGB"  # A4 at 96 dpi

    check.run(["mutool", "draw", "-r", "72", "-o", str(out / "mutool.png"), str(path), "1"], timeout=60)
    (width, height), _ = check.image(out / "mutool.png")
    assert abs(width - 595) <= 1 and abs(height - 842) <= 1
    txt = out / "mutool.txt"
    check.run(["mutool", "draw", "-F", "txt", "-o", str(txt), str(path), "1-2"], timeout=60)
    content = txt.read_text(encoding="utf-8")
    assert "Ángel Núñez" in content and "Segunda página" in content
    info = check.run(["mutool", "info", str(path)], timeout=60).stdout
    assert "Pages: 2" in info


@pytest.mark.covers("pdf2image", "pdftoppm")
def test_pdf2image_and_pdftoppm_rasterise_pages(out, check):
    """pdf2image (over pdftoppm) turns every page into a PIL image; the pdftoppm CLI writes PNGs of the same size."""
    from pdf2image import convert_from_path

    pdf = _reportlab_table_pdf(out / "paginas.pdf", pages=3)
    images = convert_from_path(str(pdf), dpi=72)
    assert len(images) == 3
    assert abs(images[0].size[0] - 595) <= 1 and abs(images[0].size[1] - 842) <= 1  # A4 at 72 dpi
    # The table header has a blue fill: the first page must not be blank.
    colours = images[0].convert("RGB").getcolors(maxcolors=100000)
    assert colours and len(colours) > 10
    first = out / "pagina.png"
    images[0].save(first)
    check.nonempty(first, 2000)

    check.run(["pdftoppm", "-r", "72", "-png", str(pdf), str(out / "cli")], timeout=60)
    produced = sorted(out.glob("cli-*.png"))
    assert len(produced) == 3, [p.name for p in out.iterdir()]
    (width, height), _ = check.image(produced[0])
    assert abs(width - 595) <= 1 and abs(height - 842) <= 1  # rasterisers round the A4 size up or down
    single = check.run(["pdftoppm", "-r", "150", "-f", "2", "-l", "2", "-png", "-singlefile", str(pdf), str(out / "dos")], timeout=60)
    assert single.returncode == 0
    (width, height), _ = check.image(out / "dos.png")
    assert abs(width - 1240) <= 2 and abs(height - 1754) <= 2


@pytest.mark.covers("img2pdf")
def test_img2pdf_wraps_images_losslessly_python_and_cli(out, check):
    """img2pdf embeds PNG/JPEG into a PDF without re-encoding (Python API and CLI); PyMuPDF confirms the pixel size."""
    import img2pdf
    import pymupdf
    from PIL import Image

    png = _text_image(out / "foto.png", "Recibo Nº 7 — Señor Pérez", size=(1000, 300))
    jpg = out / "foto.jpg"
    Image.open(png).convert("RGB").save(jpg, quality=90)

    pdf = out / "recibos.pdf"
    layout = img2pdf.get_layout_fun((img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)))  # A4 pages
    pdf.write_bytes(img2pdf.convert([str(png), str(jpg)], layout_fun=layout, title="Recibos escaneados"))
    check.nonempty(pdf, 5000)
    with pymupdf.open(str(pdf)) as document:
        assert document.page_count == 2
        assert document.metadata["title"] == "Recibos escaneados"
        images = document[0].get_images(full=True)
        assert len(images) == 1
        info = document.extract_image(images[0][0])
        assert (info["width"], info["height"]) == (1000, 300)
        jpeg_info = document.extract_image(document[1].get_images(full=True)[0][0])
        assert jpeg_info["ext"] == "jpeg", "JPEG must be embedded as-is, not re-encoded"
        assert abs(document[0].rect.width - 595.28) < 1

    cli_pdf = out / "recibo_cli.pdf"
    check.run(["img2pdf", str(jpg), "-o", str(cli_pdf)], timeout=60)
    assert check.pdf_pages(cli_pdf) == 1
    with pymupdf.open(str(cli_pdf)) as document:
        assert document[0].get_images(), "the CLI output must carry the image"


@pytest.mark.covers("camelot", "reportlab")
def test_camelot_extracts_ruled_table_as_dataframe(out):
    """camelot (lattice) reads the ruled reportlab table into a DataFrame with the right shape and cells."""
    import camelot

    pdf = _reportlab_table_pdf(out / "tabla.pdf")
    tables = camelot.read_pdf(str(pdf), pages="1", flavor="lattice")
    assert tables.n >= 1, "lattice must detect the GRID table"
    frame = tables[0].df
    assert frame.shape == (3, 3), frame
    assert frame.iloc[0].tolist() == FILAS[0]
    assert frame.iloc[2, 0] == "Té de jazmín"
    assert frame.iloc[1, 1] == "120"
    assert tables[0].parsing_report["accuracy"] > 80
    csv = out / "tabla.csv"
    tables[0].to_csv(str(csv))
    assert "Café molido" in csv.read_text(encoding="utf-8")


# ----------------------------------------------------------- ghostscript / OCR


@pytest.mark.covers("gs")
def test_ghostscript_rasterises_and_rewrites_pdfs(out, check):
    """Ghostscript renders a page to PNG and concatenates two PDFs with pdfwrite; readers confirm both results."""
    first = _reportlab_table_pdf(out / "g1.pdf", pages=2)
    second = _reportlab_table_pdf(out / "g2.pdf")

    png = out / "gs.png"
    check.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=png16m", "-r72",
               "-dFirstPage=1", "-dLastPage=1", f"-sOutputFile={png}", str(first)], timeout=120)
    (width, height), mode = check.image(png)
    assert abs(width - 595) <= 1 and abs(height - 842) <= 1 and mode == "RGB"

    merged = out / "gs_unido.pdf"
    check.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite",
               "-dCompatibilityLevel=1.5", f"-sOutputFile={merged}", str(first), str(second)], timeout=120)
    assert check.pdf_pages(merged) == 3
    text = check.pdf_text(merged)
    assert TITULO in text and "Anexo 2" in text


@pytest.mark.covers("tesseract")
def test_tesseract_cli_reads_rendered_spanish_text(out, check):
    """tesseract OCRs a PNG we drew with DejaVu and writes a text file containing the words."""
    image = _text_image(out / "ocr.png", "Facturación España 2026")
    check.run(["tesseract", str(image), str(out / "ocr"), "-l", "spa+eng", "--psm", "6"], timeout=120)
    text = (out / "ocr.txt").read_text(encoding="utf-8")
    assert "Factura" in text and "2026" in text
    assert "Espa" in text
    langs = check.run(["tesseract", "--list-langs"], timeout=30).stdout
    assert "spa" in langs and "eng" in langs


@pytest.mark.covers("ocrmypdf", "tesseract")
def test_ocrmypdf_adds_text_layer_to_scanned_pdf(out, check):
    """ocrmypdf (Python API and CLI) OCRs an image-only PDF so pypdf/pdftotext can read its words."""
    import img2pdf
    import ocrmypdf

    image = _text_image(out / "escaneo.png", "Contrato de arrendamiento 2026")
    scanned = out / "escaneo.pdf"
    scanned.write_bytes(img2pdf.convert(str(image)))
    assert check.pdf_text(scanned).strip() == "", "the source PDF must start without a text layer"

    searchable = out / "buscable.pdf"
    result = ocrmypdf.ocr(str(scanned), str(searchable), language="spa+eng", force_ocr=True, output_type="pdf", progress_bar=False)
    assert int(result) == 0
    text = check.pdf_text(searchable)
    assert "Contrato" in text and "2026" in text
    assert check.pdf_pages(searchable) == 1

    via_cli = out / "buscable_cli.pdf"
    check.run(["ocrmypdf", "--force-ocr", "-l", "spa+eng", "--output-type", "pdf", str(scanned), str(via_cli)], timeout=180)
    cli_text = check.pdf_text(via_cli)
    assert "arrendamiento" in cli_text.lower() or "Contrato" in cli_text


@pytest.mark.covers("exiftool", "pypdf")
def test_exiftool_reads_and_writes_pdf_metadata(out, check):
    """exiftool reports the metadata pypdf wrote and can write its own tag, which pypdf then reads."""
    from pypdf import PdfReader, PdfWriter

    source = _reportlab_table_pdf(out / "meta.pdf")
    writer = PdfWriter(clone_from=str(source))
    writer.add_metadata({"/Title": "Memoria técnica", "/Author": "Ingeniería · Señor Peñalver", "/Keywords": "informe, año 2026"})
    tagged = out / "etiquetado.pdf"
    with tagged.open("wb") as handle:
        writer.write(handle)

    data = json.loads(check.run(["exiftool", "-json", "-charset", "utf8", str(tagged)], timeout=60).stdout)[0]
    assert data["Title"] == "Memoria técnica"
    assert data["Author"] == "Ingeniería · Señor Peñalver"
    assert data["PageCount"] == 1
    assert data["FileType"] == "PDF"

    check.run(["exiftool", "-overwrite_original", "-charset", "utf8", "-Subject=Revisión final", str(tagged)], timeout=60)
    assert PdfReader(str(tagged)).metadata.subject == "Revisión final"
    assert PdfReader(str(tagged)).metadata.title == "Memoria técnica"


# ------------------------------------------------------------------- signing


@pytest.mark.covers("pyhanko", "pikepdf")
def test_pyhanko_signs_pdf_with_self_signed_certificate_and_validates(out, check):
    """pyHanko signs a PDF with a certificate made here via cryptography; its validator and pikepdf confirm the /Sig."""
    import datetime

    import pikepdf
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    from pyhanko.keys import load_cert_from_pemder
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign import signers
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "ES"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Notaría Núñez"),
        x509.NameAttribute(NameOID.COMMON_NAME, "María José Núñez"),
    ])
    now = datetime.datetime.now(datetime.UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                                     data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                     crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
        .sign(key, hashes.SHA256())
    )
    key_pem = out / "clave.pem"
    cert_pem = out / "cert.pem"
    key_pem.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    cert_pem.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))

    source = _reportlab_table_pdf(out / "contrato.pdf")
    signer = signers.SimpleSigner.load(str(key_pem), str(cert_pem), key_passphrase=None)
    assert signer is not None
    signed = out / "contrato_firmado.pdf"
    with source.open("rb") as handle:
        writer = IncrementalPdfFileWriter(handle)
        metadata = signers.PdfSignatureMetadata(field_name="FirmaDigital", reason="Aprobación del contrato",
                                                location="Lima, Perú")
        output = signers.sign_pdf(writer, metadata, signer=signer)
        signed.write_bytes(output.getvalue())
    assert signed.stat().st_size > source.stat().st_size

    with signed.open("rb") as handle:
        reader = PdfFileReader(handle)
        embedded = reader.embedded_signatures
        assert len(embedded) == 1
        assert embedded[0].field_name == "FirmaDigital"
        context = ValidationContext(trust_roots=[load_cert_from_pemder(str(cert_pem))], allow_fetching=False)
        status = validate_pdf_signature(embedded[0], context)
        assert status.intact, status.pretty_print_details()
        assert status.valid, status.pretty_print_details()
        assert status.trusted, status.pretty_print_details()
        assert status.coverage.name == "ENTIRE_FILE"

    with pikepdf.open(str(signed)) as pdf:
        fields = pdf.Root.AcroForm.Fields
        sig_fields = [f for f in fields if str(f.get("/FT")) == "/Sig"]
        assert len(sig_fields) == 1
        assert str(sig_fields[0].V.Reason) == "Aprobación del contrato"
        assert str(sig_fields[0].V.Location) == "Lima, Perú"
        assert str(sig_fields[0].V.SubFilter) in ("/ETSI.CAdES.detached", "/adbe.pkcs7.detached")
    # Signing appended an incremental update; the original content is still readable.
    assert TITULO in check.pdf_text(signed)
