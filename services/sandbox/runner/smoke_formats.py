#!/usr/bin/env python3
"""Produce one real file per format the agent is told it can make, offline.

CI runs this inside the built image with --network none. Each case writes a
file and reopens or inspects it; a case that cannot do both is a failure.
Usage: python3 smoke_formats.py [workdir]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

CASES = []


def case(name):
    def register(fn):
        CASES.append((name, fn))
        return fn
    return register


def run(cmd, timeout=120):
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    if done.returncode != 0:
        raise RuntimeError(f"{cmd[0]} exit {done.returncode}: {done.stderr.strip()[:300]}")
    return done


def nonempty(path, minimum=64):
    size = os.path.getsize(path)
    assert size >= minimum, f"{os.path.basename(path)} is only {size} bytes"


def pdf_pages(path):
    from pypdf import PdfReader
    return len(PdfReader(path).pages)


@case("dxf plan + png preview")
def dxf(work):
    import ezdxf
    from ezdxf.addons.drawing import matplotlib as drawing
    doc = ezdxf.new("R2018", setup=True)
    doc.layers.add("MUROS", color=1)
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (8, 0), (8, 6), (0, 6)], close=True, dxfattribs={"layer": "MUROS"})
    msp.add_text("Sala 48 m2", dxfattribs={"height": 0.3}).set_placement((3, 3))
    msp.add_linear_dim(base=(0, -1), p1=(0, 0), p2=(8, 0), dimstyle="EZDXF").render()
    path = os.path.join(work, "plano.dxf")
    doc.saveas(path)
    again = ezdxf.readfile(path)
    assert len(again.modelspace().query("LWPOLYLINE")) == 1
    png = os.path.join(work, "plano.png")
    drawing.qsave(again.modelspace(), png, bg="#FFFFFF")
    pdf = os.path.join(work, "plano.pdf")
    drawing.qsave(again.modelspace(), pdf, bg="#FFFFFF")
    assert pdf_pages(pdf) == 1
    nonempty(png, 1000)


@case("matplotlib png + mathtext")
def chart(work):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import seaborn  # noqa: F401 - must import next to matplotlib
    fig, ax = plt.subplots()
    ax.bar(["Ene", "Feb", "Mar"], [3, 5, 2])
    ax.set_title(r"Ventas $\sum x_i^2$")
    path = os.path.join(work, "grafico.png")
    fig.savefig(path, dpi=120)
    plt.close(fig)
    nonempty(path, 2000)


@case("plotly offline html")
def plotly_html(work):
    import plotly.graph_objects as go
    path = os.path.join(work, "grafico.html")
    go.Figure(go.Scatter(x=[1, 2, 3], y=[2, 1, 3])).write_html(path, include_plotlyjs=True)
    with open(path, encoding="utf-8") as handle:
        assert "Plotly.newPlot" in handle.read()


@case("reportlab pdf")
def reportlab_pdf(work):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    path = os.path.join(work, "factura.pdf")
    pdf = canvas.Canvas(path, pagesize=A4)
    pdf.drawString(72, 760, "Factura Nº 001 — Señor Pérez")
    pdf.showPage()
    pdf.save()
    assert pdf_pages(path) == 1


@case("fpdf2 pdf")
def fpdf_pdf(work):
    from fpdf import FPDF
    path = os.path.join(work, "simple.pdf")
    doc = FPDF()
    doc.add_page()
    doc.set_font("helvetica", size=12)
    doc.cell(text="Hola")
    doc.output(path)
    assert pdf_pages(path) == 1


@case("weasyprint html to pdf")
def weasy(work):
    import weasyprint
    path = os.path.join(work, "html.pdf")
    weasyprint.HTML(string="<h1 style='color:#123'>Informe</h1><p>Año 2026</p>").write_pdf(path)
    assert pdf_pages(path) == 1


@case("pikepdf + pymupdf reopen")
def pdf_tools(work):
    import pymupdf as fitz
    import pikepdf
    source = os.path.join(work, "factura.pdf")
    if not os.path.exists(source):
        reportlab_pdf(work)
    with pikepdf.open(source) as pdf:
        assert len(pdf.pages) == 1
    with fitz.open(source) as doc:
        assert "Factura" in doc[0].get_text()


@case("svg + cairosvg png")
def svg(work):
    import cairosvg
    import svgwrite
    path = os.path.join(work, "dibujo.svg")
    drawing = svgwrite.Drawing(path, size=("200px", "100px"))
    drawing.add(drawing.rect((10, 10), (180, 80), fill="#2a6"))
    drawing.save()
    png = os.path.join(work, "dibujo.png")
    cairosvg.svg2png(url=path, write_to=png)
    nonempty(png, 200)


@case("stl mesh")
def stl(work):
    import trimesh
    import stl as numpy_stl
    path = os.path.join(work, "pieza.stl")
    trimesh.creation.box(extents=(10, 20, 5)).export(path)
    mesh = numpy_stl.mesh.Mesh.from_file(path)
    assert len(mesh.vectors) == 12


@case("kml + gpx + shapely")
def geo(work):
    import gpxpy
    import gpxpy.gpx
    import simplekml
    from shapely.geometry import Polygon
    assert Polygon([(0, 0), (4, 0), (4, 3), (0, 3)]).area == 12
    kml = simplekml.Kml()
    kml.newpoint(name="Lima", coords=[(-77.04, -12.05)])
    kml_path = os.path.join(work, "lugar.kml")
    kml.save(kml_path)
    nonempty(kml_path, 100)
    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack()
    gpx.tracks.append(track)
    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)
    segment.points.append(gpxpy.gpx.GPXTrackPoint(-12.05, -77.04))
    gpx_path = os.path.join(work, "ruta.gpx")
    with open(gpx_path, "w", encoding="utf-8") as handle:
        handle.write(gpx.to_xml())
    with open(gpx_path, encoding="utf-8") as handle:
        assert len(gpxpy.parse(handle).tracks) == 1


@case("epub")
def epub(work):
    from ebooklib import epub as eb
    book = eb.EpubBook()
    book.set_identifier("sira-smoke")
    book.set_title("Libro")
    book.set_language("es")
    chapter = eb.EpubHtml(title="Uno", file_name="uno.xhtml", lang="es")
    chapter.content = "<h1>Capítulo uno</h1><p>Texto.</p>"
    book.add_item(chapter)
    book.toc = (chapter,)
    book.add_item(eb.EpubNcx())
    book.add_item(eb.EpubNav())
    book.spine = ["nav", chapter]
    path = os.path.join(work, "libro.epub")
    eb.write_epub(path, book)
    assert eb.read_epub(path).title == "Libro"


@case("odt via odfpy")
def odt(work):
    from odf.opendocument import OpenDocumentText, load
    from odf.text import P
    doc = OpenDocumentText()
    doc.text.addElement(P(text="Hola ODF"))
    path = os.path.join(work, "texto.odt")
    doc.save(path)
    assert "Hola ODF" in str(load(path).text)


@case("qr + barcode")
def codes(work):
    import barcode
    import qrcode
    from barcode.writer import ImageWriter
    from PIL import Image
    qr_path = os.path.join(work, "qr.png")
    qrcode.make("https://siragpt.com").save(qr_path)
    assert Image.open(qr_path).size[0] > 50
    saved = barcode.get("code128", "SIRA-001", writer=ImageWriter()).save(os.path.join(work, "codigo"))
    nonempty(saved, 200)


@case("ics + parquet + sav + sqlite")
def data(work):
    import sqlite3
    from datetime import datetime
    import icalendar
    import pandas as pd
    import pyreadstat
    cal = icalendar.Calendar()
    event = icalendar.Event()
    event.add("summary", "Reunión")
    event.add("dtstart", datetime(2026, 10, 20, 9, 0))
    cal.add_component(event)
    ics = os.path.join(work, "evento.ics")
    with open(ics, "wb") as handle:
        handle.write(cal.to_ical())
    assert icalendar.Calendar.from_ical(open(ics, "rb").read()).walk("VEVENT")
    frame = pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})
    parquet = os.path.join(work, "datos.parquet")
    frame.to_parquet(parquet, engine="fastparquet")
    assert pd.read_parquet(parquet, engine="fastparquet").shape == (3, 2)
    sav = os.path.join(work, "datos.sav")
    pyreadstat.write_sav(frame, sav)
    assert pyreadstat.read_sav(sav)[0].shape == (3, 2)
    db = os.path.join(work, "datos.sqlite")
    with sqlite3.connect(db) as conn:
        frame.to_sql("t", conn, index=False)
        assert conn.execute("select count(*) from t").fetchone()[0] == 3


@case("gif + wav + midi")
def media(work):
    import imageio.v2 as imageio
    import mido
    import numpy as np
    from pydub import AudioSegment
    from scipy.io import wavfile
    frames = [np.full((20, 20, 3), shade, dtype=np.uint8) for shade in (0, 128, 255)]
    gif = os.path.join(work, "anim.gif")
    imageio.mimsave(gif, frames, duration=0.2)
    assert len(imageio.mimread(gif)) == 3
    rate = 8000
    wav = os.path.join(work, "tono.wav")
    wavfile.write(wav, rate, (np.sin(np.arange(rate) * 2 * np.pi * 440 / rate) * 3000).astype(np.int16))
    mp3 = os.path.join(work, "tono.mp3")
    AudioSegment.from_wav(wav).export(mp3, format="mp3")
    assert 900 <= len(AudioSegment.from_file(mp3)) <= 1200
    mid = mido.MidiFile()
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.Message("note_on", note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", note=60, velocity=64, time=480))
    mid_path = os.path.join(work, "nota.mid")
    mid.save(mid_path)
    assert len(mido.MidiFile(mid_path).tracks) == 1


@case("science stack")
def science(work):
    import networkx as nx
    import numpy as np
    import statsmodels.api as sm
    import sympy
    from sklearn.cluster import KMeans
    x = np.arange(20, dtype=float)
    fit = sm.OLS(2 * x + 1, sm.add_constant(x)).fit()
    assert abs(fit.params[1] - 2) < 1e-6
    assert sympy.solve(sympy.Symbol("x") ** 2 - 4) == [-2, 2]
    labels = KMeans(n_clusters=2, n_init=2, random_state=0).fit_predict(np.array([[0], [0.1], [9], [9.1]]))
    assert len(set(labels)) == 2
    assert nx.shortest_path_length(nx.path_graph(4), 0, 3) == 3


@case("office build (docx/xlsx/pptx/xlsxwriter/docxtpl)")
def office(work):
    import docx
    import openpyxl
    import pptx
    import xlsxwriter
    document = docx.Document()
    document.add_heading("Informe", 0)
    document.save(os.path.join(work, "informe.docx"))
    book = openpyxl.Workbook()
    book.active.append(["a", 1])
    book.save(os.path.join(work, "libro.xlsx"))
    deck = pptx.Presentation()
    deck.slides.add_slide(deck.slide_layouts[0]).shapes.title.text = "Hola"
    deck.save(os.path.join(work, "deck.pptx"))
    rich = xlsxwriter.Workbook(os.path.join(work, "rico.xlsx"))
    sheet = rich.add_worksheet()
    sheet.write_column("A1", [1, 2, 3])
    graph = rich.add_chart({"type": "column"})
    graph.add_series({"values": "=Sheet1!$A$1:$A$3"})
    sheet.insert_chart("C1", graph)
    rich.close()
    assert openpyxl.load_workbook(os.path.join(work, "rico.xlsx")).active["A3"].value == 3


@case("cli: soffice docx->pdf/odt")
def soffice(work):
    source = os.path.join(work, "informe.docx")
    if not os.path.exists(source):
        office(work)
    profile = tempfile.mkdtemp(dir=work)
    for target in ("pdf", "odt"):
        run(["soffice", f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to", target, "--outdir", work, source], timeout=180)
        nonempty(os.path.join(work, f"informe.{target}"), 500)
    assert pdf_pages(os.path.join(work, "informe.pdf")) >= 1


@case("cli: pandoc, graphviz, rsvg, ghostscript, sqlite3, jq, 7z")
def cli(work):
    md = os.path.join(work, "nota.md")
    with open(md, "w", encoding="utf-8") as handle:
        handle.write("# Título\n\nTexto con **negrita**.\n")
    run(["pandoc", md, "-o", os.path.join(work, "nota.docx")])
    nonempty(os.path.join(work, "nota.docx"), 1000)
    run(["pandoc", md, "-o", os.path.join(work, "nota.epub")])
    dot = os.path.join(work, "flujo.dot")
    with open(dot, "w", encoding="utf-8") as handle:
        handle.write("digraph { Inicio -> Revisión -> Fin }")
    run(["dot", "-Tsvg", dot, "-o", os.path.join(work, "flujo.svg")])
    run(["dot", "-Tpng", dot, "-o", os.path.join(work, "flujo.png")])
    run(["rsvg-convert", "-o", os.path.join(work, "flujo-rsvg.png"), os.path.join(work, "flujo.svg")])
    nonempty(os.path.join(work, "flujo-rsvg.png"), 200)
    source = os.path.join(work, "factura.pdf")
    if not os.path.exists(source):
        reportlab_pdf(work)
    run(["gs", "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", "-dPDFSETTINGS=/ebook", f"-sOutputFile={os.path.join(work, 'comprimido.pdf')}", source])
    assert pdf_pages(os.path.join(work, "comprimido.pdf")) == 1
    assert run(["sqlite3", ":memory:", "select 6*7;"]).stdout.strip() == "42"
    assert run(["jq", "-n", "1+1"]).stdout.strip() == "2"
    run(["7z", "a", "-bd", os.path.join(work, "paquete.7z"), md])
    nonempty(os.path.join(work, "paquete.7z"), 50)


def main() -> int:
    work = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="sira-formats-")
    os.makedirs(work, exist_ok=True)
    only = set(filter(None, os.environ.get("SIRA_SMOKE_ONLY", "").split(",")))
    failed = []
    for name, fn in CASES:
        if only and not any(token in name for token in only):
            continue
        try:
            fn(work)
            print(f"ok   {name}")
        except Exception:  # noqa: BLE001 - report every broken format
            failed.append(name)
            print(f"FAIL {name}\n{traceback.format_exc(limit=3)}", file=sys.stderr)
    produced = sorted(name for name in os.listdir(work) if os.path.isfile(os.path.join(work, name)))
    print(json.dumps({"produced": produced}, ensure_ascii=False))
    if failed:
        print(f"SIRA_FORMATS_FAILED {len(failed)}: {', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"SIRA_FORMATS_OK {len(CASES)} cases, {len(produced)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
