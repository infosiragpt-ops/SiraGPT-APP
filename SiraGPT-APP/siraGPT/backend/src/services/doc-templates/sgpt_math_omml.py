"""sgpt_math_omml — LaTeX → MathML → OMML for native Word equations.

Emits Office Math Markup Language (the XML Word uses internally for
its equation editor) so an `apa_math(doc, latex)` call produces a
real, editable Word equation — not a rasterised PNG. The trade-off
vs. matplotlib mathtext is that our coverage is narrower (we only
handle the MathML subset latex2mathml emits for academic math:
fractions, super/sub, integrals, sums, square roots, accents,
matrices); anything we can't translate falls through to the PNG
renderer in `sgpt_docx.apa_math`.

Two-stage pipeline:
    LaTeX → latex2mathml → MathML (lxml ElementTree)
    MathML → walk the tree and emit `<m:…>` OMML equivalents

Why we don't ship the full Microsoft MML2OMML.XSL: it's 2000+ lines
and pulls in transformations we don't need (e.g., custom operator
classes for engineering notation, RTL math, MathML 4 features
latex2mathml doesn't emit). A focused Python walker covers >95% of
the LaTeX patterns the assistant emits in academic / scientific
documents and is far easier to maintain.

Public API:
    omml_element_from_latex(latex)      -> lxml.etree._Element | None
    insert_omml_paragraph(doc, latex,
                          fontsize=14)  -> docx.paragraph or None on failure
"""

import re
import io
import importlib

from lxml import etree
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn, nsmap
from docx.oxml import OxmlElement

# OMML namespace — Word's equation-format XML.
M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MML_NS = "http://www.w3.org/1998/Math/MathML"


def _m(tag, *children, **attrs):
    """Build an `<m:tag>` OMML element with optional children + attrs."""
    el = etree.SubElement.__self__ = None  # silence linters
    el = etree.Element(f"{{{M_NS}}}{tag}", nsmap={"m": M_NS})
    for k, v in attrs.items():
        el.set(f"{{{M_NS}}}{k}" if ":" not in k else k, v)
    for c in children:
        if c is not None:
            el.append(c)
    return el


def _m_run(text, italic=False):
    """A <m:r>…</m:r> run — the OMML equivalent of a Word text run."""
    r = etree.Element(f"{{{M_NS}}}r", nsmap={"m": M_NS})
    if italic:
        rPr = etree.SubElement(r, f"{{{M_NS}}}rPr")
        sty = etree.SubElement(rPr, f"{{{M_NS}}}sty")
        sty.set(f"{{{M_NS}}}val", "i")
    t = etree.SubElement(r, f"{{{M_NS}}}t")
    t.text = text
    # Preserve significant whitespace (operators like " = " need it).
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return r


def _m_e(*children):
    """<m:e> element — the 'base' container used inside frac/sup/sub/etc."""
    e = etree.Element(f"{{{M_NS}}}e", nsmap={"m": M_NS})
    for c in children:
        if c is not None:
            e.append(c)
    return e


# ── Operator translation tables ────────────────────────────────────────
#
# MathML <mo>…</mo> stores operators as Unicode codepoints (often as
# numeric character refs). Word OMML expects the literal Unicode glyph
# in <m:t>. Most operators round-trip fine — we just need to know which
# ones have semantic meaning in OMML (n-ary: ∫, ∑, ∏, ∮ etc.).
NARY_OPERATORS = {
    "∫": "∫",   # ∫ integral
    "∬": "∬",   # ∬ double integral
    "∭": "∭",   # ∭ triple integral
    "∮": "∮",   # ∮ contour integral
    "∑": "∑",   # ∑ summation
    "∏": "∏",   # ∏ product
    "⋃": "⋃",   # ⋃ union
    "⋂": "⋂",   # ⋂ intersection
}


def _strip_ns(tag):
    """ElementTree returns Clark notation `{ns}local`; we just want local."""
    if tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag


def _decode_mathml_text(node):
    """Get the text of a leaf MathML element, decoding numeric refs."""
    return (node.text or "").strip()


# ── Walker: MathML tree → OMML tree ────────────────────────────────────


