"""LaTeX deliverables: pdflatex, xelatex, latexmk and bibtex on a Spanish document.

Each test compiles a small article (babel spanish, a booktabs table, a BibTeX
bibliography) fully offline with ``-interaction=nonstopmode -halt-on-error``
into the ``out`` directory and checks the PDF text with pypdf (and pdftotext
when present). Babel's Spanish captions ("Cuadro", "Referencias") and the
accented bibliography entry are the proof that language support and the full
pdflatex → bibtex → pdflatex cycle really ran.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

BIB = r"""
@article{perez2024,
  author  = {P{\'e}rez, Juan and Ib{\'a}{\~n}ez, Luc{\'i}a},
  title   = {An{\'a}lisis de ventas en la regi{\'o}n andina},
  journal = {Revista de Econom{\'i}a Aplicada},
  year    = {2024},
  volume  = {12},
  number  = {3},
  pages   = {45--67}
}
@book{garcia2021,
  author    = {Garc{\'i}a M{\'a}rquez, Ana},
  title     = {Estad{\'i}stica para la gesti{\'o}n},
  publisher = {Ediciones Cu{\'a}druple},
  address   = {Bogot{\'a}},
  year      = {2021}
}
"""

BODY = r"""
\title{Informe de resultados del trimestre}
\author{María José Núñez}
\date{20 de octubre de 2026}
\begin{document}
\maketitle
\tableofcontents
\section{Introducción}
El año 2026 cerró con un crecimiento del 12\,\% en Perú, Colombia y España,
tal como anticipaban \cite{perez2024} y el manual de \cite{garcia2021}.
La ecuación del margen es $m = \frac{i - g}{i} \times 100$.
\begin{table}[h]
  \centering
  \begin{tabular}{lrr}
    \toprule
    Producto & Unidades & Precio (\texteuro) \\
    \midrule
    Café molido  & 120 & 18,50 \\
    Té de jazmín &  80 &  9,75 \\
    \bottomrule
  \end{tabular}
  \caption{Ventas por producto}
  \label{tab:ventas}
\end{table}
Como muestra el cuadro~\ref{tab:ventas}, el café sigue siendo el producto principal.
\newpage
\section{Conclusión}
Las cifras confirman la tendencia del año anterior.
\bibliographystyle{plain}
\bibliography{referencias}
\end{document}
"""

PDFLATEX_PREAMBLE = r"""
\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{textcomp}
\usepackage[spanish]{babel}
\usepackage{booktabs}
\usepackage{amsmath}
"""

XELATEX_PREAMBLE = r"""
\documentclass[11pt,a4paper]{article}
\usepackage{fontspec}
\setmainfont{DejaVu Serif}
\usepackage[spanish]{babel}
\usepackage{booktabs}
\usepackage{amsmath}
"""


def _write_sources(out: Path, preamble: str, name: str = "informe") -> Path:
    (out / "referencias.bib").write_text(BIB, encoding="utf-8")
    tex = out / f"{name}.tex"
    tex.write_text(preamble + BODY, encoding="utf-8")
    return tex


def _tex_env(out: Path) -> dict:
    """TeX Live may need to write font/format caches; point them at the writable test dir."""
    env = dict(os.environ)
    env["TEXMFVAR"] = str(out / "texmf-var")
    env["TEXMFCONFIG"] = str(out / "texmf-config")
    env["max_print_line"] = "1000"
    env.setdefault("HOME", str(out))
    return env


def _extract_text(path: Path, check) -> str:
    text = check.pdf_text(path)
    if shutil.which("pdftotext"):
        text += "\n" + check.run(["pdftotext", "-layout", str(path), "-"], timeout=30).stdout
    return text


def _assert_full_document(text: str) -> None:
    """Content that proves babel spanish, the table, the math and the resolved citations."""
    assert "Informe de resultados del trimestre" in text
    assert "María José Núñez" in text
    assert "Introducción" in text and "Conclusión" in text
    assert "Cuadro 1" in text, "babel spanish must label the float 'Cuadro', not 'Table'"
    assert "Referencias" in text, "babel spanish must title the bibliography 'Referencias'"
    assert "Té de jazmín" in text and "18,50" in text
    assert "[1]" in text and "[2]" in text, "citations must be resolved after bibtex"
    assert "Pérez" in text and "Ibáñez" in text
    assert "Revista de Econom" in text
    assert "Garc" in text and "Bogot" in text
    assert "[?]" not in text, "an unresolved \\cite leaked into the PDF"
    assert "??" not in text, "an unresolved \\ref leaked into the PDF"


@pytest.mark.covers("pdflatex", "bibtex")
def test_pdflatex_and_bibtex_cycle_builds_spanish_article(out, check):
    """pdflatex → bibtex → pdflatex ×2 produces a 2-page Spanish article with table of contents, table and bibliography."""
    tex = _write_sources(out, PDFLATEX_PREAMBLE)
    env = _tex_env(out)
    latex = ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", f"-output-directory={out}", tex.name]

    check.run(latex, timeout=120, cwd=str(out), env=env)
    aux = out / "informe.aux"
    assert aux.exists() and r"\citation{perez2024}" in aux.read_text(encoding="utf-8", errors="replace")

    bib_run = check.run(["bibtex", "informe"], timeout=60, cwd=str(out), env=env)
    assert "error message" not in bib_run.stdout.lower(), bib_run.stdout
    bbl = out / "informe.bbl"
    assert bbl.exists(), "bibtex must write the .bbl"
    bbl_text = bbl.read_text(encoding="utf-8", errors="replace")
    assert "P{\\'e}rez" in bbl_text and "bibitem{garcia2021}" in bbl_text
    assert "Ediciones Cu{\\'a}druple" in bbl_text
    blg = (out / "informe.blg").read_text(encoding="utf-8", errors="replace")
    assert "I couldn't open database file" not in blg, blg

    check.run(latex, timeout=120, cwd=str(out), env=env)  # pulls in the .bbl
    check.run(latex, timeout=120, cwd=str(out), env=env)  # resolves \ref and the TOC

    pdf = out / "informe.pdf"
    check.nonempty(pdf, 10_000)
    assert check.pdf_pages(pdf) == 2
    text = _extract_text(pdf, check)
    _assert_full_document(text)
    assert "Índice" in text, "babel spanish names the table of contents 'Índice'"
    log = (out / "informe.log").read_text(encoding="utf-8", errors="replace")
    assert "Output written on" in log
    assert "LaTeX Warning: There were undefined references" not in log


@pytest.mark.covers("xelatex", "bibtex")
def test_xelatex_fontspec_system_font_unicode_article(out, check):
    """xelatex typesets the same article with fontspec and the system DejaVu Serif font (direct UTF-8 input) plus bibtex."""
    tex = _write_sources(out, XELATEX_PREAMBLE, name="informe_xe")
    env = _tex_env(out)
    latex = ["xelatex", "-interaction=nonstopmode", "-halt-on-error", f"-output-directory={out}", tex.name]

    check.run(latex, timeout=180, cwd=str(out), env=env)
    check.run(["bibtex", "informe_xe"], timeout=60, cwd=str(out), env=env)
    check.run(latex, timeout=180, cwd=str(out), env=env)
    check.run(latex, timeout=180, cwd=str(out), env=env)

    pdf = out / "informe_xe.pdf"
    check.nonempty(pdf, 10_000)
    assert check.pdf_pages(pdf) == 2
    text = _extract_text(pdf, check)
    _assert_full_document(text)
    assert "€" in text, "\\texteuro must map to the euro glyph of the OpenType font (TU encoding)"
    log = (out / "informe_xe.log").read_text(encoding="utf-8", errors="replace")
    assert "DejaVu" in log, "fontspec must have loaded the system font through fontconfig"
    assert "Output written on" in log

    # The font is embedded as a real OpenType/TrueType program, not a Type 3 bitmap fallback.
    from pypdf import PdfReader
    fonts = set()
    for page in PdfReader(str(pdf)).pages:
        resources = page.get("/Resources") or {}
        for font in (resources.get("/Font") or {}).values():
            fonts.add(str(font.get_object().get("/Subtype")))
    assert fonts & {"/Type0", "/TrueType"}, fonts


@pytest.mark.covers("latexmk", "pdflatex", "bibtex")
def test_latexmk_runs_the_whole_cycle_once(out, check):
    """latexmk -pdf orchestrates pdflatex + bibtex + reruns by itself and ends with resolved citations and references."""
    tex = _write_sources(out, PDFLATEX_PREAMBLE, name="memoria")
    env = _tex_env(out)
    build = out / "build"
    build.mkdir()
    done = check.run([
        "latexmk", "-pdf", "-bibtex", "-interaction=nonstopmode", "-halt-on-error",
        f"-output-directory={build}", tex.name,
    ], timeout=300, cwd=str(out), env=env)
    assert "Latexmk: All targets" in done.stdout or (build / "memoria.pdf").exists()

    pdf = build / "memoria.pdf"
    check.nonempty(pdf, 10_000)
    assert check.pdf_pages(pdf) == 2
    assert (build / "memoria.bbl").exists(), "latexmk must have called bibtex"
    assert (build / "memoria.fls").exists() or (build / "memoria.fdb_latexmk").exists(), "latexmk bookkeeping files"
    _assert_full_document(_extract_text(pdf, check))

    # A second run has nothing to do and must not fail.
    again = check.run([
        "latexmk", "-pdf", "-bibtex", "-interaction=nonstopmode", "-halt-on-error",
        f"-output-directory={build}", tex.name,
    ], timeout=300, cwd=str(out), env=env)
    assert "Nothing to do" in (again.stdout + again.stderr) or pdf.exists()

    # -C cleans every generated file, including the PDF.
    check.run(["latexmk", "-C", f"-output-directory={build}", tex.name], timeout=120, cwd=str(out), env=env)
    assert not pdf.exists()
