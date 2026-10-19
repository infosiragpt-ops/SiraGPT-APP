"""Area "charts": every plotting library the agent is told about draws a real
figure with a Spanish title (accents included), writes it to disk and the file
is reopened with an independent reader (Pillow for rasters, the XML/HTML text
for vector and web output). Plus the ``dot`` and ``rsvg-convert`` binaries.

Heavy libraries are imported inside each test so this module collects even on
a workstation without the image; there ``SIRA_TESTS_SKIP_MISSING=1`` skips
whatever is absent.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

TITULO = "Ventas por región — Año 2026"


def _ink(path, min_size=(100, 60), min_dark=100):
    """Assert a raster is not blank: real dimensions and enough non-white pixels."""
    from PIL import Image
    with Image.open(path) as img:
        img.load()
        size = img.size
        gray = img.convert("L")
    assert size[0] >= min_size[0] and size[1] >= min_size[1], f"{path} is only {size}"
    lo, hi = gray.getextrema()
    assert hi - lo > 60, f"{path} is a flat image (extrema {lo}-{hi})"
    dark = sum(gray.histogram()[:200])
    assert dark >= min_dark, f"{path} has only {dark} inked pixels"
    return size


def _read(path) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _ventas():
    import pandas as pd
    return pd.DataFrame({
        "región": ["Lima", "Cusco", "Arequipa", "Piura", "Loreto"],
        "ventas": [120.5, 80.25, 95.0, 60.75, 42.0],
        "año": [2026] * 5,
    })


# --------------------------------------------------------------------------- matplotlib family

@pytest.mark.covers("matplotlib")
def test_matplotlib_png_svg_pdf_with_mathtext(out, check):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(6, 4))
    ax.bar(["Ene", "Feb", "Mar", "Abr"], [3, 5, 2, 4], color="#2a6f97")
    ax.set_title(TITULO + r"  $\sum_{i=1}^{n} x_i^2 \approx \frac{\pi}{2}$")
    ax.set_xlabel("Mes")
    ax.set_ylabel("Unidades (miles)")
    ax.annotate("Máximo", xy=(1, 5), xytext=(2, 5.3), arrowprops={"arrowstyle": "->"})

    png, svg, pdf = out / "grafico.png", out / "grafico.svg", out / "grafico.pdf"
    fig.savefig(png, dpi=120)
    fig.savefig(svg)
    fig.savefig(pdf)
    plt.close(fig)

    width, height = _ink(png, min_size=(600, 400), min_dark=2000)
    assert (width, height) == (720, 480)
    root = ET.parse(svg).getroot()
    assert root.tag.endswith("svg")
    assert any(el.tag.endswith("path") for el in root.iter()), "SVG has no drawn paths"
    assert check.pdf_pages(pdf) == 1
    check.nonempty(pdf, 2000)


@pytest.mark.covers("seaborn")
def test_seaborn_barplot_and_heatmap(out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    import seaborn as sns

    df = _ventas()
    sns.set_theme(style="whitegrid")
    fig, axes = plt.subplots(1, 2, figsize=(9, 4))
    sns.barplot(data=df, x="región", y="ventas", hue="región", legend=False, ax=axes[0])
    axes[0].set_title("Ventas por región")
    matriz = np.array([[1.0, 0.6, -0.2], [0.6, 1.0, 0.1], [-0.2, 0.1, 1.0]])
    sns.heatmap(matriz, annot=True, cmap="vlag", ax=axes[1],
                xticklabels=["Año", "Región", "Ventas"], yticklabels=["Año", "Región", "Ventas"])
    axes[1].set_title("Correlación")
    path = out / "seaborn.png"
    fig.savefig(path, dpi=100, bbox_inches="tight")
    plt.close(fig)
    _ink(path, min_size=(700, 300), min_dark=5000)


@pytest.mark.covers("mplfinance")
def test_mplfinance_candlestick(out):
    import numpy as np
    import pandas as pd
    import mplfinance as mpf

    idx = pd.date_range("2026-01-05", periods=20, freq="B")
    close = 100 + np.cumsum(np.linspace(-1, 1.5, 20))
    df = pd.DataFrame({
        "Open": close - 0.5,
        "High": close + 1.0,
        "Low": close - 1.2,
        "Close": close,
        "Volume": np.linspace(1_000, 2_000, 20).astype(int),
    }, index=idx)
    path = out / "velas.png"
    mpf.plot(df, type="candle", volume=True, title="Cotización diaria — Acción Perú", style="yahoo",
             savefig={"fname": str(path), "dpi": 100})
    _ink(path, min_size=(500, 400), min_dark=3000)


@pytest.mark.covers("squarify")
def test_squarify_treemap(out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import squarify

    sizes = [500, 300, 150, 50]
    rects = squarify.squarify(squarify.normalize_sizes(sizes, 100, 100), 0, 0, 100, 100)
    assert len(rects) == 4
    assert abs(sum(r["dx"] * r["dy"] for r in rects) - 100 * 100) < 1e-6
    # Largest value gets the largest rectangle.
    areas = [r["dx"] * r["dy"] for r in rects]
    assert areas == sorted(areas, reverse=True)

    fig, ax = plt.subplots(figsize=(6, 4))
    squarify.plot(sizes=sizes, label=["Educación", "Salud", "Transporte", "Ocio"], alpha=0.85, ax=ax,
                  color=["#1b4965", "#5fa8d3", "#cae9ff", "#62b6cb"])
    ax.set_title("Presupuesto familiar por categoría")
    ax.axis("off")
    path = out / "treemap.png"
    fig.savefig(path, dpi=100)
    plt.close(fig)
    _ink(path, min_size=(500, 300), min_dark=20000)


@pytest.mark.covers("matplotlib_venn")
def test_matplotlib_venn_two_sets(out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib_venn import venn2, venn2_circles

    fig, ax = plt.subplots(figsize=(5, 4))
    diagram = venn2(subsets=(3, 2, 1), set_labels=("Matemática", "Física"), ax=ax)
    venn2_circles(subsets=(3, 2, 1), ax=ax, linewidth=1)
    ax.set_title("Alumnos por asignatura")
    assert diagram.get_label_by_id("10").get_text() == "3"
    assert diagram.get_label_by_id("01").get_text() == "2"
    assert diagram.get_label_by_id("11").get_text() == "1"
    path = out / "venn.png"
    fig.savefig(path, dpi=100)
    plt.close(fig)
    _ink(path, min_size=(400, 300), min_dark=5000)


@pytest.mark.covers("adjustText")
def test_adjusttext_separates_overlapping_labels(out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from adjustText import adjust_text

    fig, ax = plt.subplots(figsize=(5, 4))
    xs = [0.5, 0.5, 0.5, 0.5, 0.5]
    ys = [0.5, 0.5, 0.5, 0.5, 0.5]
    ax.scatter(xs, ys)
    nombres = ["Lima", "Cusco", "Piura", "Loreto", "Áncash"]
    texts = [ax.text(x, y, name) for x, y, name in zip(xs, ys, nombres)]
    before = [t.get_position() for t in texts]
    assert len(set(before)) == 1, "fixture should start fully overlapping"
    ax.set_title("Ciudades etiquetadas sin solaparse")
    adjust_text(texts, x=xs, y=ys, ax=ax)
    after = [t.get_position() for t in texts]
    assert len(set(after)) >= 2, "adjust_text left every label at the same point"
    path = out / "etiquetas.png"
    fig.savefig(path, dpi=100)
    plt.close(fig)
    _ink(path, min_size=(400, 300))


@pytest.mark.covers("missingno")
def test_missingno_matrix(out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import missingno as msno
    import numpy as np
    import pandas as pd

    df = pd.DataFrame({
        "edad": [23, np.nan, 45, 31, np.nan, 52, 38, 29],
        "ingreso": [1200.0, 980.0, np.nan, np.nan, 1500.0, 2100.0, np.nan, 1750.0],
        "región": ["Lima", "Cusco", None, "Piura", "Lima", None, "Loreto", "Cusco"],
    })
    assert int(df.isna().sum().sum()) == 7
    ax = msno.matrix(df, figsize=(7, 4), fontsize=10)
    ax.set_title("Valores faltantes por columna")
    path = out / "faltantes.png"
    ax.figure.savefig(path, dpi=100, bbox_inches="tight")
    plt.close(ax.figure)
    _ink(path, min_size=(500, 300), min_dark=5000)


@pytest.mark.covers("plotnine")
def test_plotnine_scatter(out):
    import pandas as pd
    from plotnine import aes, geom_point, geom_smooth, ggplot, labs, theme_minimal

    df = pd.DataFrame({"x": list(range(1, 13)), "y": [2, 4, 5, 4, 6, 7, 8, 7, 9, 11, 10, 12]})
    plot = (ggplot(df, aes("x", "y")) + geom_point(color="#1b4965", size=3)
            + geom_smooth(method="lm", se=False, color="#d62828")
            + labs(title="Relación entre inversión y producción", x="Mes", y="Toneladas")
            + theme_minimal())
    path = out / "plotnine.png"
    plot.save(path, width=6, height=4, dpi=100, verbose=False)
    _ink(path, min_size=(500, 300), min_dark=1500)


@pytest.mark.covers("wordcloud")
def test_wordcloud_from_spanish_text(out):
    from wordcloud import WordCloud

    texto = ("educación educación educación salud innovación tecnología región región "
             "universidad investigación educación ciencia país futuro comunidad") * 3
    nube = WordCloud(width=400, height=220, background_color="white", random_state=7).generate(texto)
    assert "educación" in nube.words_, f"accented words were split: {sorted(nube.words_)[:5]}"
    assert nube.words_["educación"] == 1.0  # the most frequent word has relative weight 1
    path = out / "nube.png"
    nube.to_file(str(path))
    size = _ink(path, min_size=(400, 220), min_dark=1500)
    assert size == (400, 220)


# --------------------------------------------------------------------------- web / vector grammar

@pytest.mark.covers("plotly")
def test_plotly_offline_html(out):
    import plotly.graph_objects as go

    fig = go.Figure()
    fig.add_trace(go.Scatter(x=[1, 2, 3, 4], y=[2, 1, 3, 5], mode="lines+markers", name="Lima"))
    fig.add_trace(go.Bar(x=[1, 2, 3, 4], y=[1, 2, 1, 2], name="Cusco"))
    fig.update_layout(title="Evolución de ventas por región", xaxis_title="Trimestre", yaxis_title="Millones S/.")
    path = out / "plotly.html"
    fig.write_html(str(path), include_plotlyjs=True, full_html=True)
    html = _read(path)
    assert "Plotly.newPlot" in html, "offline bootstrap missing"
    assert "<script" in html and len(html) > 1_000_000, "plotly.js was not inlined"
    assert "Lima" in html and "Cusco" in html
    assert "Evoluci" in html  # title (may be unicode-escaped in the JSON payload)


@pytest.mark.covers("bokeh")
def test_bokeh_inline_html(out):
    from bokeh.io import output_file, save
    from bokeh.models import ColumnDataSource
    from bokeh.plotting import figure

    path = out / "bokeh.html"
    output_file(str(path), title="Temperatura", mode="inline")
    source = ColumnDataSource({"día": [1, 2, 3, 4, 5], "temp": [18.5, 19.0, 21.3, 20.1, 22.8]})
    fig = figure(title="Temperatura máxima por día", x_axis_label="Día", y_axis_label="°C",
                 width=500, height=350)
    fig.line("día", "temp", source=source, line_width=2)
    fig.scatter("día", "temp", source=source, size=8)
    written = save(fig, filename=str(path), resources=None)
    assert str(written) == str(path)
    html = _read(path)
    assert "Bokeh." in html and "Temperatura" in html
    assert "cdn.bokeh.org" not in html, "HTML references the CDN instead of embedding BokehJS"
    assert len(html) > 200_000, "BokehJS does not look inlined"
    assert "docs_json" in html or "Bokeh.embed" in html or "embed_items" in html


@pytest.mark.covers("altair", "vl_convert")
def test_altair_png_svg_via_vl_convert(out):
    import json
    import altair as alt
    import vl_convert as vlc

    df = _ventas()
    chart = (alt.Chart(df).mark_bar().encode(
        x=alt.X("región:N", title="Región"),
        y=alt.Y("ventas:Q", title="Ventas (miles)"),
        color=alt.Color("región:N", legend=None),
    ).properties(title="Ventas por región — Año 2026", width=400, height=250))

    png, svg = out / "altair.png", out / "altair.svg"
    chart.save(str(png))           # altair delegates raster export to vl-convert
    chart.save(str(svg))
    _ink(png, min_size=(400, 250), min_dark=2000)
    svg_text = _read(svg)
    assert svg_text.lstrip().startswith("<svg") and "<path" in svg_text
    assert "Ventas por regi" in svg_text

    # vl-convert on its own: Vega-Lite JSON -> PNG at 2x scale.
    spec = chart.to_json()
    assert json.loads(spec)["title"].startswith("Ventas")
    data = vlc.vegalite_to_png(spec, scale=2)
    hi = out / "altair-2x.png"
    hi.write_bytes(data)
    big = _ink(hi, min_size=(800, 500), min_dark=4000)
    assert big[0] >= 2 * 400


@pytest.mark.covers("pygal")
def test_pygal_svg_and_png(out):
    import pygal

    chart = pygal.Bar(title="Población por región (millones)", x_title="Región", y_title="Habitantes")
    chart.x_labels = ["Lima", "Cusco", "Arequipa"]
    chart.add("2020", [9.6, 1.3, 1.4])
    chart.add("2026", [10.4, 1.4, 1.6])
    svg, png = out / "poblacion.svg", out / "poblacion.png"
    chart.render_to_file(str(svg))
    chart.render_to_png(str(png))  # rasterised through cairosvg

    root = ET.parse(svg).getroot()
    assert root.tag.endswith("svg")
    rects = [el for el in root.iter() if el.tag.endswith("rect")]
    assert len(rects) >= 6, "fewer bars than data points"
    assert "Población por región" in _read(svg)
    _ink(png, min_size=(400, 300), min_dark=3000)


# --------------------------------------------------------------------------- graphs & diagrams

@pytest.mark.covers("graphviz", "dot")
def test_graphviz_python_render_png_and_svg(out):
    import graphviz

    g = graphviz.Digraph("flujo", format="png", graph_attr={"rankdir": "LR"})
    g.node("a", "Inicio")
    g.node("b", "Revisión técnica")
    g.node("c", "Aprobación")
    g.node("d", "Fin")
    g.edges([("a", "b"), ("b", "c"), ("c", "d")])
    g.edge("c", "b", label="rechazado")
    rendered = g.render(filename=str(out / "flujo"), cleanup=True)
    assert rendered.endswith("flujo.png")
    _ink(rendered, min_size=(300, 60), min_dark=500)
    assert not (out / "flujo").exists(), "cleanup=True should remove the .gv source"

    svg = g.pipe(format="svg").decode("utf-8")
    assert "<svg" in svg and "Revisión técnica" in svg
    assert svg.count("<g id=\"edge") == 4 or svg.count("class=\"edge\"") == 4


@pytest.mark.covers("pyvis")
def test_pyvis_network_html(out):
    import json
    import re
    from pyvis.network import Network

    net = Network(height="400px", width="100%", directed=True, notebook=False, cdn_resources="in_line")
    net.add_node(1, label="Lima", title="Capital")
    net.add_node(2, label="Cusco")
    net.add_node(3, label="Arequipa")
    net.add_edge(1, 2, label="vía aérea")
    net.add_edge(2, 3)
    path = out / "red.html"
    net.write_html(str(path), notebook=False)
    assert path.exists()
    html = _read(path)
    assert "new vis.Network" in html, "vis.js bootstrap missing"
    match = re.search(r"nodes = new vis\.DataSet\((\[.*?\])\);", html, re.S)
    assert match, "nodes JSON not embedded"
    nodes = json.loads(match.group(1))
    assert {n["label"] for n in nodes} == {"Lima", "Cusco", "Arequipa"}
    # pyvis defaults to the vis.js CDN; offline rendering is not asserted, only the data.
    assert "vía aérea" in html or "v\\u00eda a\\u00e9rea" in html


@pytest.mark.covers("diagrams", "dot")
def test_diagrams_architecture_png(out):
    from diagrams import Cluster, Diagram
    from diagrams.aws.compute import EC2
    from diagrams.aws.database import RDS
    from diagrams.aws.network import ELB

    with Diagram("Arquitectura", filename=str(out / "arq"), show=False, outformat="png"):
        lb = ELB("balanceador")
        with Cluster("Servicios"):
            web = [EC2("web 1"), EC2("web 2")]
        lb >> web >> RDS("base de datos")
    png = out / "arq.png"
    assert png.exists(), "diagrams did not produce arq.png"
    size = _ink(png, min_size=(300, 200), min_dark=5000)
    assert size[0] > 300 and size[1] > 200


# --------------------------------------------------------------------------- command-line tools

@pytest.mark.covers("dot")
def test_dot_cli_svg_and_png(out, check):
    src = out / "flujo.dot"
    src.write_text('digraph { rankdir=LR; Inicio -> "Revisión" -> Fin; "Revisión" -> Inicio [label="corregir"] }',
                   encoding="utf-8")
    svg, png = out / "flujo.svg", out / "flujo.png"
    check.run(["dot", "-Tsvg", str(src), "-o", str(svg)])
    check.run(["dot", "-Tpng", str(src), "-o", str(png)])
    text = _read(svg)
    assert "<svg" in text and "Revisión" in text
    root = ET.parse(svg).getroot()
    edges = [el for el in root.iter() if el.get("class") == "edge"]
    nodes = [el for el in root.iter() if el.get("class") == "node"]
    assert len(nodes) == 3 and len(edges) == 3
    _ink(png, min_size=(200, 50), min_dark=300)


@pytest.mark.covers("rsvg-convert")
def test_rsvg_convert_svg_to_png_and_pdf(out, check):
    svg = out / "dibujo.svg"
    svg.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">'
        '<rect x="10" y="10" width="180" height="80" fill="#2a6f97"/>'
        '<circle cx="100" cy="50" r="30" fill="#ffb703"/>'
        '<text x="20" y="30" font-size="14" fill="white">Año 2026</text></svg>',
        encoding="utf-8")
    png, pdf, big = out / "dibujo.png", out / "dibujo.pdf", out / "dibujo-2x.png"
    check.run(["rsvg-convert", "-o", str(png), str(svg)])
    check.run(["rsvg-convert", "-f", "pdf", "-o", str(pdf), str(svg)])
    check.run(["rsvg-convert", "-z", "2", "-o", str(big), str(svg)])
    assert _ink(png, min_size=(200, 100), min_dark=5000) == (200, 100)
    assert _ink(big, min_size=(400, 200), min_dark=20000) == (400, 200)
    assert check.pdf_pages(pdf) == 1
    from PIL import Image
    with Image.open(png) as img:
        r, g, b = img.convert("RGB").getpixel((100, 50))
    assert (r, g, b) == (255, 183, 3), "centre circle colour was not rasterised faithfully"
