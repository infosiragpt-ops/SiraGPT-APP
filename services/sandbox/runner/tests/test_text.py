"""Area "text": markup converters, templating, HTML parsing, e-books, LaTeX
helpers, text statistics, fuzzy matching and small string utilities, plus the
command-line tools rg / tree / file.

Each test feeds a library real Spanish (or messy) input and asserts on the
output's content; files written to ``out`` are read back by an independent
reader (zipfile, lxml, plain parsing). Heavy imports stay inside the tests.
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import zipfile
import zlib

import pytest

MESSY_HTML = """
<html><head><title>Noticias · Perú</title><meta charset=utf-8>
<body>
<nav class="menu"><ul><li><a href="/">Inicio</a><li><a href="/economia">Economía</a></ul></nav>
<div id="contenido">
<h1 class="titular">La producción de café creció 12 % en 2025</h1>
<p>El Ministerio de Desarrollo Agrario informó que la producción nacional de café alcanzó
las 380 mil toneladas, impulsada por las regiones de Junín, San Martín y Cajamarca.
Los exportadores destacaron la mejora en la calidad del grano y el aumento de la demanda
europea, que representa más de la mitad de los envíos del país.</p>
<p>Según los especialistas, el clima favorable y la renovación de cafetales explican el
resultado. Para 2026 se proyecta un crecimiento adicional de entre 5 y 8 por ciento,
siempre que se mantengan los precios internacionales.</p>
<table><tr><td>Región<td>Toneladas<tr><td>Junín<td>95 000<tr><td>San Martín<td>88 000</table>
</div>
<div class="sidebar"><p>Publicidad</p><a href="#">Suscríbete</a></div>
<footer>© 2026 Diario de prueba
</html>
"""


# --------------------------------------------------------------------- markup


@pytest.mark.covers("markdown")
def test_markdown_tables_extension():
    import markdown

    source = (
        "# Informe de ventas\n\n"
        "Resumen del **primer trimestre** con *énfasis*.\n\n"
        "| Región | Ventas |\n|---|---:|\n| Lima | 1 200 |\n| Cusco | 850 |\n\n"
        "- Punto uno\n- Punto dos\n\n"
        "```python\nprint('hola')\n```\n"
    )
    html = markdown.markdown(source, extensions=["tables", "fenced_code", "toc"])
    assert "<h1" in html and "Informe de ventas</h1>" in html
    assert "<strong>primer trimestre</strong>" in html and "<em>énfasis</em>" in html
    assert "<table>" in html and "<thead>" in html and "<th>Región</th>" in html
    assert '<td style="text-align: right;">1 200</td>' in html or "<td align=\"right\">1 200</td>" in html
    assert html.count("<li>") == 2
    assert "<pre><code" in html and "print(" in html
    assert "`" not in html.split("<pre>")[0]


@pytest.mark.covers("markdown_it")
def test_markdown_it_tokens_and_render():
    from markdown_it import MarkdownIt

    md = MarkdownIt("commonmark").enable("table")
    source = "## Título\n\nUn [enlace](https://siragpt.com) con `código`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"
    tokens = md.parse(source)
    types = [t.type for t in tokens]
    assert types[:3] == ["heading_open", "inline", "heading_close"]
    assert tokens[0].tag == "h2"
    assert "table_open" in types and "tbody_open" in types
    inline = [t for t in tokens if t.type == "inline"][1]
    children = [c.type for c in inline.children]
    assert "link_open" in children and "code_inline" in children
    link = next(c for c in inline.children if c.type == "link_open")
    assert link.attrGet("href") == "https://siragpt.com"
    html = md.render(source)
    assert "<h2>Título</h2>" in html and '<a href="https://siragpt.com">enlace</a>' in html
    assert "<code>código</code>" in html and "<table>" in html


@pytest.mark.covers("mistune")
def test_mistune_render():
    import mistune

    renderer = mistune.create_markdown(plugins=["table", "strikethrough", "task_lists"])
    html = renderer(
        "# Lista\n\n- [x] hecho\n- [ ] pendiente\n\n~~tachado~~ y **negrita**\n\n"
        "| x | y |\n|---|---|\n| 1 | 2 |\n"
    )
    assert "<h1>Lista</h1>" in html
    assert 'type="checkbox"' in html and html.count("checked") == 1
    assert "<del>tachado</del>" in html and "<strong>negrita</strong>" in html
    assert "<table>" in html and "<td>2</td>" in html
    # The AST renderer exposes the structure too.
    ast = mistune.create_markdown(renderer=None)("Hola *mundo*")
    assert ast[0]["type"] == "paragraph"
    assert any(child["type"] == "emphasis" for child in ast[0]["children"])


@pytest.mark.covers("docutils")
def test_docutils_rst_to_html(out):
    from docutils.core import publish_string

    rst = (
        "Título principal\n================\n\n"
        "Un párrafo con *énfasis* y **negrita**.\n\n"
        "Sección\n-------\n\n"
        "* elemento uno\n* elemento dos\n\n"
        ".. note:: Esto es una nota.\n\n"
        "=====  =====\nCol A  Col B\n=====  =====\n1      2\n=====  =====\n"
    )
    html = publish_string(rst, writer_name="html5", settings_overrides={"output_encoding": "unicode",
                                                                         "report_level": 3})
    assert isinstance(html, str)
    assert "<h1" in html and "Título principal" in html
    assert "<em>énfasis</em>" in html and "<strong>negrita</strong>" in html
    assert html.count("<li>") == 2
    assert 'class="admonition note"' in html and "Esto es una nota." in html
    assert "<table" in html and "Col B" in html
    path = out / "documento.html"
    path.write_text(html, encoding="utf-8")
    assert os.path.getsize(path) > 500
    # Plain-text / LaTeX writers work on the same source.
    latex = publish_string(rst, writer_name="latex", settings_overrides={"output_encoding": "unicode"})
    assert "\\section" in latex and "\\emph{énfasis}" in latex


@pytest.mark.covers("jinja2")
def test_jinja2_template_with_spanish_filters(out):
    import jinja2

    env = jinja2.Environment(autoescape=True, trim_blocks=True, lstrip_blocks=True)

    def moneda(valor, simbolo="S/"):
        return f"{simbolo} {valor:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

    def fecha_larga(d):
        meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
                 "septiembre", "octubre", "noviembre", "diciembre"]
        return f"{d.day} de {meses[d.month - 1]} de {d.year}"

    env.filters["moneda"] = moneda
    env.filters["fecha_larga"] = fecha_larga
    template = env.from_string(
        "<h1>{{ titulo|title }}</h1>\n"
        "<p>Fecha: {{ fecha|fecha_larga }}</p>\n"
        "<ul>\n{% for item in items %}"
        "<li>{{ item.nombre }} — {{ item.precio|moneda }}{% if item.oferta %} (oferta){% endif %}</li>\n"
        "{% endfor %}</ul>\n"
        "<p>Total: {{ items|sum(attribute='precio')|moneda }}</p>\n"
        "<p>{{ nota }}</p>"
    )
    import datetime as dt
    html = template.render(
        titulo="informe de caja",
        fecha=dt.date(2026, 3, 5),
        items=[{"nombre": "Café", "precio": 1250.5, "oferta": True}, {"nombre": "Azúcar", "precio": 99.5}],
        nota="<script>alert(1)</script>",
    )
    assert "<h1>Informe De Caja</h1>" in html
    assert "Fecha: 5 de marzo de 2026" in html
    assert "Café — S/ 1.250,50 (oferta)" in html
    assert "Azúcar — S/ 99,50</li>" in html
    assert "Total: S/ 1.350,00" in html
    assert "&lt;script&gt;" in html and "<script>" not in html
    path = out / "informe.html"
    path.write_text(html, encoding="utf-8")
    assert os.path.getsize(path) > 100


@pytest.mark.covers("frontmatter")
def test_frontmatter_loads_yaml_header(out):
    import frontmatter

    source = (
        "---\n"
        "title: \"Guía de instalación\"\n"
        "author: Ana Pérez\n"
        "tags: [python, español]\n"
        "date: 2026-02-01\n"
        "draft: false\n"
        "---\n\n"
        "# Introducción\n\nContenido en **Markdown**.\n"
    )
    post = frontmatter.loads(source)
    assert post["title"] == "Guía de instalación"
    assert post["author"] == "Ana Pérez"
    assert post["tags"] == ["python", "español"]
    assert post["draft"] is False
    assert str(post["date"]) == "2026-02-01"
    assert post.content.startswith("# Introducción")
    assert "Markdown" in post.content

    post["version"] = 2
    path = out / "guia.md"
    path.write_bytes(frontmatter.dumps(post).encode("utf-8"))
    again = frontmatter.load(str(path))
    assert again["version"] == 2 and again["title"] == "Guía de instalación"
    assert again.content.strip() == post.content.strip()


@pytest.mark.covers("yaml")
def test_yaml_unicode_roundtrip(out):
    import yaml

    data = {
        "título": "Configuración",
        "ciudades": ["Lima", "Cusco", "Arequipa"],
        "parámetros": {"umbral": 0.75, "activo": True, "nulo": None, "n": 42},
        "nota": "línea uno\nlínea dos con ñ y ¿signos?",
    }
    text = yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
    assert "título: Configuración" in text
    assert "\\u" not in text  # allow_unicode keeps the accents literal
    path = out / "config.yaml"
    path.write_text(text, encoding="utf-8")
    back = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert back == data
    assert yaml.safe_load("a: 1\nb: [x, y]\nc: {d: 2026-01-01}")["b"] == ["x", "y"]
    with pytest.raises(yaml.YAMLError):
        yaml.safe_load("a: [1, 2")


# ------------------------------------------------------------------- HTML


@pytest.mark.covers("bs4", "html5lib")
def test_bs4_with_html5lib_parses_messy_html():
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(MESSY_HTML, "html5lib")
    assert soup.title.string == "Noticias · Perú"
    assert soup.h1.get_text(strip=True) == "La producción de café creció 12 % en 2025"
    # html5lib closes the implied <li>/<td>/<tr> elements like a browser.
    assert len(soup.select("nav li")) == 2
    rows = soup.select("table tr")
    assert len(rows) == 3
    assert [td.get_text(strip=True) for td in rows[1].find_all("td")] == ["Junín", "95 000"]
    assert soup.find("footer") is not None and "2026" in soup.footer.get_text()
    links = [a["href"] for a in soup.find_all("a", href=True)]
    assert "/economia" in links
    paragraphs = soup.select("#contenido p")
    assert len(paragraphs) == 2 and "380 mil toneladas" in paragraphs[0].get_text()
    soup.select_one(".sidebar").decompose()
    assert soup.select_one(".sidebar") is None
    # The soup is also serialisable back to HTML.
    assert "<tbody>" in str(soup)


@pytest.mark.covers("html2text")
def test_html2text_converts_to_markdown():
    import html2text

    converter = html2text.HTML2Text()
    converter.body_width = 0
    converter.ignore_images = True
    html = (
        "<h1>Título</h1><p>Un párrafo con <strong>negrita</strong>, <em>cursiva</em> y "
        "<a href=\"https://siragpt.com\">un enlace</a>.</p>"
        "<ul><li>uno</li><li>dos</li></ul>"
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
    )
    md = converter.handle(html)
    assert "# Título" in md
    assert "**negrita**" in md and ("_cursiva_" in md or "*cursiva*" in md)
    assert "[un enlace](https://siragpt.com)" in md
    assert "* uno" in md and "* dos" in md
    rows = [line for line in md.splitlines() if "|" in line]
    assert len(rows) == 3  # header, separator, one data row
    assert rows[0].replace(" ", "") == "A|B" and rows[1].startswith("---|---") and rows[2].replace(" ", "") == "1|2"
    assert "<" not in md


@pytest.mark.covers("readability")
def test_readability_extracts_main_article():
    from readability import Document

    doc = Document(MESSY_HTML)
    assert doc.title() == "Noticias · Perú"
    summary = doc.summary()
    assert "380 mil toneladas" in summary
    assert "renovación de cafetales" in summary
    assert "Publicidad" not in summary and "Suscríbete" not in summary
    assert "Inicio" not in summary  # navigation stripped
    text = doc.summary(html_partial=True)
    assert "<html" not in text and "Junín" in text


@pytest.mark.covers("cssselect")
def test_cssselect_with_lxml():
    import cssselect
    import lxml.html
    from lxml.cssselect import CSSSelector

    root = lxml.html.fromstring(MESSY_HTML)
    selector = CSSSelector("#contenido > p")
    paragraphs = selector(root)
    assert len(paragraphs) == 2
    assert paragraphs[1].text_content().strip().startswith("Según los especialistas")
    assert len(root.cssselect("nav a[href^='/']")) == 2
    assert root.cssselect("h1.titular")[0].text == "La producción de café creció 12 % en 2025"
    assert len(root.cssselect("table td")) == 6
    # Translated XPath is visible, which is what the agent can reuse in lxml.
    xpath = cssselect.GenericTranslator().css_to_xpath("div.sidebar p")
    assert "sidebar" in xpath and xpath.startswith("descendant-or-self::")
    assert root.xpath(xpath)[0].text == "Publicidad"
    with pytest.raises(cssselect.SelectorSyntaxError):
        CSSSelector("div[")


# ----------------------------------------------------------- e-books / LaTeX


@pytest.mark.covers("ebooklib")
def test_ebooklib_epub_two_chapters(out):
    from ebooklib import epub

    book = epub.EpubBook()
    book.set_identifier("urn:uuid:sira-test-0001")
    book.set_title("Cuentos del Perú")
    book.set_language("es")
    book.add_author("María Quispe")
    chapters = []
    for index, (title, text) in enumerate([
        ("El cóndor", "El cóndor volaba sobre el valle del Colca al amanecer."),
        ("La ciudad de piedra", "Cusco guarda muros que encajan sin argamasa."),
    ], start=1):
        chapter = epub.EpubHtml(title=title, file_name=f"cap{index}.xhtml", lang="es")
        chapter.content = f"<h1>{title}</h1><p>{text}</p>"
        book.add_item(chapter)
        chapters.append(chapter)
    book.toc = tuple(epub.Link(c.file_name, c.title, f"cap{i}") for i, c in enumerate(chapters, start=1))
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", *chapters]
    path = out / "cuentos.epub"
    epub.write_epub(str(path), book)

    assert os.path.getsize(path) > 1_000
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        assert names[0] == "mimetype" and archive.read("mimetype") == b"application/epub+zip"
        assert "META-INF/container.xml" in names
        assert any(n.endswith("cap1.xhtml") for n in names) and any(n.endswith("cap2.xhtml") for n in names)
        cap2 = next(n for n in names if n.endswith("cap2.xhtml"))
        assert "sin argamasa" in archive.read(cap2).decode("utf-8")

    back = epub.read_epub(str(path))
    assert back.title == "Cuentos del Perú"
    assert back.get_metadata("DC", "creator")[0][0] == "María Quispe"
    assert back.get_metadata("DC", "language")[0][0] == "es"
    import ebooklib
    documents = [item for item in back.get_items() if item.get_type() == ebooklib.ITEM_DOCUMENT]
    chapter_docs = [item for item in documents if item.get_name().startswith("cap")]
    assert sorted(item.get_name() for item in chapter_docs) == ["cap1.xhtml", "cap2.xhtml"]
    bodies = {item.get_name(): item.get_body_content().decode("utf-8") for item in chapter_docs}
    assert "<h1>El cóndor</h1>" in bodies["cap1.xhtml"] and "sin argamasa" in bodies["cap2.xhtml"]
    assert [item.title for item in back.toc] == ["El cóndor", "La ciudad de piedra"]
    assert len(back.toc) == 2


@pytest.mark.covers("pylatex")
def test_pylatex_document_source_and_optional_compile(out):
    import subprocess

    from pylatex import Document, Math, Section, Subsection, Tabular
    from pylatex.utils import NoEscape, bold, italic

    doc = Document(documentclass="article", document_options=["11pt"])
    doc.preamble.append(NoEscape(r"\usepackage[utf8]{inputenc}"))
    doc.preamble.append(NoEscape(r"\usepackage[T1]{fontenc}"))
    doc.preamble.append(NoEscape(r"\title{Informe de resultados}"))
    doc.append(NoEscape(r"\maketitle"))
    with doc.create(Section("Introducción")):
        doc.append("Este informe resume las ventas del año con ")
        doc.append(bold("énfasis"))
        doc.append(" y ")
        doc.append(italic("cursiva"))
        doc.append(". Caracteres especiales: 50% & S/ 100 _ #1.")
        with doc.create(Subsection("Tabla")):
            with doc.create(Tabular("l r r")) as table:
                table.add_hline()
                table.add_row(("Región", "Unidades", "Ingresos"))
                table.add_hline()
                table.add_row(("Lima", 1200, 48000))
                table.add_row(("Cusco", 850, 31000))
                table.add_hline()
        with doc.create(Subsection("Fórmula")):
            doc.append(Math(data=[NoEscape(r"\sigma = \sqrt{\frac{1}{N}\sum_{i=1}^{N}(x_i-\mu)^2}")]))

    tex = doc.dumps()
    assert r"\documentclass[11pt]{article}" in tex
    assert r"\section{Introducción}" in tex and r"\subsection{Tabla}" in tex
    assert r"\begin{tabular}{l r r}" in tex and r"\end{tabular}" in tex
    assert "Región&Unidades&Ingresos" in tex.replace(" ", "")
    assert r"\textbf{énfasis}" in tex and r"\textit{cursiva}" in tex
    assert r"50\%" in tex and r"\&" in tex and r"\_" in tex and r"\#1" in tex  # escaped
    assert r"\sqrt{\frac{1}{N}" in tex
    tex_path = out / "informe.tex"
    doc.generate_tex(str(out / "informe"))
    assert tex_path.exists() and tex_path.read_text(encoding="utf-8") == tex

    if shutil.which("pdflatex"):
        doc.generate_pdf(str(out / "informe"), compiler="pdflatex", clean_tex=False,
                         compiler_args=["-interaction=nonstopmode", "-halt-on-error"])
        pdf = out / "informe.pdf"
        assert os.path.getsize(pdf) > 5_000
        from pypdf import PdfReader
        reader = PdfReader(str(pdf))
        assert len(reader.pages) >= 1
        assert "Informe de resultados" in reader.pages[0].extract_text()
    else:
        assert subprocess.run is not None  # source-only path (no TeX on this workstation)


@pytest.mark.covers("pylatexenc")
def test_pylatexenc_latex_unicode_both_ways():
    from pylatexenc.latex2text import LatexNodes2Text
    from pylatexenc.latexencode import unicode_to_latex
    from pylatexenc.latexwalker import LatexWalker

    latex = r"Garc\'ia y Mu\~noz: $\alpha \leq \beta$, \textbf{negrita} --- \emph{fin}."
    text = LatexNodes2Text().latex_to_text(latex)
    assert "García y Muñoz" in text
    assert "α" in text and "β" in text and "≤" in text
    assert "negrita" in text and "fin" in text
    assert "\\" not in text and "$" not in text

    back = unicode_to_latex("Señor Peña — 100 % de éxito & más")
    assert r"\~n" in back or r"\~{n}" in back
    assert r"\'e" in back or r"\'{e}" in back
    assert r"\%" in back and r"\&" in back
    assert "—" not in back  # the em dash became ---
    # The walker parses structure: one macro with one argument.
    nodes, _, _ = LatexWalker(r"\section{Hola}").get_latex_nodes()
    assert nodes[0].macroname == "section"


@pytest.mark.covers("latex2mathml")
def test_latex2mathml_fraction():
    import xml.etree.ElementTree as ET

    import latex2mathml.converter

    mathml = latex2mathml.converter.convert(r"\frac{a}{b}")
    assert mathml.startswith("<math")
    assert "<mfrac>" in mathml and "<mi>a</mi>" in mathml and "<mi>b</mi>" in mathml
    root = ET.fromstring(mathml)
    assert root.tag.endswith("math")

    complex_ = latex2mathml.converter.convert(r"x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}")
    assert "<msqrt>" in complex_ and "<msup>" in complex_ and "&#x000B1;" in complex_ or "±" in complex_
    assert "<mfrac>" in complex_
    ET.fromstring(complex_)  # well-formed XML


# ------------------------------------------------------------- text metrics


@pytest.mark.covers("textstat")
def test_textstat_english_and_spanish_indices():
    import warnings

    import nltk
    import textstat

    nltk.data.path.append(os.environ.get("NLTK_DATA", "/usr/share/nltk_data"))

    # Spanish indices only need pyphen (bundled). The English ones in textstat
    # >= 0.7.5 look words up in NLTK's ``cmudict`` corpus first; offline that
    # corpus must already be on NLTK_DATA (``nltk.download('cmudict')`` at build
    # time), otherwise textstat tries to download it and raises LookupError.
    try:
        nltk.data.find("corpora/cmudict")
        has_cmudict = True
    except LookupError:
        has_cmudict = False
        warnings.warn("nltk corpus 'cmudict' is not installed: textstat English indices skipped", stacklevel=1)

    english_simple = "The cat sat on the mat. It was a sunny day. The dog ran to the park."
    english_hard = ("Notwithstanding the aforementioned considerations, the epistemological ramifications "
                    "of the hypothesis necessitate a comprehensive, multidimensional reassessment.")
    textstat.set_lang("en")
    assert textstat.sentence_count(english_simple) == 3
    assert textstat.lexicon_count(english_simple, removepunct=True) == 17
    if has_cmudict:
        easy = textstat.flesch_reading_ease(english_simple)
        hard = textstat.flesch_reading_ease(english_hard)
        assert easy > 80 and hard < 30 and easy > hard
        assert textstat.syllable_count("comprehensive") >= 3
        assert textstat.flesch_kincaid_grade(english_hard) > textstat.flesch_kincaid_grade(english_simple)

    textstat.set_lang("es")
    spanish_simple = "El perro corre. La casa es grande. Hoy hace sol."
    spanish_hard = ("La implementación de políticas macroeconómicas contracíclicas requiere una "
                    "evaluación exhaustiva de las repercusiones intersectoriales y distributivas.")
    sz_easy = textstat.szigriszt_pazos(spanish_simple)
    sz_hard = textstat.szigriszt_pazos(spanish_hard)
    assert sz_easy > sz_hard
    assert sz_easy > 70 and sz_hard < 40
    assert textstat.fernandez_huerta(spanish_simple) > textstat.fernandez_huerta(spanish_hard)
    textstat.set_lang("en")


@pytest.mark.covers("spellchecker")
def test_pyspellchecker_spanish():
    from spellchecker import SpellChecker

    checker = SpellChecker(language="es")
    assert checker.correction("casa") == "casa"
    assert checker.correction("perrro") == "perro"
    assert checker.correction("cuidad") in {"ciudad", "cuidad"}  # a real word too (imperative of cuidar)
    assert checker.correction("prolema") == "problema"
    unknown = checker.unknown(["casa", "jardín", "escuala", "ventana", "pyerta"])
    assert unknown == {"escuala", "pyerta"}
    assert "escuela" in checker.candidates("escuala")
    assert "puerta" in checker.candidates("pyerta")
    assert checker.known(["gato", "árbol"]) == {"gato", "árbol"}
    assert checker.word_usage_frequency("de") > checker.word_usage_frequency("ornitorrinco")


@pytest.mark.covers("unidecode")
def test_unidecode():
    from unidecode import unidecode

    assert unidecode("Señor Peña, ¿cómo está? Ñandú y pingüino.") == "Senor Pena, ?como esta? Nandu y pinguino."
    assert unidecode("Ærøskøbing – København") == "AEroskobing - Kobenhavn"
    assert unidecode("北京") == "Bei Jing "
    assert unidecode("Привет") == "Privet"
    assert unidecode("ASCII stays") == "ASCII stays"


@pytest.mark.covers("slugify")
def test_slugify():
    from slugify import slugify

    assert slugify("Informe de Producción — Año 2026 (versión final)") == "informe-de-produccion-ano-2026-version-final"
    assert slugify("  ¡Hola, Mundo!  ") == "hola-mundo"
    assert slugify("Cañón del Colca", separator="_") == "canon_del_colca"
    assert slugify("Una frase bastante larga para recortar", max_length=20, word_boundary=True) == "una-frase-bastante"
    assert slugify("Ünïcödé", allow_unicode=True) == "ünïcödé"
    assert slugify("Café con leche", stopwords=["con"]) == "cafe-leche"
    assert slugify("") == ""


@pytest.mark.covers("rapidfuzz")
def test_rapidfuzz_ratio_and_extract_one():
    from rapidfuzz import fuzz, process, utils

    assert fuzz.ratio("Universidad Nacional Mayor de San Marcos", "Universidad Nacional Mayor de San Marcos") == 100
    close = fuzz.ratio("Universidad Nacional Mayor de San Marcos", "Universidad Nacional de San Marcos")
    assert 85 < close < 100
    assert fuzz.ratio("perro", "gato") < 40
    assert fuzz.partial_ratio("San Isidro", "Distrito de San Isidro, Lima") == 100
    assert fuzz.token_sort_ratio("Pérez Juan", "Juan Pérez") == 100
    assert fuzz.WRatio("MIRAFLORES", "miraflores", processor=utils.default_process) == 100

    choices = ["Miraflores", "San Isidro", "Barranco", "Surco", "La Molina", "San Borja"]
    best = process.extractOne("mira flores", choices, scorer=fuzz.WRatio, processor=utils.default_process)
    assert best[0] == "Miraflores" and best[1] > 85 and best[2] == 0
    top = process.extract("san", choices, scorer=fuzz.partial_token_set_ratio, limit=2)
    assert {name for name, _, _ in top} == {"San Isidro", "San Borja"}
    assert process.extractOne("zzzz", choices, score_cutoff=90) is None
    # Mapping input returns the key.
    mapping = {"li": "Lima", "cu": "Cusco"}
    assert process.extractOne("Lyma", mapping)[2] == "li"


@pytest.mark.covers("regex")
def test_regex_unicode_properties():
    import regex

    text = "Año 2026: Ñandú, Cañón, Ürümqi, Москва, 東京 — 100%"
    words = regex.findall(r"\p{L}+", text)
    assert words == ["Año", "Ñandú", "Cañón", "Ürümqi", "Москва", "東京"]
    assert regex.findall(r"\p{Script=Cyrillic}+", text) == ["Москва"]
    assert regex.findall(r"\p{Han}+", text) == ["東京"]
    assert regex.findall(r"\p{Lu}\p{Ll}+", text) == ["Año", "Ñandú", "Cañón", "Ürümqi", "Москва"]
    assert regex.findall(r"\p{N}+", text) == ["2026", "100"]
    # Features the stdlib `re` lacks: possessive quantifiers, variable-width lookbehind, fuzzy matching.
    assert regex.match(r"\d++", "123abc").group() == "123"
    assert regex.search(r"(?<=Año |Anio )\d{4}", text).group() == "2026"
    assert regex.search(r"(?:Cañon){e<=1}", text) is not None
    assert regex.sub(r"[^\p{L}\p{N}\s]", "", "¡Hola, mundo!") == "Hola mundo"
    assert regex.split(r"\s*[—:]\s*", "a — b: c") == ["a", "b", "c"]


@pytest.mark.covers("chardet")
def test_chardet_detects_encodings():
    import chardet

    utf8 = ("La niña comió piña en Cañete y después caminó por el Jirón de la Unión. " * 4).encode("utf-8")
    result = chardet.detect(utf8)
    assert result["encoding"].lower().replace("-", "") in {"utf8", "utf8sig"}
    assert result["confidence"] > 0.7
    assert utf8.decode(result["encoding"]).startswith("La niña")

    latin1 = ("Señor Peña está en el salón. Año, niño, España, canción, corazón. " * 8).encode("latin-1")
    result = chardet.detect(latin1)
    encoding = result["encoding"].lower()
    assert encoding in {"iso-8859-1", "iso-8859-9", "iso-8859-15", "windows-1252", "cp1252", "iso-8859-2"}, result
    assert latin1.decode(result["encoding"]).startswith("Señor Peña")

    assert chardet.detect("plain ascii".encode()).get("encoding", "").lower() in {"ascii", "utf-8"}
    detector = chardet.UniversalDetector()
    for chunk in (utf8[:50], utf8[50:]):
        detector.feed(chunk)
    detector.close()
    assert detector.result["encoding"].lower().replace("-", "") in {"utf8", "utf8sig"}


@pytest.mark.covers("ftfy")
def test_ftfy_fixes_mojibake():
    import ftfy

    assert ftfy.fix_text("La niÃ±a comiÃ³ piÃ±a") == "La niña comió piña"
    assert ftfy.fix_text("Â¿CÃ³mo estÃ¡s?") == "¿Cómo estás?"
    assert ftfy.fix_text("&lt;b&gt;negrita&lt;/b&gt;") == "<b>negrita</b>"
    assert ftfy.fix_text("ï»¿texto") == "texto"
    assert ftfy.fix_text("ﬁnal oﬃcial") == "final official"  # Latin ligatures expanded
    assert ftfy.fix_text("\u201chola\u201d") == '"hola"'  # curly quotes uncurled
    fixed, explanation = ftfy.fix_and_explain("CafÃ©")
    assert fixed == "Café" and any(step.action == "encode" or step.action == "decode" for step in explanation)
    assert ftfy.fix_text("texto correcto con ñ") == "texto correcto con ñ"


@pytest.mark.covers("emoji")
def test_emoji_emojize_demojize():
    import emoji

    assert emoji.emojize("Perú :Peru:", language="alias") == "Perú 🇵🇪"
    assert emoji.emojize(":thumbs_up: listo") == "👍 listo"
    assert emoji.demojize("Hola 👋 mundo 🌎") == "Hola :waving_hand: mundo :globe_showing_Americas:"
    assert emoji.demojize("Me gusta 🍕", language="es") == "Me gusta :pizza:"
    assert emoji.replace_emoji("Texto 😀 con 🎉 emojis", replace="") == "Texto  con  emojis"
    assert emoji.emoji_count("😀😀🎉") == 3
    assert emoji.is_emoji("🎉") and not emoji.is_emoji("a")
    found = emoji.emoji_list("a 🇵🇪 b")
    assert found[0]["emoji"] == "🇵🇪" and found[0]["match_start"] == 2


@pytest.mark.covers("pyfiglet")
def test_pyfiglet_banner():
    import pyfiglet

    banner = pyfiglet.figlet_format("Sira", font="standard")
    lines = [line for line in banner.splitlines() if line.strip()]
    assert len(lines) >= 4
    assert max(len(line) for line in lines) > 15
    assert set("".join(lines)) - set(" ") and all(ord(c) < 128 for c in banner)
    slant = pyfiglet.Figlet(font="slant").renderText("GPT")
    assert slant != banner and len([ln for ln in slant.splitlines() if ln.strip()]) >= 4
    assert "standard" in pyfiglet.FigletFont.getFonts()
    with pytest.raises(pyfiglet.FontNotFound):
        pyfiglet.Figlet(font="no-existe-esta-fuente")


@pytest.mark.covers("prettytable")
def test_prettytable():
    from prettytable import PrettyTable

    table = PrettyTable()
    table.field_names = ["Región", "Ventas", "Variación"]
    table.add_row(["Lima", 1200, "+12 %"])
    table.add_row(["Cusco", 850, "-3 %"])
    table.add_row(["Arequipa", 990, "+5 %"])
    table.align["Región"] = "l"
    table.align["Ventas"] = "r"
    table.sortby = "Ventas"
    table.reversesort = True
    text = table.get_string()
    lines = text.splitlines()
    assert lines[0].startswith("+") and "Región" in lines[1]
    body = [line for line in lines[3:-1]]
    assert body[0].split("|")[1].strip() == "Lima"  # sorted desc by Ventas
    assert body[-1].split("|")[1].strip() == "Cusco"
    assert all(len(line) == len(lines[0]) for line in lines)
    html = table.get_html_string()
    assert "<table>" in html and "<th>Región</th>" in html and html.count("<tr>") == 4
    csv_text = table.get_csv_string()
    assert csv_text.splitlines()[0] == "Región,Ventas,Variación"
    assert json.loads(table.get_json_string())[0] == ["Región", "Ventas", "Variación"]
    assert table.rowcount == 3


@pytest.mark.covers("num2words")
def test_num2words_spanish():
    from num2words import num2words

    assert num2words(123, lang="es") == "ciento veintitrés"
    assert num2words(1_000_001, lang="es") == "un millón uno"
    assert num2words(21, lang="es") == "veintiuno"
    assert num2words(3.5, lang="es") == "tres punto cinco"
    assert num2words(7, lang="es", to="ordinal") == "séptimo"
    assert num2words(2026, lang="es", to="year") == "dos mil veintiséis"
    currency = num2words(1234.56, lang="es", to="currency", currency="EUR")
    assert currency.startswith("mil doscientos treinta y cuatro euros")
    assert "cincuenta y seis" in currency and "céntimos" in currency
    # An integer is read as cents; pass a float (or a string) for whole units.
    usd = num2words(100.0, lang="es", to="currency", currency="USD")
    assert usd.startswith("cien dólares")
    assert num2words(100, lang="es", to="currency", currency="EUR") == "un euro con cero céntimos"
    assert num2words(123, lang="en") == "one hundred and twenty-three"
    assert num2words(-15, lang="es") == "menos quince"


@pytest.mark.covers("inflect")
def test_inflect_plurals():
    import inflect

    engine = inflect.engine()
    assert engine.plural("child") == "children"
    assert engine.plural("analysis") == "analyses"
    assert engine.plural("box") == "boxes"
    assert engine.plural("sheep") == "sheep"
    assert engine.plural("city", 1) == "city" and engine.plural("city", 3) == "cities"
    assert engine.singular_noun("children") == "child" and engine.singular_noun("boxes") == "box"
    assert engine.singular_noun("cat") is False
    assert engine.number_to_words(123) == "one hundred and twenty-three"
    assert engine.ordinal(2) == "2nd" and engine.ordinal(11) == "11th"
    assert engine.a("apple") == "an apple" and engine.a("house") == "a house"
    assert engine.join(["pan", "queso", "vino"]) == "pan, queso, and vino"
    assert engine.inflect("There plural_verb('was',%d) no('error',%d)" % (3, 3)) == "There were 3 errors"


# -------------------------------------------------------------------- CLI


def _make_tree(out):
    (out / "proyecto" / "src").mkdir(parents=True)
    (out / "proyecto" / "docs").mkdir()
    (out / "proyecto" / "src" / "main.py").write_text("def saludar():\n    return 'Hola, mundo'\n", encoding="utf-8")
    (out / "proyecto" / "src" / "util.py").write_text("# utilidades\nPI = 3.14159\n", encoding="utf-8")
    (out / "proyecto" / "docs" / "guía.md").write_text("# Guía\n\nHola a todos.\n", encoding="utf-8")
    (out / "proyecto" / "README.txt").write_text("Proyecto de prueba\n", encoding="utf-8")
    return out / "proyecto"


@pytest.mark.covers("rg")
def test_rg_searches_directory(out, check):
    root = _make_tree(out)
    done = check.run(["rg", "--no-heading", "--line-number", "Hola", str(root)])
    hits = sorted(line for line in done.stdout.splitlines())
    assert len(hits) == 2
    assert any("main.py:2:" in hit for hit in hits) and any("guía.md:3:" in hit for hit in hits)
    # Type filter + JSON output are the forms the agent uses for structured results.
    only_py = check.run(["rg", "-t", "py", "-l", "Hola", str(root)]).stdout.strip().splitlines()
    assert [os.path.basename(p) for p in only_py] == ["main.py"]
    as_json = check.run(["rg", "--json", "PI = ", str(root)]).stdout
    events = [json.loads(line) for line in as_json.splitlines()]
    match = next(e for e in events if e["type"] == "match")
    assert match["data"]["path"]["text"].endswith("util.py") and match["data"]["line_number"] == 2
    count = check.run(["rg", "-c", "o", str(root / "README.txt")]).stdout.strip()
    assert count == "1"
    import subprocess
    nothing = subprocess.run(["rg", "no-existe-nunca", str(root)], capture_output=True, text=True, check=False)
    assert nothing.returncode == 1 and nothing.stdout == ""


@pytest.mark.covers("tree")
def test_tree_lists_directory(out, check):
    root = _make_tree(out)
    plain = check.run(["tree", "--noreport", str(root)]).stdout
    for name in ("src", "docs", "main.py", "util.py", "guía.md", "README.txt"):
        assert name in plain, plain
    assert plain.index("docs") < plain.index("src")  # sorted listing
    as_json = check.run(["tree", "-J", "--noreport", str(root)]).stdout
    data = json.loads(as_json)
    top = data[0]
    assert top["type"] == "directory"
    children = {entry["name"]: entry for entry in top["contents"]}
    assert set(children) == {"src", "docs", "README.txt"}
    assert {c["name"] for c in children["src"]["contents"]} == {"main.py", "util.py"}
    assert children["README.txt"]["type"] == "file"
    dirs_only = check.run(["tree", "-d", "--noreport", str(root)]).stdout
    assert "main.py" not in dirs_only and "src" in dirs_only


def _tiny_png(path):
    """A valid 1×1 RGBA PNG written with the stdlib only."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = zlib.compress(b"\x00" + b"\xff\x00\x00\xff")
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    path.write_bytes(png)