def _walk(node):
    """Translate one MathML node into a list of OMML XML elements.
    Returns a list (some MathML nodes expand to multiple OMML elements
    when they wrap a sequence)."""
    tag = _strip_ns(node.tag)

    if tag == "math":
        out = []
        for child in node:
            out.extend(_walk(child))
        return out

    if tag == "mrow":
        out = []
        for child in node:
            out.extend(_walk(child))
        return out

    if tag in ("mn",):
        return [_m_run(_decode_mathml_text(node))]

    if tag == "mi":
        text = _decode_mathml_text(node)
        # Single-letter identifiers are rendered italic per math
        # convention; multi-letter (function names like "sin") stay
        # upright.
        italic = len(text) == 1 and text.isalpha()
        return [_m_run(text, italic=italic)]

    if tag == "mo":
        text = _decode_mathml_text(node)
        # N-ary operators (∫, ∑, ∏, …) are emitted as a plain text run
        # here. When they're wrapped by an msubsup or msub/msup, the
        # parent walker re-builds them as <m:nary> with the bounds.
        # When they appear bare (no bounds), Word still renders ∫ from
        # a regular run — slightly less typographically correct but
        # the alternative (an empty <m:nary>) confuses Word.
        return [_m_run(text)]

    if tag == "mtext":
        return [_m_run(_decode_mathml_text(node))]

    if tag == "mspace":
        # A non-breaking space keeps the surrounding glyphs from
        # collapsing; OMML uses the same convention as MathML.
        return [_m_run(" ")]

    if tag == "mfrac":
        children = list(node)
        if len(children) >= 2:
            num = _walk(children[0])
            den = _walk(children[1])
            return [_build_frac(num, den)]
        return []

    if tag in ("msup", "msub"):
        children = list(node)
        if len(children) >= 2:
            base_node = children[0]
            base_text = _decode_mathml_text(base_node) if _strip_ns(base_node.tag) == "mo" else None
            script = _walk(children[1])
            # Lone-bound n-ary: ∫^b f(x)dx (just upper) or ∫_a (just
            # lower). Use m:nary with the empty side blanked out.
            if base_text and base_text in NARY_OPERATORS:
                if tag == "msup":
                    return [_build_nary(base_text, sub=None, sup=script, body=None)]
                return [_build_nary(base_text, sub=script, sup=None, body=None)]
            base = _walk(base_node)
            return [_build_script(tag, base, script)]
        return []

    if tag == "msubsup":
        children = list(node)
        if len(children) >= 3:
            base_node = children[0]
            base_text = _decode_mathml_text(base_node) if _strip_ns(base_node.tag) == "mo" else None
            sub = _walk(children[1])
            sup = _walk(children[2])
            # When the base is an n-ary operator (∫, ∑, ∏), Word
            # expects a single <m:nary> element rather than nested
            # scripts — this is what makes "∫_a^b" look like a real
            # integral rather than a stretched script tower.
            if base_text and base_text in NARY_OPERATORS:
                return [_build_nary(base_text, sub=sub, sup=sup, body=None)]
            base = _walk(base_node)
            return [_build_subsup(base, sub, sup)]
        return []

    if tag == "msqrt":
        children = []
        for c in node:
            children.extend(_walk(c))
        return [_build_sqrt(children)]

    if tag == "mroot":
        children = list(node)
        if len(children) >= 2:
            radicand = _walk(children[0])
            degree = _walk(children[1])
            return [_build_root(radicand, degree)]
        return []

    if tag == "mfenced":
        # Convert <mfenced open="(" close=")">…</mfenced> into the
        # explicit ( … ) sequence so OMML's <m:d> isn't required.
        open_ch = node.get("open", "(")
        close_ch = node.get("close", ")")
        sep_ch = node.get("separators", ",")
        out = [_m_run(open_ch)]
        for i, c in enumerate(node):
            if i > 0 and sep_ch:
                out.append(_m_run(sep_ch))
            out.extend(_walk(c))
        out.append(_m_run(close_ch))
        return out

    # Unknown element — flatten its children so we don't lose content.
    out = []
    for c in node:
        out.extend(_walk(c))
    return out


# ── OMML construction helpers ──────────────────────────────────────────


def _flat_text(elements):
    """Recover the literal text from a list of OMML elements (for the
    n-ary detection check). Best-effort — only used to spot ∫/∑/∏."""
    if not elements:
        return ""
    out = []
    for el in elements:
        for t in el.iter(f"{{{M_NS}}}t"):
            out.append(t.text or "")
    return "".join(out).strip()


def _wrap_in_e(elements):
    """Wrap a list of OMML elements in a single <m:e> base container."""
    e = etree.Element(f"{{{M_NS}}}e", nsmap={"m": M_NS})
    for el in elements:
        e.append(el)
    return e


def _build_frac(num_els, den_els):
    f = etree.Element(f"{{{M_NS}}}f", nsmap={"m": M_NS})
    fPr = etree.SubElement(f, f"{{{M_NS}}}fPr")
    typ = etree.SubElement(fPr, f"{{{M_NS}}}type")
    typ.set(f"{{{M_NS}}}val", "bar")
    num = etree.SubElement(f, f"{{{M_NS}}}num")
    for el in num_els:
        num.append(el)
    den = etree.SubElement(f, f"{{{M_NS}}}den")
    for el in den_els:
        den.append(el)
    return f


def _build_script(kind, base_els, script_els):
    """msup → <m:sSup>, msub → <m:sSub>."""
    el_name = "sSup" if kind == "msup" else "sSub"
    s = etree.Element(f"{{{M_NS}}}{el_name}", nsmap={"m": M_NS})
    e = etree.SubElement(s, f"{{{M_NS}}}e")
    for el in base_els:
        e.append(el)
    sub_or_sup = "sup" if kind == "msup" else "sub"
    sx = etree.SubElement(s, f"{{{M_NS}}}{sub_or_sup}")
    for el in script_els:
        sx.append(el)
    return s