def _tiny_pdf(path):
    body = (
        "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
        "trailer<</Root 1 0 R>>\n%%EOF\n"
    )
    path.write_text(body, encoding="latin-1")


@pytest.mark.covers("file")
def test_file_identifies_png_and_pdf(out, check):
    png = out / "pixel.png"
    pdf = out / "hoja.pdf"
    txt = out / "nota.txt"
    _tiny_png(png)
    _tiny_pdf(pdf)
    txt.write_text("texto plano con acentos: canción\n", encoding="utf-8")

    assert check.run(["file", "--mime-type", "-b", str(png)]).stdout.strip() == "image/png"
    assert check.run(["file", "--mime-type", "-b", str(pdf)]).stdout.strip() == "application/pdf"
    assert check.run(["file", "--mime-type", "-b", str(txt)]).stdout.strip() == "text/plain"
    description = check.run(["file", "-b", str(png)]).stdout
    assert "PNG image data" in description and "1 x 1" in description
    assert "PDF document" in check.run(["file", "-b", str(pdf)]).stdout
    assert "UTF-8" in check.run(["file", "-b", str(txt)]).stdout
    assert check.run(["file", "--mime-encoding", "-b", str(txt)]).stdout.strip() == "utf-8"
    # Multiple files at once keep one line per file.
    multi = check.run(["file", "--mime-type", str(png), str(pdf)]).stdout.strip().splitlines()
    assert len(multi) == 2 and multi[0].endswith("image/png") and multi[1].endswith("application/pdf")