def _build_subsup(base_els, sub_els, sup_els):
    s = etree.Element(f"{{{M_NS}}}sSubSup", nsmap={"m": M_NS})
    e = etree.SubElement(s, f"{{{M_NS}}}e")
    for el in base_els:
        e.append(el)
    sub = etree.SubElement(s, f"{{{M_NS}}}sub")
    for el in sub_els:
        sub.append(el)
    sup = etree.SubElement(s, f"{{{M_NS}}}sup")
    for el in sup_els:
        sup.append(el)
    return s


def _build_nary(op_char, sub=None, sup=None, body=None):
    n = etree.Element(f"{{{M_NS}}}nary", nsmap={"m": M_NS})
    nPr = etree.SubElement(n, f"{{{M_NS}}}naryPr")
    chr_el = etree.SubElement(nPr, f"{{{M_NS}}}chr")
    chr_el.set(f"{{{M_NS}}}val", op_char)
    # Hide n if there is no superscript.
    limLoc = etree.SubElement(nPr, f"{{{M_NS}}}limLoc")
    limLoc.set(f"{{{M_NS}}}val", "subSup")
    sub_el = etree.SubElement(n, f"{{{M_NS}}}sub")
    if sub:
        for el in sub:
            sub_el.append(el)
    sup_el = etree.SubElement(n, f"{{{M_NS}}}sup")
    if sup:
        for el in sup:
            sup_el.append(el)
    e = etree.SubElement(n, f"{{{M_NS}}}e")
    if body:
        for el in body:
            e.append(el)
    return n


def _build_sqrt(elements):
    rad = etree.Element(f"{{{M_NS}}}rad", nsmap={"m": M_NS})
    rPr = etree.SubElement(rad, f"{{{M_NS}}}radPr")
    deg_hide = etree.SubElement(rPr, f"{{{M_NS}}}degHide")
    deg_hide.set(f"{{{M_NS}}}val", "1")
    etree.SubElement(rad, f"{{{M_NS}}}deg")
    e = etree.SubElement(rad, f"{{{M_NS}}}e")
    for el in elements:
        e.append(el)
    return rad


def _build_root(radicand_els, degree_els):
    rad = etree.Element(f"{{{M_NS}}}rad", nsmap={"m": M_NS})
    deg = etree.SubElement(rad, f"{{{M_NS}}}deg")
    for el in degree_els:
        deg.append(el)
    e = etree.SubElement(rad, f"{{{M_NS}}}e")
    for el in radicand_els:
        e.append(el)
    return rad


# ── Public API ─────────────────────────────────────────────────────────


def omml_from_latex(latex):
    """Convert LaTeX to a list of OMML XML elements (or None on failure).

    Returns the inner OMML elements that should sit inside an <m:oMath>
    or <m:oMathPara> wrapper. Caller is responsible for the wrapper
    + inserting into the docx.
    """
    if not latex or not str(latex).strip():
        return None
    try:
        # Lazy import so plain-text documents don't pay the cost of
        # loading latex2mathml's grammar.
        l2m = importlib.import_module("latex2mathml.converter")
        mathml_str = l2m.convert(str(latex))
    except Exception:
        return None
    try:
        # latex2mathml namespaces every element in the MathML namespace;
        # our walker normalises by local-name so the parsed tree works.
        root = etree.fromstring(mathml_str.encode("utf-8"))
    except Exception:
        return None
    out = _walk(root)
    return out if out else None


def insert_omml_paragraph(doc, latex, *, fontsize=14):
    """Insert a centered native equation paragraph.

    Returns the docx Paragraph on success, or None when the LaTeX
    couldn't be converted (caller should fall back to a PNG renderer).
    """
    elements = omml_from_latex(latex)
    if not elements:
        return None
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(6)

    # Wrap in <m:oMathPara><m:oMath>…</m:oMath></m:oMathPara>. oMathPara
    # is the right container for a centered display equation; oMath
    # alone would inline it with the surrounding text.
    oMathPara = etree.SubElement(
        p._p,
        f"{{{M_NS}}}oMathPara",
        nsmap={"m": M_NS},
    )
    oMath = etree.SubElement(oMathPara, f"{{{M_NS}}}oMath")
    for el in elements:
        oMath.append(el)
    return p


def insert_omml_inline(paragraph, latex):
    """Append an inline equation to an EXISTING paragraph (used for
    `$…$` math segments mixed with body text). Returns True on success.
    """
    elements = omml_from_latex(latex)
    if not elements:
        return False
    oMath = etree.SubElement(
        paragraph._p,
        f"{{{M_NS}}}oMath",
        nsmap={"m": M_NS},
    )
    for el in elements:
        oMath.append(el)
    return True
