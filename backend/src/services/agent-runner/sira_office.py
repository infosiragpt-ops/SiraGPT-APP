#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sira_office.py — Referencia de edición quirúrgica y verificación visual para
DOCX, XLSX y PPTX (SiraGPT · AgentRunner).

Principios
  * Se abre el ZIP, se modifican SOLO las partes XML necesarias y todas las demás
    se copian tal cual (mismo contenido, mismo orden de entradas).
  * Cada operación tiene nombre, dirección exacta y falla en voz alta.
  * Por defecto las ediciones son atómicas: si una operación falla, no se escribe nada.
  * La verificación combina: diff de partes, diff semántico (párrafos/celdas/formas),
    render a PNG de TODAS las páginas, diff de píxeles con zonas en mm, compuesto
    antes/después con recuadros y zoom, texto del render (pdftotext) y, en Excel,
    recálculo de una COPIA con LibreOffice.

CLI (stdout = JSON):
  python3 sira_office.py inspect '{"path": "uploads/tesis.docx", "query": "2024"}'
  python3 sira_office.py edit    '{"src": "uploads/tesis.docx", "dst": "outputs/tesis-editado.docx", "ops": [...]}'
  python3 sira_office.py render  '{"path": "outputs/tesis-editado.docx", "outdir": "previews/after", "dpi": 110}'
  python3 sira_office.py diff    '{"before": "...", "after": "...", "outdir": "previews/diff"}'
  python3 sira_office.py verify  '{"before": "...", "after": "...", "outdir": "previews/verify", "expect": {...}}'
  (también: --args-file ruta.json en lugar del JSON en línea)

Dependencias: Python 3.9+, lxml, Pillow. Binarios: soffice (LibreOffice),
pdftoppm y pdftotext (poppler-utils). Fuentes recomendadas: Carlito, Caladea,
Liberation (métricas compatibles con Calibri, Cambria, Arial, Times New Roman).
"""
from __future__ import annotations

import copy
import datetime as _dt
import difflib
import glob
import io
import json
import math
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from lxml import etree

__version__ = "1.0.0"

# ─────────────────────────────────────────────────────────────────────────────
# Namespaces y unidades
# ─────────────────────────────────────────────────────────────────────────────
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
}
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def q(prefix: str, local: str) -> str:
    return "{%s}%s" % (NS[prefix], local)


def W(local: str) -> str:
    return q("w", local)


def A(local: str) -> str:
    return q("a", local)


def P(local: str) -> str:
    return q("p", local)


def S(local: str) -> str:
    return q("s", local)


EMU_PER_MM = 36000          # 1 mm = 36 000 EMU
EMU_PER_PT = 12700          # 1 pt = 12 700 EMU
TWIPS_PER_MM = 1440 / 25.4  # 1 mm ≈ 56,69 twips


def mm_to_emu(mm: float) -> int:
    return int(round(float(mm) * EMU_PER_MM))


def emu_to_mm(emu: float) -> float:
    return round(float(emu) / EMU_PER_MM, 2)


def mm_to_twips(mm: float) -> int:
    return int(round(float(mm) * TWIPS_PER_MM))


def twips_to_mm(tw: float) -> float:
    return round(float(tw) / TWIPS_PER_MM, 1)


class EditError(Exception):
    """Error de una operación: se devuelve al modelo como texto, nunca se silencia."""


def _norm_hex(color: str) -> str:
    c = str(color or "").strip().lstrip("#").upper()
    if not re.fullmatch(r"[0-9A-F]{6}", c):
        raise EditError(f"color inválido «{color}»: usa hex de 6 dígitos, p. ej. C00000")
    return c


# ─────────────────────────────────────────────────────────────────────────────
# Paquete OOXML: lee el ZIP, reescribe solo las partes tocadas
# ─────────────────────────────────────────────────────────────────────────────
_XML_DECL = re.compile(rb"^\s*<\?xml[^>]*\?>\s*")
_PARSER = etree.XMLParser(remove_blank_text=False, resolve_entities=False, huge_tree=True)


class OfficePackage:
    def __init__(self, path: str):
        self.path = path
        try:
            with zipfile.ZipFile(path) as z:
                self.infos = z.infolist()
                self.data = {i.filename: z.read(i.filename) for i in self.infos}
        except zipfile.BadZipFile as exc:
            raise EditError(f"«{os.path.basename(path)}» no es un paquete Office válido (ZIP): {exc}")
        self._xml: Dict[str, etree._Element] = {}
        self.modified: set = set()
        self.removed: set = set()

    @property
    def names(self) -> List[str]:
        return [i.filename for i in self.infos if i.filename not in self.removed]

    def has(self, name: str) -> bool:
        return name in self.data and name not in self.removed

    def xml(self, name: str) -> etree._Element:
        if name not in self._xml:
            if not self.has(name):
                raise EditError(f"la parte «{name}» no existe en el paquete")
            self._xml[name] = etree.fromstring(self.data[name], _PARSER)
        return self._xml[name]

    def touch(self, name: str) -> None:
        self.modified.add(name)

    def remove(self, name: str) -> None:
        if name in self.data:
            self.removed.add(name)
            self.modified.discard(name)

    def _serialize(self, name: str) -> bytes:
        m = _XML_DECL.match(self.data[name])
        decl = m.group(0) if m else b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        return decl + etree.tostring(self._xml[name], encoding="UTF-8", xml_declaration=False)

    def save(self, dst: str) -> List[str]:
        """Escribe el paquete. Las partes no tocadas se copian con el mismo contenido."""
        os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
        tmp = dst + ".sira-tmp"
        with zipfile.ZipFile(tmp, "w") as out:
            for info in self.infos:
                name = info.filename
                if name in self.removed:
                    continue
                payload = self._serialize(name) if name in self.modified else self.data[name]
                zi = zipfile.ZipInfo(name, date_time=info.date_time)
                zi.compress_type = info.compress_type
                zi.external_attr = info.external_attr
                zi.create_system = info.create_system
                out.writestr(zi, payload)
        os.replace(tmp, dst)
        return sorted(self.modified | self.removed)

    # relaciones ---------------------------------------------------------------
    @staticmethod
    def rels_name(part: str) -> str:
        d, b = os.path.split(part)
        return f"{d}/_rels/{b}.rels" if d else f"_rels/{b}.rels"

    def rels(self, part: str) -> Dict[str, Tuple[str, str]]:
        """rId -> (tipo, destino resuelto como nombre de parte)."""
        rn = self.rels_name(part)
        if not self.has(rn):
            return {}
        out = {}
        base = os.path.dirname(part)
        for r in self.xml(rn):
            target = r.get("Target", "")
            if r.get("TargetMode") == "External":
                resolved = target
            elif target.startswith("/"):
                resolved = target.lstrip("/")
            else:
                resolved = os.path.normpath(os.path.join(base, target)).replace("\\", "/")
            out[r.get("Id")] = (r.get("Type", ""), resolved)
        return out

    def remove_part_everywhere(self, part: str) -> None:
        """Elimina una parte, su Override en [Content_Types].xml y las relaciones que apuntan a ella."""
        self.remove(part)
        if self.has("[Content_Types].xml"):
            ct = self.xml("[Content_Types].xml")
            for ov in list(ct):
                if ov.get("PartName") == "/" + part:
                    ct.remove(ov)
                    self.touch("[Content_Types].xml")
        for name in list(self.names):
            if not name.endswith(".rels"):
                continue
            owner = name.replace("_rels/", "")[: -len(".rels")]
            base = os.path.dirname(owner)
            root = self.xml(name)
            for r in list(root):
                target = r.get("Target", "")
                resolved = target.lstrip("/") if target.startswith("/") else \
                    os.path.normpath(os.path.join(base, target)).replace("\\", "/")
                if resolved == part:
                    root.remove(r)
                    self.touch(name)


def detect_format(path: str) -> str:
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext in ("docx", "docm", "dotx"):
        return "docx"
    if ext in ("xlsx", "xlsm", "xltx"):
        return "xlsx"
    if ext in ("pptx", "pptm", "potx"):
        return "pptx"
    if ext == "pdf":
        return "pdf"
    raise EditError(f"formato no soportado: .{ext} (usa docx, xlsx, pptx o pdf)")


# ─────────────────────────────────────────────────────────────────────────────
# Orden de hijos según el esquema (Word/Excel/PowerPoint rechazan XML fuera de orden)
# ─────────────────────────────────────────────────────────────────────────────
RPR_ORDER = [W(t) for t in (
    "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof "
    "snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd "
    "fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath").split()]
PPR_ORDER = [W(t) for t in (
    "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd "
    "tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi "
    "adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc "
    "textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange").split()]
A_RPR_ORDER = [A(t) for t in (
    "ln noFill solidFill gradFill blipFill pattFill grpFill effectLst effectDag highlight uLnTx uLn "
    "uFillTx uFill latin ea cs sym hlinkClick hlinkMouseOver rtl extLst").split()]
A_SPPR_ORDER = [A(t) for t in (
    "xfrm custGeom prstGeom noFill solidFill gradFill blipFill pattFill grpFill ln effectLst effectDag "
    "scene3d sp3d extLst").split()]


def set_child_ordered(parent: etree._Element, tag: str, order: List[str]) -> etree._Element:
    """Devuelve el hijo `tag` (lo crea en la posición correcta del esquema si falta)."""
    existing = parent.find(tag)
    if existing is not None:
        return existing
    new = etree.Element(tag)
    rank = order.index(tag) if tag in order else len(order)
    for idx, child in enumerate(parent):
        if child.tag in order and order.index(child.tag) > rank:
            parent.insert(idx, new)
            return new
    parent.append(new)
    return new


def remove_children(parent: etree._Element, tags) -> None:
    for child in list(parent):
        if child.tag in tags:
            parent.remove(child)


# ─────────────────────────────────────────────────────────────────────────────
# Motor común: texto de un párrafo como segmentos (Word y PowerPoint)
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class Seg:
    node: etree._Element   # w:t / a:t (editable) o separador (w:tab, w:br, a:br…)
    run: etree._Element    # w:r / a:r (o el propio a:br)
    kind: str              # 't' editable · 'sep' separador · 'fld' texto de campo (protegido)
    text: str


def _common_prefix(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def _common_suffix(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[-1 - i] == b[-1 - i]:
        i += 1
    return i


def _preserve_space(t_node: etree._Element, text: str, is_word: bool) -> None:
    if is_word and (text != text.strip() or "  " in text):
        t_node.set(XML_SPACE, "preserve")


def _cleanup_empty(segs: List[Seg], text_tag: str, run_tag: str) -> None:
    for s in segs:
        if s.kind == "t" and s.node.getparent() is not None and not (s.node.text or ""):
            run = s.node.getparent()
            run.remove(s.node)
            content = [c for c in run if c.tag not in (W("rPr"), A("rPr"))]
            if run.tag == run_tag and not content and run.getparent() is not None:
                run.getparent().remove(run)


def replace_range_inplace(segs: List[Seg], start: int, end: int, new_text: str, *, is_word: bool) -> Dict[str, Any]:
    """
    Reemplaza el rango [start, end) del texto concatenado por `new_text` cambiando
    SOLO los caracteres que difieren. El texto nuevo hereda el formato del run
    donde empieza el cambio; los demás runs quedan intactos.
    """
    full = "".join(s.text for s in segs)
    old = full[start:end]
    pre = _common_prefix(old, new_text)
    suf = _common_suffix(old[pre:], new_text[pre:])
    ds, de = start + pre, end - suf
    ins = new_text[pre:len(new_text) - suf]
    if ds == de and not ins:
        return {"changed": False}
    spans, pos = [], 0
    for s in segs:
        spans.append((pos, pos + len(s.text)))
        pos += len(s.text)
    for k, (a, b) in enumerate(spans):
        lo, hi = max(a, ds), min(b, de)
        if lo < hi and segs[k].kind == "fld":
            raise EditError("el cambio toca el texto de un campo (cita, índice o número de página); "
                            "deja ese fragmento igual y cambia solo el texto alrededor")
    # ancla de inserción: el run donde empieza el cambio (o, si solo se inserta,
    # el run del carácter anterior, para que el texto nuevo "continúe" su formato)
    anchor = None
    if ds < de:
        for k, (a, b) in enumerate(spans):
            if a <= ds < b:
                anchor = (k, ds - a)
                break
    else:
        if ds > 0:
            for k, (a, b) in enumerate(spans):
                if a < ds <= b and segs[k].kind == "t":
                    anchor = (k, ds - a)
                    break
        if anchor is None:
            for k, (a, b) in enumerate(spans):
                if a <= ds < b and segs[k].kind == "t":
                    anchor = (k, ds - a)
                    break
        if anchor is None:
            before_ds = [k for k, (a, b) in enumerate(spans) if b <= ds]
            if before_ds:
                anchor = (before_ds[-1], len(segs[before_ds[-1]].text))
            elif segs:
                anchor = (0, 0)
    if ins and not segs:
        raise EditError("el párrafo no tiene runs de texto donde insertar")
    if ins and segs[anchor[0]].kind == "fld":
        raise EditError("la inserción cae pegada a un campo (cita/índice); inserta el texto antes o después de la frase")
    new_texts = [s.text for s in segs]
    drop_seps = []
    for k, (a, b) in enumerate(spans):
        lo, hi = max(a, ds), min(b, de)
        if lo < hi:
            if segs[k].kind == "t":
                t = new_texts[k]
                new_texts[k] = t[: lo - a] + t[hi - a:]
            else:
                drop_seps.append(k)
    if ins:
        k, off = anchor
        ref = segs[k]
        if ref.kind == "t":
            t = new_texts[k]
            new_texts[k] = t[:off] + ins + t[off:]
        elif is_word:
            # el ancla es un separador (w:tab / w:br): nuevo w:t en el mismo run, justo después
            created = etree.Element(W("t"))
            created.text = ins
            _preserve_space(created, ins, True)
            ref.node.addnext(created)
        else:
            # PowerPoint: a:br cuelga de a:p, así que se crea un a:r completo con el formato del salto
            new_r = etree.Element(A("r"))
            src = ref.node.find(A("rPr"))
            if src is None:
                near = next((s.run.find(A("rPr")) for s in segs if s.kind == "t" and s.run.find(A("rPr")) is not None), None)
                src = near
            if src is not None:
                new_r.append(copy.deepcopy(src))
            etree.SubElement(new_r, A("t")).text = ins
            ref.node.addnext(new_r)
    changed_idx = set()
    for k, s in enumerate(segs):
        if s.kind == "t" and new_texts[k] != s.text:
            s.node.text = new_texts[k]
            _preserve_space(s.node, new_texts[k], is_word)
            changed_idx.add(k)
    for k in drop_seps:
        n = segs[k].node
        if n.getparent() is not None:
            n.getparent().remove(n)
    _cleanup_empty([segs[k] for k in sorted(changed_idx)], W("t") if is_word else A("t"), W("r") if is_word else A("r"))
    return {"changed": True, "deleted": full[ds:de], "inserted": ins}


def apply_text_diff(get_segs, new_text: str, *, is_word: bool) -> Dict[str, Any]:
    """
    Lleva el texto de un párrafo a `new_text` con cambios mínimos palabra a palabra
    (difflib). Lo que no cambia, incluidas citas y campos, queda intacto con su formato.
    """
    segs = get_segs()
    old = "".join(s.text for s in segs)
    if old == new_text:
        return {"changed": False, "edits": 0}
    tok = re.compile(r"\s+|[^\s]+")
    a_toks = tok.findall(old)
    b_toks = tok.findall(new_text)
    sm = difflib.SequenceMatcher(a=a_toks, b=b_toks, autojunk=False)
    a_off = [0]
    for t in a_toks:
        a_off.append(a_off[-1] + len(t))
    ops = [op for op in sm.get_opcodes() if op[0] != "equal"]
    edits = 0
    for tag, i1, i2, j1, j2 in reversed(ops):  # de derecha a izquierda: los offsets previos no cambian
        start, end = a_off[i1], a_off[i2]
        repl = "".join(b_toks[j1:j2])
        res = replace_range_inplace(get_segs(), start, end, repl, is_word=is_word)
        edits += 1 if res.get("changed") else 0
    return {"changed": edits > 0, "edits": edits}


# ─────────────────────────────────────────────────────────────────────────────
# WORD (.docx)
# ─────────────────────────────────────────────────────────────────────────────
_W_CONTAINERS = {W("hyperlink"), W("ins"), W("smartTag"), W("sdt"), W("sdtContent"), W("customXml"),
                 W("moveTo"), W("fldSimple"), W("dir"), W("bdo")}
_W_SKIP = {W("del"), W("moveFrom"), W("pPr")}


def docx_text_parts(pkg: OfficePackage, scope: str = "body") -> List[str]:
    parts = ["word/document.xml"]
    if scope == "all":
        extra = sorted(n for n in pkg.names if re.fullmatch(r"word/(header|footer)\d*\.xml", n))
        extra += [n for n in ("word/footnotes.xml", "word/endnotes.xml") if pkg.has(n)]
        parts += extra
    elif scope not in ("body", None):
        if not pkg.has(scope):
            raise EditError(f"no existe la parte «{scope}»")
        parts = [scope]
    return parts


def docx_paragraphs(pkg: OfficePackage, part: str = "word/document.xml") -> List[etree._Element]:
    """Párrafos en orden de documento (incluye tablas; excluye la copia VML de mc:Fallback)."""
    root = pkg.xml(part)
    out = []
    for p in root.iter(W("p")):
        if any(anc.tag == q("mc", "Fallback") for anc in p.iterancestors()):
            continue
        out.append(p)
    return out


def _w_runs(p: etree._Element) -> List[etree._Element]:
    runs: List[etree._Element] = []

    def walk(el):
        for ch in el:
            if ch.tag == W("r"):
                runs.append(ch)
            elif ch.tag in _W_SKIP:
                continue
            elif ch.tag in _W_CONTAINERS:
                walk(ch)

    walk(p)
    return runs


def docx_segments(p: etree._Element) -> List[Seg]:
    segs: List[Seg] = []
    depth, in_result = 0, False
    for r in _w_runs(p):
        in_simple = any(anc.tag == W("fldSimple") for anc in r.iterancestors() if anc is not p)
        for ch in r:
            tag = ch.tag
            if tag == W("fldChar"):
                t = ch.get(W("fldCharType"))
                if t == "begin":
                    depth += 1
                elif t == "separate":
                    in_result = depth > 0
                elif t == "end":
                    depth = max(0, depth - 1)
                    in_result = False if depth == 0 else in_result
                continue
            protected = in_result or in_simple
            if tag == W("t"):
                segs.append(Seg(ch, r, "fld" if protected else "t", ch.text or ""))
            elif tag == W("tab"):
                segs.append(Seg(ch, r, "sep", "\t"))
            elif tag in (W("br"), W("cr")):
                segs.append(Seg(ch, r, "sep", "\n"))
            elif tag == W("noBreakHyphen"):
                segs.append(Seg(ch, r, "sep", "-"))
    return segs


def docx_para_text(p: etree._Element) -> str:
    return "".join(s.text for s in docx_segments(p))


def _w_style(p: etree._Element) -> Optional[str]:
    ps = p.find(f"{W('pPr')}/{W('pStyle')}")
    return ps.get(W("val")) if ps is not None else None


def _w_run_fmt(r: etree._Element) -> Dict[str, Any]:
    rpr = r.find(W("rPr"))
    out: Dict[str, Any] = {}
    if rpr is None:
        return out

    def on(tag):
        el = rpr.find(W(tag))
        return el is not None and el.get(W("val"), "true") not in ("0", "false", "none")

    if on("b"):
        out["b"] = True
    if on("i"):
        out["i"] = True
    u = rpr.find(W("u"))
    if u is not None and u.get(W("val"), "single") != "none":
        out["u"] = True
    sz = rpr.find(W("sz"))
    if sz is not None and sz.get(W("val")):
        out["pt"] = int(sz.get(W("val"))) / 2
    c = rpr.find(W("color"))
    if c is not None and c.get(W("val")) not in (None, "auto"):
        out["color"] = c.get(W("val"))
    f = rpr.find(W("rFonts"))
    if f is not None and (f.get(W("ascii")) or f.get(W("hAnsi"))):
        out["font"] = f.get(W("ascii")) or f.get(W("hAnsi"))
    h = rpr.find(W("highlight"))
    if h is not None:
        out["highlight"] = h.get(W("val"))
    return out


def _w_para_fmt_runs(p: etree._Element, limit: int = 12) -> List[Dict[str, Any]]:
    out = []
    for r in _w_runs(p):
        t = "".join((c.text or "") for c in r if c.tag == W("t"))
        if not t:
            continue
        item = {"t": t[:80]}
        item.update(_w_run_fmt(r))
        out.append(item)
        if len(out) >= limit:
            break
    return out


def docx_inspect(pkg: OfficePackage, *, query: Optional[str] = None, start: int = 0, limit: int = 200,
                 detail: bool = False, scope: str = "body") -> Dict[str, Any]:
    doc = pkg.xml("word/document.xml")
    body = doc.find(W("body"))
    sect = body.find(W("sectPr")) if body is not None else None
    page = None
    if sect is not None:
        pg, mar = sect.find(W("pgSz")), sect.find(W("pgMar"))
        page = {}
        if pg is not None:
            page["width_mm"] = twips_to_mm(pg.get(W("w"), 0))
            page["height_mm"] = twips_to_mm(pg.get(W("h"), 0))
            page["orientation"] = pg.get(W("orient"), "portrait")
        if mar is not None:
            page["margins_mm"] = {k: twips_to_mm(mar.get(W(k), 0)) for k in ("top", "bottom", "left", "right")}
    paras = docx_paragraphs(pkg)
    tables = list(doc.iter(W("tbl")))
    tbl_index = {id(t): n for n, t in enumerate(tables)}
    items = []
    q_low = query.lower() if query else None
    for i, p in enumerate(paras):
        if i < start and not q_low:
            continue
        text = docx_para_text(p)
        if q_low and q_low not in text.lower():
            continue
        item: Dict[str, Any] = {"i": i, "text": text if len(text) <= 300 else text[:300] + "…"}
        st = _w_style(p)
        if st:
            item["style"] = st
        tc = next((a for a in p.iterancestors() if a.tag == W("tc")), None)
        if tc is not None:
            tr = tc.getparent()
            tbl = tr.getparent()
            rows = [x for x in tbl if x.tag == W("tr")]
            cells = [x for x in tr if x.tag == W("tc")]
            item["table"] = {"t": tbl_index.get(id(tbl)), "row": rows.index(tr), "col": cells.index(tc)}
        if any(s.kind == "fld" for s in docx_segments(p)):
            item["has_field"] = True
        if detail or q_low:
            item["runs"] = _w_para_fmt_runs(p)
        items.append(item)
        if len(items) >= limit:
            break
    out: Dict[str, Any] = {
        "format": "docx",
        "page": page,
        "stats": {"paragraphs": len(paras), "tables": len(tables),
                  "images": sum(1 for n in pkg.names if n.startswith("word/media/")),
                  "words": sum(len(docx_para_text(p).split()) for p in paras)},
        "paragraphs": items,
        "tables": [{"t": n, "rows": len([x for x in t if x.tag == W("tr")]),
                    "cols": max((len([c for c in tr if c.tag == W("tc")]) for tr in t if tr.tag == W("tr")), default=0)}
                   for n, t in enumerate(tables)][:50],
    }
    if scope == "all":
        extra = {}
        for part in docx_text_parts(pkg, "all")[1:]:
            txt = "\n".join(t for t in (docx_para_text(p) for p in docx_paragraphs(pkg, part)) if t)
            if txt:
                extra[part] = txt[:500]
        out["other_parts"] = extra
    if len(items) >= limit:
        out["truncated"] = True
    return out


# -- partir runs (formato de fragmentos y control de cambios) ------------------
def _w_run_len(child: etree._Element) -> int:
    if child.tag in (W("t"), W("delText")):
        return len(child.text or "")
    if child.tag in (W("tab"), W("br"), W("cr"), W("noBreakHyphen")):
        return 1
    return 0


def _w_split_run(run: etree._Element, offset: int) -> etree._Element:
    """Parte `run` en `offset` (caracteres visibles). Devuelve el run derecho, ya insertado."""
    rpr = run.find(W("rPr"))
    content = [c for c in run if c.tag != W("rPr")]
    pos = 0
    right = etree.Element(W("r"), attrib=dict(run.attrib))
    if rpr is not None:
        right.append(copy.deepcopy(rpr))
    moving = False
    for c in content:
        n = _w_run_len(c)
        if moving:
            run.remove(c)
            right.append(c)
            continue
        if pos + n <= offset:
            pos += n
            continue
        # el corte cae dentro de este hijo
        cut = offset - pos
        if c.tag == W("t") and 0 < cut < n:
            left_text, right_text = c.text[:cut], c.text[cut:]
            c.text = left_text
            _preserve_space(c, left_text, True)
            nt = etree.SubElement(right, W("t"))
            nt.text = right_text
            _preserve_space(nt, right_text, True)
        else:
            run.remove(c)
            right.append(c)
        moving = True
        pos += n
    parent = run.getparent()
    parent.insert(parent.index(run) + 1, right)
    return right


def _w_isolate(p: etree._Element, start: int, end: int) -> List[etree._Element]:
    """Garantiza cortes en start y end y devuelve los runs que cubren [start, end)."""
    for cut in (end, start):
        pos = 0
        for r in _w_runs(p):
            n = sum(_w_run_len(c) for c in r if c.tag != W("rPr"))
            if pos < cut < pos + n:
                _w_split_run(r, cut - pos)
                break
            pos += n
    out, pos = [], 0
    for r in _w_runs(p):
        n = sum(_w_run_len(c) for c in r if c.tag != W("rPr"))
        if n and pos >= start and pos + n <= end:
            out.append(r)
        pos += n
    return out


def _w_apply_rpr(run: etree._Element, fmt: Dict[str, Any]) -> None:
    rpr = run.find(W("rPr"))
    if rpr is None:
        rpr = etree.Element(W("rPr"))
        run.insert(0, rpr)

    def toggle(tag, value):
        el = rpr.find(W(tag))
        if value:
            if el is None:
                el = set_child_ordered(rpr, W(tag), RPR_ORDER)
            if W("val") in el.attrib:
                del el.attrib[W("val")]
        else:
            if el is None:
                el = set_child_ordered(rpr, W(tag), RPR_ORDER)
            el.set(W("val"), "0")

    if "bold" in fmt:
        toggle("b", bool(fmt["bold"]))
        if rpr.find(W("bCs")) is not None:
            toggle("bCs", bool(fmt["bold"]))
    if "italic" in fmt:
        toggle("i", bool(fmt["italic"]))
    if "underline" in fmt:
        u = set_child_ordered(rpr, W("u"), RPR_ORDER)
        u.set(W("val"), "single" if fmt["underline"] else "none")
    if fmt.get("size_pt"):
        half = str(int(round(float(fmt["size_pt"]) * 2)))
        set_child_ordered(rpr, W("sz"), RPR_ORDER).set(W("val"), half)
        set_child_ordered(rpr, W("szCs"), RPR_ORDER).set(W("val"), half)
    if fmt.get("color"):
        c = set_child_ordered(rpr, W("color"), RPR_ORDER)
        c.set(W("val"), _norm_hex(fmt["color"]))
        for k in (W("themeColor"), W("themeShade"), W("themeTint")):
            c.attrib.pop(k, None)
    if fmt.get("font"):
        f = set_child_ordered(rpr, W("rFonts"), RPR_ORDER)
        for k in ("ascii", "hAnsi", "cs", "eastAsia"):
            f.set(W(k), str(fmt["font"]))
        for k in ("asciiTheme", "hAnsiTheme", "cstheme", "eastAsiaTheme"):
            f.attrib.pop(W(k), None)
    if "highlight" in fmt:
        if fmt["highlight"]:
            set_child_ordered(rpr, W("highlight"), RPR_ORDER).set(W("val"), str(fmt["highlight"]))
        else:
            remove_children(rpr, {W("highlight")})


def _w_next_rev_id(root: etree._Element) -> int:
    mx = 0
    for el in root.iter():
        v = el.get(W("id"))
        if v and v.lstrip("-").isdigit():
            mx = max(mx, int(v))
    return mx + 1


def _w_tracked_replace(p: etree._Element, root: etree._Element, start: int, end: int, new_text: str,
                       author: str, date: str) -> Dict[str, Any]:
    full = docx_para_text(p)
    old = full[start:end]
    pre = _common_prefix(old, new_text)
    suf = _common_suffix(old[pre:], new_text[pre:])
    ds, de = start + pre, end - suf
    ins = new_text[pre:len(new_text) - suf]
    if ds == de and not ins:
        return {"changed": False}
    for s_, span in zip(docx_segments(p), _spans(docx_segments(p))):
        if s_.kind == "fld" and max(span[0], ds) < min(span[1], de):
            raise EditError("el cambio toca el texto de un campo (cita/índice); deja ese fragmento igual")
    rev = _w_next_rev_id(root)
    ref_run = None
    last_del = None
    if ds < de:
        runs = _w_isolate(p, ds, de)
        if not runs:
            raise EditError("no se pudo aislar el rango a reemplazar")
        ref_run = runs[0]
        group: List[etree._Element] = []
        groups = []
        for r in runs:
            if group and r.getparent() is not group[-1].getparent():
                groups.append(group)
                group = []
            group.append(r)
        if group:
            groups.append(group)
        for g in groups:
            parent = g[0].getparent()
            wdel = etree.Element(W("del"), {W("id"): str(rev), W("author"): author, W("date"): date})
            rev += 1
            parent.insert(parent.index(g[0]), wdel)
            for r in g:
                parent.remove(r)
                for t in r.findall(W("t")):
                    t.tag = W("delText")
                wdel.append(r)
            last_del = wdel
    if ins:
        if ref_run is None:
            # inserción pura: heredar el formato del run anterior
            before = _w_isolate(p, 0, ds) if ds > 0 else []
            ref_run = before[-1] if before else (_w_runs(p)[0] if _w_runs(p) else None)
        new_run = etree.Element(W("r"))
        if ref_run is not None and ref_run.find(W("rPr")) is not None:
            new_run.append(copy.deepcopy(ref_run.find(W("rPr"))))
        t = etree.SubElement(new_run, W("t"))
        t.text = ins
        _preserve_space(t, ins, True)
        wins = etree.Element(W("ins"), {W("id"): str(rev), W("author"): author, W("date"): date})
        wins.append(new_run)
        if last_del is not None:
            parent = last_del.getparent()
            parent.insert(parent.index(last_del) + 1, wins)
        elif ref_run is not None:
            parent = ref_run.getparent()
            idx = parent.index(ref_run) + (1 if ds > 0 else 0)
            parent.insert(idx, wins)
        else:
            p.append(wins)
    return {"changed": True, "deleted": full[ds:de], "inserted": ins, "tracked": True}


def _spans(segs: List[Seg]) -> List[Tuple[int, int]]:
    out, pos = [], 0
    for s in segs:
        out.append((pos, pos + len(s.text)))
        pos += len(s.text)
    return out


def _find_all(text: str, needle: str, ignore_case: bool) -> List[int]:
    if not needle:
        raise EditError("«find» no puede estar vacío")
    hay, ndl = (text.lower(), needle.lower()) if ignore_case else (text, needle)
    out, i = [], hay.find(ndl)
    while i >= 0:
        out.append(i)
        i = hay.find(ndl, i + len(ndl))
    return out


def _para_at(pkg: OfficePackage, idx: Any, part: str = "word/document.xml") -> etree._Element:
    paras = docx_paragraphs(pkg, part)
    try:
        i = int(idx)
    except (TypeError, ValueError):
        raise EditError(f"«paragraph» debe ser un número de párrafo (recibí {idx!r})")
    if not 0 <= i < len(paras):
        raise EditError(f"el párrafo {i} no existe (el documento tiene {len(paras)}, índices 0–{len(paras) - 1})")
    return paras[i]


def docx_apply(pkg: OfficePackage, op: Dict[str, Any], *, track: bool, author: str, date: str) -> Dict[str, Any]:
    kind = op.get("op")
    part = op.get("part", "word/document.xml")
    if kind == "replace_text":
        find, repl = op.get("find"), op.get("replace", "")
        if find is None:
            raise EditError("replace_text necesita «find»")
        ignore_case = bool(op.get("ignore_case", False))
        occurrence = op.get("occurrence")
        want_all = bool(op.get("all", False))
        parts = [part] if "part" in op else docx_text_parts(pkg, op.get("scope", "body"))
        candidates = []  # (part, paragraph_index, p, pos)
        for pt in parts:
            paras = docx_paragraphs(pkg, pt)
            idxs = [int(op["paragraph"])] if "paragraph" in op and pt == "word/document.xml" else range(len(paras))
            for i in idxs:
                if not 0 <= i < len(paras):
                    raise EditError(f"el párrafo {i} no existe")
                for pos in _find_all(docx_para_text(paras[i]), find, ignore_case):
                    candidates.append((pt, i, paras[i], pos))
        if not candidates:
            where = f" en el párrafo {op['paragraph']}" if "paragraph" in op else ""
            raise EditError(f"no encontré «{find}»{where}. Usa inspect con query para ubicar el texto exacto")
        if not want_all:
            if occurrence is None and len(candidates) > 1:
                locs = ", ".join(f"párrafo {c[1]}" for c in candidates[:8])
                raise EditError(f"«{find}» aparece {len(candidates)} veces ({locs}). "
                                "Indica «paragraph», «occurrence» (1 = la primera) o «all»: true")
            n = int(occurrence or 1)
            if not 1 <= n <= len(candidates):
                raise EditError(f"occurrence={n} fuera de rango (hay {len(candidates)} coincidencias)")
            candidates = [candidates[n - 1]]
        where = []
        # de atrás hacia adelante dentro de cada párrafo para no desplazar offsets
        for pt, i, p, pos in sorted(candidates, key=lambda c: (c[0], c[1], -c[3])):
            before = docx_para_text(p)
            if track:
                res = _w_tracked_replace(p, pkg.xml(pt), pos, pos + len(find), repl, author, date)
            else:
                res = replace_range_inplace(docx_segments(p), pos, pos + len(find), repl, is_word=True)
            if res.get("changed"):
                pkg.touch(pt)
            where.append({"part": pt, "paragraph": i, "before": before[:200], "after": docx_para_text(p)[:200]})
        return {"op": kind, "matches": len(candidates), "where": where}

    if kind == "set_paragraph_text":
        p = _para_at(pkg, op.get("paragraph"), part)
        before = docx_para_text(p)
        text = str(op.get("text", ""))
        if track:
            res = _w_tracked_replace(p, pkg.xml(part), 0, len(before), text, author, date)
        else:
            res = apply_text_diff(lambda: docx_segments(p), text, is_word=True)
        if res.get("changed"):
            pkg.touch(part)
        return {"op": kind, "paragraph": int(op["paragraph"]), "before": before[:200], "after": docx_para_text(p)[:200]}

    if kind == "insert_paragraph_after":
        ref = _para_at(pkg, op.get("paragraph"), part)
        new_p = etree.Element(W("p"))
        ref_ppr = ref.find(W("pPr"))
        if ref_ppr is not None:
            ppr = copy.deepcopy(ref_ppr)
            remove_children(ppr, {W("sectPr"), W("pPrChange")})
            new_p.append(ppr)
        if op.get("style"):
            ppr = new_p.find(W("pPr"))
            if ppr is None:
                ppr = etree.SubElement(new_p, W("pPr"))
            set_child_ordered(ppr, W("pStyle"), PPR_ORDER).set(W("val"), str(op["style"]))
        runs = [r for r in _w_runs(ref) if r.find(W("t")) is not None]
        r = etree.SubElement(new_p, W("r"))
        if runs and runs[0].find(W("rPr")) is not None:
            r.append(copy.deepcopy(runs[0].find(W("rPr"))))
        t = etree.SubElement(r, W("t"))
        t.text = str(op.get("text", ""))
        _preserve_space(t, t.text, True)
        if track:
            wins = etree.Element(W("ins"), {W("id"): str(_w_next_rev_id(pkg.xml(part))), W("author"): author, W("date"): date})
            new_p.remove(r)
            wins.append(r)
            new_p.append(wins)
        parent = ref.getparent()
        parent.insert(parent.index(ref) + 1, new_p)
        pkg.touch(part)
        return {"op": kind, "after_paragraph": int(op["paragraph"]), "new_paragraph": int(op["paragraph"]) + 1}

    if kind == "delete_paragraph":
        p = _para_at(pkg, op.get("paragraph"), part)
        ppr = p.find(W("pPr"))
        if ppr is not None and ppr.find(W("sectPr")) is not None:
            raise EditError("ese párrafo cierra una sección (tiene sectPr); no se puede borrar sin romper el diseño")
        parent = p.getparent()
        if parent.tag == W("tc") and len([x for x in parent if x.tag == W("p")]) == 1:
            raise EditError("es el único párrafo de una celda de tabla; usa set_paragraph_text con texto vacío")
        before = docx_para_text(p)
        if track:
            for r in _w_runs(p):
                par = r.getparent()
                wdel = etree.Element(W("del"), {W("id"): str(_w_next_rev_id(pkg.xml(part))), W("author"): author, W("date"): date})
                par.insert(par.index(r), wdel)
                par.remove(r)
                for t in r.findall(W("t")):
                    t.tag = W("delText")
                wdel.append(r)
            ppr = p.find(W("pPr"))
            if ppr is None:
                ppr = etree.Element(W("pPr"))
                p.insert(0, ppr)
            rpr = set_child_ordered(ppr, W("rPr"), PPR_ORDER)
            etree.SubElement(rpr, W("del"), {W("id"): str(_w_next_rev_id(pkg.xml(part))), W("author"): author, W("date"): date})
        else:
            parent.remove(p)
        pkg.touch(part)
        return {"op": kind, "paragraph": int(op["paragraph"]), "deleted_text": before[:200]}

    if kind == "set_format":
        p = _para_at(pkg, op.get("paragraph"), part)
        text = docx_para_text(p)
        if op.get("find"):
            hits = _find_all(text, op["find"], bool(op.get("ignore_case", False)))
            if not hits:
                raise EditError(f"no encontré «{op['find']}» en el párrafo {op['paragraph']}")
            n = int(op.get("occurrence", 1))
            if len(hits) > 1 and "occurrence" not in op and not op.get("all"):
                raise EditError(f"«{op['find']}» aparece {len(hits)} veces en el párrafo; indica «occurrence» o «all»")
            ranges = [(h, h + len(op["find"])) for h in (hits if op.get("all") else [hits[n - 1]])]
        else:
            ranges = [(0, len(text))]
        fmt = {k: op[k] for k in ("bold", "italic", "underline", "size_pt", "color", "font", "highlight") if k in op}
        if not fmt:
            raise EditError("set_format necesita al menos una propiedad: bold, italic, underline, size_pt, color, font o highlight")
        touched = 0
        for a, b in sorted(ranges, reverse=True):
            for r in _w_isolate(p, a, b):
                _w_apply_rpr(r, fmt)
                touched += 1
        pkg.touch(part)
        return {"op": kind, "paragraph": int(op["paragraph"]), "runs_formatted": touched, "format": fmt}

    if kind == "set_paragraph_format":
        p = _para_at(pkg, op.get("paragraph"), part)
        ppr = p.find(W("pPr"))
        if ppr is None:
            ppr = etree.Element(W("pPr"))
            p.insert(0, ppr)
        applied = {}
        if op.get("align"):
            val = {"left": "left", "center": "center", "right": "right", "justify": "both", "both": "both"}.get(op["align"])
            if not val:
                raise EditError("align debe ser left, center, right o justify")
            set_child_ordered(ppr, W("jc"), PPR_ORDER).set(W("val"), val)
            applied["align"] = op["align"]
        if any(k in op for k in ("space_before_pt", "space_after_pt", "line_spacing")):
            sp = set_child_ordered(ppr, W("spacing"), PPR_ORDER)
            if "space_before_pt" in op:
                sp.set(W("before"), str(int(round(float(op["space_before_pt"]) * 20))))
                sp.attrib.pop(W("beforeAutospacing"), None)
            if "space_after_pt" in op:
                sp.set(W("after"), str(int(round(float(op["space_after_pt"]) * 20))))
                sp.attrib.pop(W("afterAutospacing"), None)
            if "line_spacing" in op:
                sp.set(W("line"), str(int(round(float(op["line_spacing"]) * 240))))
                sp.set(W("lineRule"), "auto")
            applied.update({k: op[k] for k in ("space_before_pt", "space_after_pt", "line_spacing") if k in op})
        if any(k in op for k in ("indent_left_mm", "first_line_mm", "hanging_mm")):
            ind = set_child_ordered(ppr, W("ind"), PPR_ORDER)
            if "indent_left_mm" in op:
                ind.set(W("left"), str(mm_to_twips(op["indent_left_mm"])))
                ind.attrib.pop(W("start"), None)
            if "first_line_mm" in op:
                ind.set(W("firstLine"), str(mm_to_twips(op["first_line_mm"])))
                ind.attrib.pop(W("hanging"), None)
            if "hanging_mm" in op:
                ind.set(W("hanging"), str(mm_to_twips(op["hanging_mm"])))
                ind.attrib.pop(W("firstLine"), None)
            applied.update({k: op[k] for k in ("indent_left_mm", "first_line_mm", "hanging_mm") if k in op})
        if not applied:
            raise EditError("set_paragraph_format necesita align, space_before_pt, space_after_pt, line_spacing, indent_left_mm, first_line_mm o hanging_mm")
        pkg.touch(part)
        return {"op": kind, "paragraph": int(op["paragraph"]), "applied": applied}

    if kind == "set_cell_text":
        doc = pkg.xml(part)
        tables = list(doc.iter(W("tbl")))
        t, row, col = int(op.get("table", -1)), int(op.get("row", -1)), int(op.get("col", -1))
        if not 0 <= t < len(tables):
            raise EditError(f"la tabla {t} no existe (hay {len(tables)})")
        rows = [x for x in tables[t] if x.tag == W("tr")]
        if not 0 <= row < len(rows):
            raise EditError(f"la fila {row} no existe en la tabla {t} (hay {len(rows)})")
        cells = [x for x in rows[row] if x.tag == W("tc")]
        if not 0 <= col < len(cells):
            raise EditError(f"la columna {col} no existe en la fila {row} (hay {len(cells)})")
        ps = [x for x in cells[col] if x.tag == W("p")]
        before = "\n".join(docx_para_text(x) for x in ps)
        res = apply_text_diff(lambda: docx_segments(ps[0]), str(op.get("text", "")), is_word=True)
        for extra in ps[1:]:
            if docx_para_text(extra):
                replace_range_inplace(docx_segments(extra), 0, len(docx_para_text(extra)), "", is_word=True)
        if res.get("changed") or len(ps) > 1:
            pkg.touch(part)
        return {"op": kind, "table": t, "row": row, "col": col, "before": before[:200], "after": str(op.get("text", ""))[:200]}

    raise EditError(f"operación desconocida para docx: «{kind}». Usa replace_text, set_paragraph_text, "
                    "insert_paragraph_after, delete_paragraph, set_format, set_paragraph_format o set_cell_text")


# ─────────────────────────────────────────────────────────────────────────────
# EXCEL (.xlsx)
# ─────────────────────────────────────────────────────────────────────────────
_REF_RE = re.compile(r"^\$?([A-Za-z]{1,3})\$?(\d+)$")
_BUILTIN_NUMFMT = {0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%",
                   11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm",
                   17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
                   22: "m/d/yy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)",
                   40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@"}


def col_to_idx(col: str) -> int:
    n = 0
    for ch in col.upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def idx_to_col(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def parse_ref(ref: str) -> Tuple[str, int, int]:
    m = _REF_RE.match(str(ref).strip())
    if not m:
        raise EditError(f"referencia de celda inválida «{ref}» (usa p. ej. C5)")
    col, row = m.group(1).upper(), int(m.group(2))
    return f"{col}{row}", col_to_idx(col), row


def expand_range(rng: str) -> List[str]:
    if ":" not in rng:
        return [parse_ref(rng)[0]]
    a, b = rng.split(":", 1)
    _, c1, r1 = parse_ref(a)
    _, c2, r2 = parse_ref(b)
    if (abs(c2 - c1) + 1) * (abs(r2 - r1) + 1) > 5000:
        raise EditError("rango demasiado grande (máx. 5000 celdas por operación)")
    return [f"{idx_to_col(c)}{r}" for r in range(min(r1, r2), max(r1, r2) + 1) for c in range(min(c1, c2), max(c1, c2) + 1)]


def xl_sheets(pkg: OfficePackage) -> List[Dict[str, str]]:
    wb = pkg.xml("xl/workbook.xml")
    rels = pkg.rels("xl/workbook.xml")
    out = []
    sheets = wb.find(S("sheets"))
    for sh in (sheets if sheets is not None else []):
        rid = sh.get(q("r", "id"))
        out.append({"name": sh.get("name"), "part": rels.get(rid, ("", ""))[1], "state": sh.get("state", "visible")})
    return out


def _xl_sheet_part(pkg: OfficePackage, sheet: Any) -> str:
    sheets = xl_sheets(pkg)
    if sheet is None:
        return sheets[0]["part"]
    for i, s in enumerate(sheets):
        if s["name"] == sheet or str(i + 1) == str(sheet):
            return s["part"]
    names = ", ".join(s["name"] for s in sheets)
    raise EditError(f"la hoja «{sheet}» no existe (hojas: {names})")


def _xl_shared_strings(pkg: OfficePackage) -> List[str]:
    if not pkg.has("xl/sharedStrings.xml"):
        return []
    out = []
    for si in pkg.xml("xl/sharedStrings.xml").findall(S("si")):
        out.append("".join(t.text or "" for t in si.iter(S("t"))))
    return out


def _xl_cell_value(c: etree._Element, sst: List[str]) -> Tuple[Any, Optional[str], str]:
    t = c.get("t", "n")
    f = c.find(S("f"))
    formula = None
    if f is not None:
        formula = f.text or (f"(compartida si={f.get('si')})" if f.get("t") == "shared" else "")
    v = c.find(S("v"))
    raw = v.text if v is not None else None
    if t == "s" and raw is not None:
        idx = int(raw)
        return (sst[idx] if idx < len(sst) else None), formula, "s"
    if t == "inlineStr":
        return "".join(x.text or "" for x in c.iter(S("t"))), formula, "s"
    if t == "b":
        return raw == "1", formula, "b"
    if t in ("str", "e"):
        return raw, formula, t
    if raw is None:
        return None, formula, "n"
    try:
        num = float(raw)
        return (int(num) if num.is_integer() and "E" not in raw.upper() and "." not in raw else num), formula, "n"
    except ValueError:
        return raw, formula, "n"


class XlStyles:
    def __init__(self, pkg: OfficePackage):
        self.pkg = pkg
        self.ok = pkg.has("xl/styles.xml")
        self.root = pkg.xml("xl/styles.xml") if self.ok else None

    def _list(self, tag, child):
        if not self.ok:
            return None
        el = self.root.find(S(tag))
        return el

    def describe(self, s: int) -> Dict[str, Any]:
        if not self.ok:
            return {}
        xfs = self.root.find(S("cellXfs"))
        if xfs is None or s >= len(xfs):
            return {}
        xf = xfs[s]
        out: Dict[str, Any] = {}
        nid = int(xf.get("numFmtId", 0))
        if nid:
            code = _BUILTIN_NUMFMT.get(nid)
            nf = self.root.find(S("numFmts"))
            if nf is not None:
                for n in nf:
                    if int(n.get("numFmtId", -1)) == nid:
                        code = n.get("formatCode")
            out["numfmt"] = code or str(nid)
        fonts = self.root.find(S("fonts"))
        fid = int(xf.get("fontId", 0))
        if fonts is not None and fid < len(fonts):
            font = fonts[fid]
            if font.find(S("b")) is not None and font.find(S("b")).get("val", "1") not in ("0", "false"):
                out["bold"] = True
            if font.find(S("i")) is not None and font.find(S("i")).get("val", "1") not in ("0", "false"):
                out["italic"] = True
            col = font.find(S("color"))
            if col is not None and col.get("rgb"):
                out["color"] = col.get("rgb")[-6:]
        fills = self.root.find(S("fills"))
        flid = int(xf.get("fillId", 0))
        if fills is not None and flid < len(fills):
            pf = fills[flid].find(S("patternFill"))
            if pf is not None and pf.get("patternType") == "solid":
                fg = pf.find(S("fgColor"))
                if fg is not None and fg.get("rgb"):
                    out["fill"] = fg.get("rgb")[-6:]
        al = xf.find(S("alignment"))
        if al is not None and al.get("horizontal"):
            out["align"] = al.get("horizontal")
        return out

    def derive(self, s: int, fmt: Dict[str, Any], cache: Dict) -> int:
        """Nuevo índice de estilo = estilo `s` + cambios de `fmt` (reutiliza uno idéntico si existe)."""
        if not self.ok:
            raise EditError("el libro no tiene styles.xml; no se puede aplicar formato")
        key = (s, json.dumps(fmt, sort_keys=True))
        if key in cache:
            return cache[key]
        xfs = self.root.find(S("cellXfs"))
        base = xfs[s] if s < len(xfs) else xfs[0]
        xf = copy.deepcopy(base)
        if any(k in fmt for k in ("bold", "italic", "color", "font_size")):
            fonts = self.root.find(S("fonts"))
            font = copy.deepcopy(fonts[int(xf.get("fontId", 0))])
            order = [S(t) for t in "b i strike condense extend outline shadow u vertAlign sz color name family charset scheme".split()]
            for k, tag in (("bold", "b"), ("italic", "i")):
                if k in fmt:
                    remove_children(font, {S(tag)})
                    if fmt[k]:
                        set_child_ordered(font, S(tag), order)
            if fmt.get("font_size"):
                set_child_ordered(font, S("sz"), order).set("val", str(fmt["font_size"]))
            if fmt.get("color"):
                c = set_child_ordered(font, S("color"), order)
                for a in list(c.attrib):
                    del c.attrib[a]
                c.set("rgb", "FF" + _norm_hex(fmt["color"]))
            fonts.append(font)
            fonts.set("count", str(len(fonts)))
            xf.set("fontId", str(len(fonts) - 1))
            xf.set("applyFont", "1")
        if "fill" in fmt:
            fills = self.root.find(S("fills"))
            if fmt["fill"]:
                fill = etree.SubElement(fills, S("fill"))
                pf = etree.SubElement(fill, S("patternFill"), patternType="solid")
                etree.SubElement(pf, S("fgColor"), rgb="FF" + _norm_hex(fmt["fill"]))
                etree.SubElement(pf, S("bgColor"), indexed="64")
                fills.set("count", str(len(fills)))
                xf.set("fillId", str(len(fills) - 1))
            else:
                xf.set("fillId", "0")
            xf.set("applyFill", "1")
        if fmt.get("number_format"):
            code = str(fmt["number_format"])
            nid = next((k for k, v in _BUILTIN_NUMFMT.items() if v == code), None)
            if nid is None:
                nf = self.root.find(S("numFmts"))
                if nf is None:
                    nf = etree.Element(S("numFmts"))
                    self.root.insert(0, nf)
                for n in nf:
                    if n.get("formatCode") == code:
                        nid = int(n.get("numFmtId"))
                if nid is None:
                    nid = max([163] + [int(n.get("numFmtId", 0)) for n in nf]) + 1
                    etree.SubElement(nf, S("numFmt"), numFmtId=str(nid), formatCode=code)
                    nf.set("count", str(len(nf)))
            xf.set("numFmtId", str(nid))
            xf.set("applyNumberFormat", "1")
        if fmt.get("h_align"):
            al = xf.find(S("alignment"))
            if al is None:
                al = etree.Element(S("alignment"))
                xf.insert(0, al)
            al.set("horizontal", str(fmt["h_align"]))
            xf.set("applyAlignment", "1")
        sig = etree.tostring(xf)
        for i, existing in enumerate(xfs):
            if etree.tostring(existing) == sig:
                cache[key] = i
                return i
        xfs.append(xf)
        xfs.set("count", str(len(xfs)))
        self.pkg.touch("xl/styles.xml")
        cache[key] = len(xfs) - 1
        return len(xfs) - 1


def _xl_get_cell(root: etree._Element, ref: str, create: bool) -> Optional[etree._Element]:
    ref, col, row = parse_ref(ref)
    sd = root.find(S("sheetData"))
    if sd is None:
        if not create:
            return None
        sd = etree.SubElement(root, S("sheetData"))
    row_el = None
    for r in sd.findall(S("row")):
        rn = int(r.get("r", 0))
        if rn == row:
            row_el = r
            break
        if rn > row:
            if not create:
                return None
            row_el = etree.Element(S("row"), r=str(row))
            sd.insert(sd.index(r), row_el)
            break
    if row_el is None:
        if not create:
            return None
        row_el = etree.SubElement(sd, S("row"), r=str(row))
    for c in row_el.findall(S("c")):
        cref = c.get("r")
        if cref and cref.upper() == ref:
            return c
        if cref and col_to_idx(_REF_RE.match(cref).group(1)) > col:
            if not create:
                return None
            new = etree.Element(S("c"), r=ref)
            row_el.insert(row_el.index(c), new)
            _xl_inherit_style(root, row_el, new, col)
            return new
    if not create:
        return None
    new = etree.SubElement(row_el, S("c"), r=ref)
    _xl_inherit_style(root, row_el, new, col)
    return new


def _xl_inherit_style(root, row_el, cell, col):
    if row_el.get("customFormat") in ("1", "true") and row_el.get("s"):
        cell.set("s", row_el.get("s"))
        return
    cols = root.find(S("cols"))
    if cols is not None:
        for c in cols:
            if int(c.get("min", 0)) <= col <= int(c.get("max", 0)) and c.get("style"):
                cell.set("s", c.get("style"))
                return


def _xl_update_dimension(root, ref):
    dim = root.find(S("dimension"))
    if dim is None:
        return
    _, col, row = parse_ref(ref)
    cur = dim.get("ref", "A1")
    a, b = (cur.split(":") + [cur])[:2]
    try:
        _, c1, r1 = parse_ref(a)
        _, c2, r2 = parse_ref(b)
    except EditError:
        return
    c1, r1, c2, r2 = min(c1, col), min(r1, row), max(c2, col), max(r2, row)
    new = f"{idx_to_col(c1)}{r1}:{idx_to_col(c2)}{r2}"
    if new != cur:
        dim.set("ref", new)


def _xl_mark_recalc(pkg: OfficePackage) -> None:
    wb = pkg.xml("xl/workbook.xml")
    calc = wb.find(S("calcPr"))
    if calc is None:
        after = [S(t) for t in "oleSize customWorkbookViews pivotCaches smartTagPr smartTagTypes webPublishing fileRecoveryPr webPublishObjects extLst".split()]
        calc = etree.Element(S("calcPr"))
        for i, ch in enumerate(wb):
            if ch.tag in after:
                wb.insert(i, calc)
                break
        else:
            wb.append(calc)
    if calc.get("fullCalcOnLoad") != "1":
        calc.set("fullCalcOnLoad", "1")
        pkg.touch("xl/workbook.xml")


def xlsx_apply(pkg: OfficePackage, op: Dict[str, Any], state: Dict[str, Any]) -> Dict[str, Any]:
    kind = op.get("op")
    part = _xl_sheet_part(pkg, op.get("sheet"))
    root = pkg.xml(part)
    sst = _xl_shared_strings(pkg)
    if kind == "set_cell":
        if "value" not in op and "formula" not in op:
            raise EditError("set_cell necesita «value» o «formula»")
        cell = _xl_get_cell(root, op.get("ref", ""), create=True)
        before = _xl_cell_value(cell, sst)
        f_old = cell.find(S("f"))
        if f_old is not None and f_old.get("t") == "shared" and f_old.get("ref"):
            raise EditError(f"{cell.get('r')} es la celda maestra de una fórmula compartida ({f_old.get('ref')}); "
                            "cambiarla rompería las demás. Edita las celdas dependientes por separado")
        if f_old is not None and f_old.get("t") == "array":
            raise EditError(f"{cell.get('r')} es parte de una fórmula matricial; no se edita celda por celda")
        had_formula = f_old is not None
        for ch in list(cell):
            if ch.tag in (S("f"), S("v"), S("is")):
                cell.remove(ch)
        cell.attrib.pop("t", None)
        if "formula" in op and op["formula"] is not None:
            f = etree.SubElement(cell, S("f"))
            f.text = str(op["formula"]).lstrip("=")
            state["formulas_touched"] = True
        else:
            val = op["value"]
            if isinstance(val, bool):
                cell.set("t", "b")
                etree.SubElement(cell, S("v")).text = "1" if val else "0"
            elif isinstance(val, (int, float)):
                etree.SubElement(cell, S("v")).text = repr(val) if isinstance(val, float) else str(val)
            elif val is None or val == "":
                pass
            else:
                text = str(val)
                if pkg.has("xl/sharedStrings.xml"):
                    sroot = pkg.xml("xl/sharedStrings.xml")
                    idx = None
                    for i, si in enumerate(sroot.findall(S("si"))):
                        t = si.find(S("t"))
                        if t is not None and len(si) == 1 and (t.text or "") == text:
                            idx = i
                            break
                    if idx is None:
                        si = etree.SubElement(sroot, S("si"))
                        t = etree.SubElement(si, S("t"))
                        t.text = text
                        if text != text.strip():
                            t.set(XML_SPACE, "preserve")
                        idx = len(sroot.findall(S("si"))) - 1
                        sroot.set("uniqueCount", str(idx + 1))
                        pkg.touch("xl/sharedStrings.xml")
                    sroot.set("count", str(int(sroot.get("count", idx)) + 1))
                    pkg.touch("xl/sharedStrings.xml")
                    cell.set("t", "s")
                    etree.SubElement(cell, S("v")).text = str(idx)
                else:
                    cell.set("t", "inlineStr")
                    is_ = etree.SubElement(cell, S("is"))
                    etree.SubElement(is_, S("t")).text = text
            if had_formula:
                state["formulas_touched"] = True
        _xl_update_dimension(root, cell.get("r"))
        _xl_mark_recalc(pkg)
        pkg.touch(part)
        after = _xl_cell_value(cell, _xl_shared_strings(pkg))
        return {"op": kind, "sheet": op.get("sheet"), "ref": cell.get("r"),
                "before": {"value": before[0], "formula": before[1]},
                "after": {"value": after[0], "formula": after[1]}}
    if kind == "set_cell_style":
        rng = op.get("range") or op.get("ref")
        if not rng:
            raise EditError("set_cell_style necesita «ref» o «range»")
        fmt = {k: op[k] for k in ("bold", "italic", "color", "fill", "number_format", "h_align", "font_size") if k in op}
        if not fmt:
            raise EditError("set_cell_style necesita bold, italic, color, fill, number_format, h_align o font_size")
        styles = state.setdefault("styles", XlStyles(pkg))
        cache = state.setdefault("style_cache", {})
        refs = expand_range(rng)
        for ref in refs:
            cell = _xl_get_cell(root, ref, create=True)
            s = int(cell.get("s", 0))
            cell.set("s", str(styles.derive(s, fmt, cache)))
            _xl_update_dimension(root, ref)
        pkg.touch(part)
        return {"op": kind, "sheet": op.get("sheet"), "cells": len(refs), "format": fmt}
    raise EditError(f"operación desconocida para xlsx: «{kind}». Usa set_cell o set_cell_style")


def xlsx_cells(pkg: OfficePackage, part: str) -> Dict[str, Dict[str, Any]]:
    sst = _xl_shared_strings(pkg)
    out = {}
    root = pkg.xml(part)
    for c in root.iter(S("c")):
        v, f, t = _xl_cell_value(c, sst)
        if v is None and f is None and not c.get("s"):
            continue
        out[c.get("r")] = {"value": v, "formula": f, "type": t, "s": int(c.get("s", 0))}
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Gráficas nativas compartidas XLSX / PPTX. Solo partes internas del paquete.
# ─────────────────────────────────────────────────────────────────────────────
_CHART_MAX_POINTS = 200
_CHART_MAX_SERIES = 16
_CHART_MAX_COUNT = 20
_CHART_MAX_TEXT = 512
_CHART_MAX_OUTPUT = 18000
_CHART_MAX_XML = 2 * 1024 * 1024
_CHART_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)


def _chart_xml(pkg, part):
    data = pkg.data.get(part, b"")
    if not data or len(data) > _CHART_MAX_XML or b"<!DOCTYPE" in data.upper():
        raise EditError("parte de gráfica ausente, demasiado grande o con DTD")
    return etree.fromstring(data, _CHART_PARSER)


def _chart_rel(pkg, part, rid, kind):
    """Nunca abre URL, filesystem ni relaciones externas, incluso si parecen locales."""
    relpart = OfficePackage.rels_name(part)
    if not pkg.has(relpart):
        raise EditError("relación interna ausente")
    matches = [r for r in _chart_xml(pkg, relpart) if r.get("Id") == rid]
    if len(matches) != 1:
        raise EditError("relación interna ausente o ambigua")
    rel = matches[0]
    target = rel.get("Target", "")
    if (rel.get("TargetMode", "Internal") != "Internal" or not rel.get("Type", "").endswith("/" + kind)
            or not target or len(target) > 1024 or re.search(r"[\\\x00-\x20:%?#]", target)):
        raise EditError("relación externa o destino no admitido")
    resolved = posixpath.normpath(target.lstrip("/") if target.startswith("/")
                                 else posixpath.join(posixpath.dirname(part), target))
    if resolved in ("", ".", "..") or resolved.startswith("../") or not pkg.has(resolved):
        raise EditError("relación fuera del paquete o parte ausente")
    return resolved


def _chart_text(value):
    value = str(value or "")
    if len(value) > _CHART_MAX_TEXT:
        raise EditError("etiqueta o referencia de gráfica demasiado larga")
    return value


def _chart_sheets(pkg):
    root = _chart_xml(pkg, "xl/workbook.xml")
    out = []
    for sh in root.findall("s:sheets/s:sheet", NS):
        out.append({"name": _chart_text(sh.get("name")),
                    "part": _chart_rel(pkg, "xl/workbook.xml", sh.get(q("r", "id")), "worksheet")})
        if len(out) > 256:
            raise EditError("demasiadas hojas para inspeccionar la gráfica")
    return out


def _chart_embedded_book(pkg, part, root):
    external = root.find("c:externalData", NS)
    if external is None:
        raise EditError("gráfica sin libro de datos interno editable")
    target = _chart_rel(pkg, part, external.get(q("r", "id")), "package")
    payload = pkg.data[target]
    if len(payload) > 8 * 1024 * 1024:
        raise EditError("libro de gráfica demasiado grande")
    with zipfile.ZipFile(io.BytesIO(payload)) as z:
        infos = z.infolist()
        if (len(infos) > 256 or sum(i.file_size for i in infos) > 32 * 1024 * 1024
                or any(i.file_size > 8 * 1024 * 1024 for i in infos)):
            raise EditError("libro de gráfica excede el límite de descompresión")
    book = OfficePackage(io.BytesIO(payload))
    _chart_sheets(book)
    return book


def _chart_range(book, formula):
    """Resuelve únicamente un rango A1 finito en una hoja del mismo libro."""
    formula = _chart_text(formula)
    match = re.fullmatch(r"(?:'((?:[^']|'')+)'|([^'!\[\]]+))!(\$?[A-Za-z]{1,3}\$?[1-9][0-9]*)(?::(\$?[A-Za-z]{1,3}\$?[1-9][0-9]*))?", formula)
    if not match or book is None:
        raise EditError("referencia de datos externa o no resoluble")
    name = (match.group(1).replace("''", "'") if match.group(1) is not None else match.group(2))
    sheets = [s for s in _chart_sheets(book) if s["name"] == name]
    if len(sheets) != 1:
        raise EditError("hoja de datos ausente o ambigua")
    start, c1, r1 = parse_ref(match.group(3))
    end, c2, r2 = parse_ref(match.group(4) or match.group(3))
    if (c1 > 16384 or c2 > 16384 or r1 > 1048576 or r2 > 1048576 or c2 < c1 or r2 < r1
            or (c1 != c2 and r1 != r2) or (c2 - c1 + 1) * (r2 - r1 + 1) > _CHART_MAX_POINTS):
        raise EditError("rango de gráfica no lineal o demasiado grande")
    refs = expand_range(start + ":" + end) if start != end else [start]
    wanted = set(refs)
    sst = []
    if book.has("xl/sharedStrings.xml"):
        for si in _chart_xml(book, "xl/sharedStrings.xml").findall(S("si")):
            sst.append("".join(t.text or "" for t in si.iter(S("t"))))
    values = {}
    for cell in _chart_xml(book, sheets[0]["part"]).iter(S("c")):
        if cell.get("r") not in wanted:
            continue
        value, formula_cell, typ = _xl_cell_value(cell, sst)
        if typ == "n" and value == "":
            value = None
        if typ == "e" or (formula_cell is not None and value is None):
            raise EditError("dato de gráfica con error o fórmula sin recalcular")
        if isinstance(value, float) and not math.isfinite(value):
            raise EditError("dato de gráfica no finito")
        values[cell.get("r")] = _chart_text(value) if isinstance(value, str) else value
    return [values.get(ref) for ref in refs]


def _chart_equal(got, want):
    if isinstance(got, list) and isinstance(want, list):
        return len(got) == len(want) and all(_chart_equal(a, b) for a, b in zip(got, want))
    if type(got) in (int, float) and type(want) in (int, float):
        return math.isfinite(got) and math.isfinite(want) and math.isclose(got, want, rel_tol=1e-9, abs_tol=1e-9)
    return type(got) is type(want) and got == want


def _chart_data(node, book):
    if node is None:
        return {"values": [], "ref": None}
    multi = node.find("c:multiLvlStrRef/c:multiLvlStrCache", NS)
    if node.find("c:multiLvlStrRef", NS) is not None and (multi is None or len(multi.findall("c:lvl", NS)) != 1):
        raise EditError("categorías multinivel no admitidas por esta inspección")
    formula = node.find(".//c:f", NS)
    ref = _chart_text(formula.text) if formula is not None else None
    cache = next((el for el in node if etree.QName(el).localname in ("numLit", "strLit")), None)
    if cache is None:
        cache = node.find(".//c:numCache", NS)
    if cache is None:
        cache = node.find(".//c:strCache", NS)
    if multi is not None:
        # PptxGenJS uses multiLvlStrRef even for a single ordinary label column.
        cache = multi.find("c:lvl", NS)
    values = None
    if cache is not None:
        count_el = (multi if multi is not None else cache).find("c:ptCount", NS)
        points = cache.findall("c:pt", NS)
        count = int(count_el.get("val")) if count_el is not None else max([int(p.get("idx")) + 1 for p in points] or [0])
        if count < 0 or count > _CHART_MAX_POINTS or len(points) > count:
            raise EditError("demasiados puntos de gráfica")
        values = [None] * count
        seen = set()
        numeric = etree.QName(cache).localname in ("numCache", "numLit")
        for p in points:
            idx = int(p.get("idx"))
            if idx < 0 or idx >= count or idx in seen:
                raise EditError("índice de punto inválido o duplicado")
            seen.add(idx)
            raw = p.findtext("c:v", namespaces=NS)
            if numeric and raw is not None and raw.strip():
                value = float(raw)
                if not math.isfinite(value):
                    raise EditError("dato de gráfica no finito")
                values[idx] = value
            elif numeric:
                values[idx] = None
            else:
                values[idx] = _chart_text(raw) if raw is not None else None
    if ref:
        resolved = _chart_range(book, ref)
        if values is not None and not _chart_equal(resolved, values):
            raise EditError("caché y datos de origen de la gráfica no coinciden")
        values = resolved
    if values is None:
        literal = node.find("c:v", NS)
        values = [_chart_text(literal.text)] if literal is not None else []
    return {"values": values, "ref": ref}


def _chart_color(node, line=False):
    if node is None:
        return None
    properties = node.find("c:spPr/a:ln" if line else "c:spPr", NS)
    if properties is not None:
        fills = [el for el in properties if el.tag in {A(x) for x in ("noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill")}]
        if len(fills) > 1:
            raise EditError("relleno de gráfica ambiguo")
        if fills and fills[0].tag == A("solidFill"):
            if len(fills[0]) != 1:
                raise EditError("color de gráfica ambiguo")
            color = fills[0][0]
            if color.tag == A("srgbClr") and not len(color):
                return _norm_hex(color.get("val"))
    # Theme/automatic/gradient colors remain unknown; never guess an RGB match.
    return None


def _chart_read(pkg, part, fmt):
    root = _chart_xml(pkg, part)
    if root.tag != q("c", "chartSpace"):
        raise EditError("parte que no contiene una gráfica nativa")
    chart = root.find("c:chart", NS)
    if chart is None:
        raise EditError("gráfica nativa vacía")
    book = pkg if fmt == "xlsx" else _chart_embedded_book(pkg, part, root)
    # An XLSX chart may also carry an externalData relationship: never certify it.
    if fmt == "xlsx" and root.find("c:externalData", NS) is not None:
        raise EditError("gráfica con fuente externa no verificable")
    plot = chart.find("c:plotArea", NS)
    kinds = {"barChart": "column", "bar3DChart": "column", "lineChart": "line", "line3DChart": "line",
             "areaChart": "area", "area3DChart": "area", "pieChart": "pie", "pie3DChart": "pie",
             "doughnutChart": "doughnut", "scatterChart": "scatter", "bubbleChart": "bubble", "radarChart": "radar"}
    plots = [p for p in (plot if plot is not None else []) if etree.QName(p).localname.endswith("Chart")]
    if not plots or len(plots) > 8:
        raise EditError("tipo de gráfica no admitido")
    series, types, groupings = [], [], []
    for p in plots:
        tag = etree.QName(p).localname
        if tag not in kinds:
            raise EditError("tipo de gráfica no admitido")
        typ = kinds[tag]
        if typ == "column" and p.find("c:barDir", NS) is not None and p.find("c:barDir", NS).get("val") == "bar":
            typ = "bar"
        types.append(typ)
        grouping = p.find("c:grouping", NS)
        groupings.append(grouping.get("val") if grouping is not None else None)
        for s in p.findall("c:ser", NS):
            if len(series) >= _CHART_MAX_SERIES:
                raise EditError("demasiadas series de gráfica")
            names = _chart_data(s.find("c:tx", NS), book)
            cats = _chart_data(s.find("c:cat", NS), book)
            vals = _chart_data(s.find("c:val", NS), book)
            xs = _chart_data(s.find("c:xVal", NS), book)
            ys = _chart_data(s.find("c:yVal", NS), book)
            if typ in ("scatter", "bubble"):
                vals = ys
            if any(value is not None and (type(value) not in (int, float) or not math.isfinite(value)) for value in vals["values"]):
                raise EditError("valores de gráfica no numéricos")
            if typ in ("scatter", "bubble") and any(value is not None and (type(value) not in (int, float) or not math.isfinite(value)) for value in xs["values"]):
                raise EditError("coordenadas de gráfica no numéricas")
            color = _chart_color(s, line=typ in ("line", "scatter", "radar"))
            point_colors = [color] * len(vals["values"])
            seen = set()
            for dp in s.findall("c:dPt", NS):
                idx = dp.find("c:idx", NS)
                n = int(idx.get("val")) if idx is not None else -1
                if n < 0 or n >= len(point_colors) or n in seen:
                    raise EditError("color de punto con índice inválido")
                seen.add(n)
                point_colors[n] = _chart_color(dp)
            if not vals["values"] or (cats["values"] and len(cats["values"]) != len(vals["values"])):
                raise EditError("datos o categorías de gráfica incompletos")
            if typ in ("scatter", "bubble") and len(xs["values"]) != len(vals["values"]):
                raise EditError("coordenadas de gráfica incompletas")
            item = {"index": len(series) + 1, "name": names["values"][0] if names["values"] else None,
                    "name_ref": names["ref"], "type": typ, "categories": cats["values"], "categories_ref": cats["ref"],
                    "values": vals["values"], "values_ref": vals["ref"], "color": color, "point_colors": point_colors}
            if typ in ("scatter", "bubble"):
                item.update({"x_values": xs["values"], "x_values_ref": xs["ref"]})
            if typ == "bubble":
                sizes = _chart_data(s.find("c:bubbleSize", NS), book)
                if len(sizes["values"]) != len(vals["values"]):
                    raise EditError("tamaños de burbujas incompletos")
                item.update({"bubble_sizes": sizes["values"], "bubble_sizes_ref": sizes["ref"]})
            series.append(item)
    if not series:
        raise EditError("gráfica sin series")
    title_node = chart.find("c:title", NS)
    title = "".join(title_node.itertext()) if title_node is not None else ""
    if title_node is not None:
        rich = title_node.findall(".//a:t", NS)
        title = "".join(t.text or "" for t in rich) if rich else "".join(str(v) for v in _chart_data(title_node.find("c:tx", NS), book)["values"])
    legend = chart.find("c:legend", NS)
    legend_pos = legend.find("c:legendPos", NS) if legend is not None else None
    return {"part": part, "type": types[0] if len(plots) == 1 else "combo", "plot_types": types,
            "grouping": groupings[0] if len(plots) == 1 else None, "series": series,
            "categories": series[0]["categories"] if all(s["categories"] == series[0]["categories"] for s in series) else None,
            "title": _chart_text(title), "legend": legend is not None,
            "legend_position": legend_pos.get("val") if legend_pos is not None else None,
            "editable": True, "complete": True}


def _chart_anchor(anchor):
    position = {"anchor": etree.QName(anchor).localname}
    for name in ("from", "to"):
        marker = anchor.find("xdr:" + name, NS)
        if marker is not None:
            position[name] = {etree.QName(x).localname: int(x.text) for x in marker if x.text is not None}
    pos, ext = anchor.find("xdr:pos", NS), anchor.find("xdr:ext", NS)
    if pos is not None:
        position.update({"x_mm": emu_to_mm(int(pos.get("x"))), "y_mm": emu_to_mm(int(pos.get("y")))})
    if ext is not None:
        position.update({"w_mm": emu_to_mm(int(ext.get("cx"))), "h_mm": emu_to_mm(int(ext.get("cy")))})
    return position


def native_charts(pkg, fmt, *, sheet=None, slide=None):
    """Inventario acotado. Una parte insegura/incompleta jamás se certifica editable."""
    try:
        return _native_charts(pkg, fmt, sheet=sheet, slide=slide)
    except (EditError, ValueError, TypeError, KeyError, etree.XMLSyntaxError, zipfile.BadZipFile):
        # Limits of the optional chart inventory must not disable the existing
        # cell/shape inspector. chart_checks rejects every incomplete inventory.
        return {"charts": [], "truncated": True}


def _native_charts(pkg, fmt, *, sheet=None, slide=None):
    out = {"charts": [], "truncated": False}
    budget = _CHART_MAX_OUTPUT

    def add(owner, relation_part, chart_el, location):
        nonlocal budget
        if len(out["charts"]) >= _CHART_MAX_COUNT:
            out["truncated"] = True
            return
        item = {**owner, **location, "id": relation_part + "#" + str(location.get("shape", location["index"]))}
        try:
            part = _chart_rel(pkg, relation_part, chart_el.get(q("r", "id")), "chart")
            item.update(_chart_read(pkg, part, fmt))
        except (EditError, ValueError, TypeError, KeyError, etree.XMLSyntaxError, zipfile.BadZipFile) as exc:
            item.update({"editable": False, "complete": False, "error": str(exc)[:200]})
        size = len(json.dumps(item, ensure_ascii=True))
        if size > budget:
            item = {k: v for k, v in item.items() if k in ("id", "index", "sheet", "slide", "shape", "part", "type")}
            item.update({"editable": False, "complete": False, "error": "inventario de gráfica truncado por límite", "truncated": True})
            out["truncated"] = True
            size = len(json.dumps(item, ensure_ascii=True))
        budget -= size
        out["charts"].append(item)

    if fmt == "xlsx":
        for sh in _chart_sheets(pkg):
            if sheet is not None and str(sheet) != sh["name"]:
                continue
            index = 0
            for drawing in _chart_xml(pkg, sh["part"]).findall("s:drawing", NS):
                try:
                    part = _chart_rel(pkg, sh["part"], drawing.get(q("r", "id")), "drawing")
                    root = _chart_xml(pkg, part)
                    for anchor in root:
                        for chart in anchor.findall(".//c:chart", NS):
                            index += 1
                            nv = anchor.find(".//xdr:cNvPr", NS)
                            add({"sheet": sh["name"]}, part, chart,
                                {"index": index, "shape": nv.get("id") if nv is not None else str(index), "position": _chart_anchor(anchor)})
                except (EditError, ValueError, TypeError, etree.XMLSyntaxError):
                    out["truncated"] = True
    elif fmt == "pptx":
        pres = _chart_xml(pkg, "ppt/presentation.xml")
        for n, sl in enumerate(pres.findall("p:sldIdLst/p:sldId", NS), 1):
            if slide is not None and str(slide) != str(n):
                continue
            part = _chart_rel(pkg, "ppt/presentation.xml", sl.get(q("r", "id")), "slide")
            tree = _chart_xml(pkg, part).find("p:cSld/p:spTree", NS)
            index = 0
            for el, transform, _ in _pp_iter(tree if tree is not None else []):
                if el.tag != P("graphicFrame"):
                    continue
                for chart in el.findall(".//c:chart", NS):
                    index += 1
                    nv = _pp_nv(el)
                    name = nv.find(P("cNvPr")) if nv is not None else None
                    geometry = _xf_geom(_pp_xfrm(el))
                    position = dict(zip(("x_mm", "y_mm", "w_mm", "h_mm"), map(emu_to_mm, _pp_abs(transform, geometry)))) if geometry else {}
                    add({"slide": n}, part, chart, {"index": index, "shape": name.get("id") if name is not None else str(index), "position": position})
    return out


def chart_checks(pkg, fmt, expectations):
    if not isinstance(expectations, list) or not expectations or len(expectations) > _CHART_MAX_COUNT:
        return [{"check": "expect.charts válido (1–20 gráficas)", "ok": False}]
    checks = []
    allowed = {"sheet", "slide", "chart", "type", "grouping", "editable", "categories", "series", "title", "legend", "position"}
    series_allowed = {"name", "values", "x_values", "bubble_sizes", "color", "point_colors"}
    for n, want in enumerate(expectations, 1):
        result = {"check": f"gráfica nativa solicitada {n}", "ok": False}
        try:
            if not isinstance(want, dict) or set(want) - allowed or "chart" not in want:
                raise EditError("expectativa de gráfica inválida: indica ubicación y chart (id o índice 1-based)")
            if fmt not in ("xlsx", "pptx") or (fmt == "xlsx" and (not isinstance(want.get("sheet"), str) or "slide" in want)) or (fmt == "pptx" and (type(want.get("slide")) is not int or want["slide"] < 1 or "sheet" in want)):
                raise EditError("ubicación de gráfica ausente o inválida")
            inv = native_charts(pkg, fmt, sheet=want.get("sheet"), slide=want.get("slide"))
            if inv["truncated"]:
                raise EditError("inventario de gráficas incompleto o truncado")
            selector = want["chart"]
            charts = [c for c in inv["charts"] if (type(selector) is int and c["index"] == selector) or (isinstance(selector, str) and c["id"] == selector)]
            if len(charts) != 1:
                raise EditError("gráfica solicitada ausente o selector ambiguo")
            got = charts[0]
            if not got.get("complete"):
                raise EditError(got.get("error", "datos de gráfica incompletos"))
            failures = []
            for key in ("type", "grouping", "editable", "categories", "title", "legend"):
                if key in want and not _chart_equal(got.get(key), want[key]):
                    failures.append(key)
            if "series" in want:
                if not isinstance(want["series"], list) or not want["series"] or len(want["series"]) != len(got["series"]):
                    failures.append("series (cantidad)")
                else:
                    for i, (actual, expected) in enumerate(zip(got["series"], want["series"]), 1):
                        if not isinstance(expected, dict) or not expected or set(expected) - series_allowed:
                            raise EditError("expectativa de serie inválida")
                        for key, value in expected.items():
                            if key == "color":
                                value = _norm_hex(value)
                                if "point_colors" not in expected and any(color != value for color in actual.get("point_colors", [])):
                                    failures.append(f"serie {i}: colores de puntos distintos del color solicitado")
                            if key == "point_colors":
                                if not isinstance(value, list):
                                    raise EditError("point_colors debe ser una lista")
                                value = [_norm_hex(v) for v in value]
                            if not _chart_equal(actual.get(key), value):
                                failures.append(f"serie {i}: {key}")
            if "position" in want:
                pos = want["position"]
                if not isinstance(pos, dict) or not pos or set(pos) - {"x_mm", "y_mm", "w_mm", "h_mm"}:
                    raise EditError("posición esperada inválida")
                for key, value in pos.items():
                    actual = got.get("position", {}).get(key)
                    if type(value) not in (int, float) or type(actual) not in (int, float) or not math.isfinite(value) or abs(actual - value) > 0.05:
                        failures.append("posición " + key)
            result.update({"ok": not failures, "detail": "no coincide: " + ", ".join(failures) if failures else "tipo, datos y propiedades solicitadas comprobados en OOXML"})
        except (EditError, ValueError, TypeError, KeyError, etree.XMLSyntaxError, zipfile.BadZipFile) as exc:
            result["detail"] = str(exc)[:300]
        checks.append(result)
    return checks


def xlsx_inspect(pkg: OfficePackage, *, query: Optional[str] = None, limit: int = 300, sheet: Any = None) -> Dict[str, Any]:
    styles = XlStyles(pkg)
    out = {"format": "xlsx", "sheets": []}
    q_low = query.lower() if query else None
    budget = limit
    selected_sheet = next((sh["name"] for i, sh in enumerate(xl_sheets(pkg), 1)
                           if sh["name"] == sheet or str(i) == str(sheet)), sheet) if sheet is not None else None
    chart_inventory = native_charts(pkg, "xlsx", sheet=selected_sheet)
    out["charts_truncated"] = chart_inventory["truncated"]
    for i, sh in enumerate(xl_sheets(pkg)):
        if sheet is not None and sh["name"] != sheet and str(i + 1) != str(sheet):
            continue
        root = pkg.xml(sh["part"])
        dim = root.find(S("dimension"))
        cells = xlsx_cells(pkg, sh["part"])
        items = []
        for ref, info in cells.items():
            if q_low and q_low not in str(info["value"]).lower() and q_low not in str(info["formula"] or "").lower():
                continue
            if budget <= 0:
                break
            item = {"ref": ref, "value": info["value"]}
            if info["formula"] is not None:
                item["formula"] = "=" + info["formula"]
            st = styles.describe(info["s"]) if info["s"] else {}
            if st:
                item["style"] = st
            items.append(item)
            budget -= 1
        merged = root.find(S("mergeCells"))
        out["sheets"].append({
            "name": sh["name"], "index": i + 1, "state": sh["state"],
            "dimension": dim.get("ref") if dim is not None else None,
            "cells": items,
            "charts": [c for c in chart_inventory["charts"] if c.get("sheet") == sh["name"]],
            "merged": [m.get("ref") for m in merged][:50] if merged is not None else [],
        })
    if budget <= 0:
        out["truncated"] = True
    return out


# ─────────────────────────────────────────────────────────────────────────────
# POWERPOINT (.pptx)
# ─────────────────────────────────────────────────────────────────────────────
def pp_slide_parts(pkg: OfficePackage) -> List[str]:
    pres = pkg.xml("ppt/presentation.xml")
    rels = pkg.rels("ppt/presentation.xml")
    lst = pres.find(P("sldIdLst"))
    if lst is None:
        return []
    return [rels[s.get(q("r", "id"))][1] for s in lst if s.get(q("r", "id")) in rels]


def pp_slide_size(pkg: OfficePackage) -> Tuple[int, int]:
    sz = pkg.xml("ppt/presentation.xml").find(P("sldSz"))
    return (int(sz.get("cx")), int(sz.get("cy"))) if sz is not None else (12192000, 6858000)


_PP_SHAPES = {P("sp"): "shape", P("pic"): "picture", P("graphicFrame"): "table/chart", P("grpSp"): "group",
              P("cxnSp"): "connector"}


def _pp_nv(el):
    for tag in ("nvSpPr", "nvPicPr", "nvGraphicFramePr", "nvGrpSpPr", "nvCxnSpPr"):
        nv = el.find(P(tag))
        if nv is not None:
            return nv
    return None


def _pp_xfrm(el):
    if el.tag == P("graphicFrame"):
        return el.find(P("xfrm"))
    pr = el.find(P("grpSpPr")) if el.tag == P("grpSp") else el.find(P("spPr"))
    return pr.find(A("xfrm")) if pr is not None else None


def _pp_ph(el):
    nv = _pp_nv(el)
    if nv is None:
        return None
    nvpr = nv.find(P("nvPr"))
    return nvpr.find(P("ph")) if nvpr is not None else None


def _xf_geom(xfrm):
    if xfrm is None:
        return None
    off, ext = xfrm.find(A("off")), xfrm.find(A("ext"))
    if off is None or ext is None:
        return None
    return [int(off.get("x", 0)), int(off.get("y", 0)), int(ext.get("cx", 0)), int(ext.get("cy", 0))]


def _pp_iter(tree, T=(1.0, 1.0, 0.0, 0.0), group=None):
    """Recorre formas con la transformación acumulada de grupos: X = sx*x + tx."""
    for el in tree:
        if el.tag not in _PP_SHAPES:
            continue
        yield el, T, group
        if el.tag == P("grpSp"):
            xf = _pp_xfrm(el)
            g = _xf_geom(xf)
            if g is not None:
                ch_off, ch_ext = xf.find(A("chOff")), xf.find(A("chExt"))
                cx0 = int(ch_off.get("x", 0)) if ch_off is not None else g[0]
                cy0 = int(ch_off.get("y", 0)) if ch_off is not None else g[1]
                ccx = int(ch_ext.get("cx", 0)) if ch_ext is not None else g[2]
                ccy = int(ch_ext.get("cy", 0)) if ch_ext is not None else g[3]
                sx = g[2] / ccx if ccx else 1.0
                sy = g[3] / ccy if ccy else 1.0
                lt = (sx, sy, g[0] - cx0 * sx, g[1] - cy0 * sy)
                sx2, sy2, tx, ty = T
                T2 = (sx2 * lt[0], sy2 * lt[1], sx2 * lt[2] + tx, sy2 * lt[3] + ty)
            else:
                T2 = T
            yield from _pp_iter(el, T2, el)


def _ph_key(ph):
    t = ph.get("type", "obj")
    t = "title" if t in ("title", "ctrTitle") else t
    return t, ph.get("idx")


def _pp_inherited_geom(pkg: OfficePackage, slide_part: str, ph) -> Optional[List[int]]:
    ptype, pidx = _ph_key(ph)
    part = slide_part
    for _ in range(2):  # slide → layout → master
        rels = pkg.rels(part)
        nxt = next((tgt for typ, tgt in rels.values() if typ.endswith("/slideLayout") or typ.endswith("/slideMaster")), None)
        if not nxt or not pkg.has(nxt):
            return None
        tree = pkg.xml(nxt).find(f"{P('cSld')}/{P('spTree')}")
        best = None
        for el, _, _ in _pp_iter(tree):
            lph = _pp_ph(el)
            if lph is None:
                continue
            ltype, lidx = _ph_key(lph)
            if pidx is not None and lidx == pidx:
                best = el
                break
            if best is None and ltype == ptype:
                best = el
            if best is None and ptype in ("obj", "body") and ltype in ("obj", "body"):
                best = el
        if best is not None:
            g = _xf_geom(_pp_xfrm(best))
            if g is not None:
                return g
            ph = _pp_ph(best)
            ptype, pidx = _ph_key(ph)
        part = nxt
    return None


def pptx_segments(ap: etree._Element) -> List[Seg]:
    segs = []
    for ch in ap:
        if ch.tag == A("r"):
            t = ch.find(A("t"))
            if t is not None:
                segs.append(Seg(t, ch, "t", t.text or ""))
        elif ch.tag == A("fld"):
            t = ch.find(A("t"))
            if t is not None:
                segs.append(Seg(t, ch, "fld", t.text or ""))
        elif ch.tag == A("br"):
            segs.append(Seg(ch, ch, "sep", "\n"))
    return segs


def _pp_paras(el) -> List[etree._Element]:
    return list(el.iter(A("p")))


def _pp_text(el) -> str:
    return "\n".join("".join(s.text for s in pptx_segments(p)) for p in _pp_paras(el))


def _pp_find_shape(pkg: OfficePackage, slide_part: str, shape: Any):
    tree = pkg.xml(slide_part).find(f"{P('cSld')}/{P('spTree')}")
    found = []
    for el, T, grp in _pp_iter(tree):
        nv = _pp_nv(el)
        c = nv.find(P("cNvPr")) if nv is not None else None
        if c is None:
            continue
        if str(shape) in (c.get("id"), c.get("name")) or (isinstance(shape, str) and c.get("name", "").lower() == shape.lower()):
            found.append((el, T, grp))
    if not found:
        names = [(_pp_nv(el).find(P("cNvPr")).get("id"), _pp_nv(el).find(P("cNvPr")).get("name"))
                 for el, _, _ in _pp_iter(tree) if _pp_nv(el) is not None]
        raise EditError(f"no encontré la forma «{shape}» en esa lámina. Formas: " +
                        ", ".join(f"{i}:{n}" for i, n in names[:30]))
    if len(found) > 1:
        raise EditError(f"hay {len(found)} formas llamadas «{shape}»; usa su id numérico")
    return found[0]


def _pp_slide_part(pkg: OfficePackage, slide: Any) -> str:
    parts = pp_slide_parts(pkg)
    try:
        n = int(slide)
    except (TypeError, ValueError):
        raise EditError("«slide» debe ser el número de lámina (1 = la primera)")
    if not 1 <= n <= len(parts):
        raise EditError(f"la lámina {n} no existe (hay {len(parts)})")
    return parts[n - 1]


def _pp_abs(T, g):
    sx, sy, tx, ty = T
    return [g[0] * sx + tx, g[1] * sy + ty, g[2] * sx, g[3] * sy]


def pptx_inspect(pkg: OfficePackage, *, query: Optional[str] = None, slide: Any = None, limit: int = 400) -> Dict[str, Any]:
    cx, cy = pp_slide_size(pkg)
    out = {"format": "pptx", "slide_size_mm": {"w": emu_to_mm(cx), "h": emu_to_mm(cy)}, "slides": []}
    q_low = query.lower() if query else None
    budget = limit
    chart_inventory = native_charts(pkg, "pptx", slide=slide)
    out["charts_truncated"] = chart_inventory["truncated"]
    for n, part in enumerate(pp_slide_parts(pkg), start=1):
        if slide is not None and str(slide) != str(n):
            continue
        root = pkg.xml(part)
        rels = pkg.rels(part)
        layout = next((t for typ, t in rels.values() if typ.endswith("/slideLayout")), None)
        layout_name = None
        if layout and pkg.has(layout):
            csld = pkg.xml(layout).find(P("cSld"))
            layout_name = csld.get("name") if csld is not None else None
        shapes = []
        tree = root.find(f"{P('cSld')}/{P('spTree')}")
        for el, T, grp in _pp_iter(tree):
            nv = _pp_nv(el)
            c = nv.find(P("cNvPr")) if nv is not None else None
            text = _pp_text(el) if el.tag != P("grpSp") else ""
            if q_low and q_low not in text.lower() and q_low not in (c.get("name", "").lower() if c is not None else ""):
                continue
            item: Dict[str, Any] = {"id": c.get("id") if c is not None else None,
                                    "name": c.get("name") if c is not None else None,
                                    "kind": _PP_SHAPES[el.tag]}
            ph = _pp_ph(el)
            if ph is not None:
                item["placeholder"] = ph.get("type", "obj") + (f"#{ph.get('idx')}" if ph.get("idx") else "")
            g = _xf_geom(_pp_xfrm(el))
            if g is None and ph is not None:
                g = _pp_inherited_geom(pkg, part, ph)
                if g is not None:
                    item["inherited_position"] = True
            if g is not None:
                ab = _pp_abs(T, g)
                item.update({"x_mm": emu_to_mm(ab[0]), "y_mm": emu_to_mm(ab[1]), "w_mm": emu_to_mm(ab[2]), "h_mm": emu_to_mm(ab[3])})
            if grp is not None:
                gc = _pp_nv(grp).find(P("cNvPr"))
                item["in_group"] = gc.get("name") if gc is not None else True
            if text:
                item["text"] = text if len(text) <= 300 else text[:300] + "…"
                szs = sorted({int(r.get("sz")) / 100 for r in el.iter(A("rPr")) if r.get("sz")})
                if szs:
                    item["font_pt"] = szs
            sppr = el.find(P("spPr"))
            if sppr is not None:
                sf = sppr.find(f"{A('solidFill')}/{A('srgbClr')}")
                if sf is not None:
                    item["fill"] = sf.get("val")
            shapes.append(item)
            budget -= 1
            if budget <= 0:
                break
        if shapes or not q_low:
            out["slides"].append({"n": n, "part": part, "layout": layout_name, "shapes": shapes,
                                  "charts": [c for c in chart_inventory["charts"] if c.get("slide") == n]})
        if budget <= 0:
            out["truncated"] = True
            break
    out["slide_count"] = len(pp_slide_parts(pkg))
    return out


def _a_apply_rpr(rpr: etree._Element, fmt: Dict[str, Any]) -> None:
    if fmt.get("size_pt"):
        rpr.set("sz", str(int(round(float(fmt["size_pt"]) * 100))))
    if "bold" in fmt:
        rpr.set("b", "1" if fmt["bold"] else "0")
    if "italic" in fmt:
        rpr.set("i", "1" if fmt["italic"] else "0")
    if "underline" in fmt:
        rpr.set("u", "sng" if fmt["underline"] else "none")
    if fmt.get("color"):
        remove_children(rpr, {A("noFill"), A("solidFill"), A("gradFill"), A("blipFill"), A("pattFill"), A("grpFill")})
        sf = set_child_ordered(rpr, A("solidFill"), A_RPR_ORDER)
        etree.SubElement(sf, A("srgbClr"), val=_norm_hex(fmt["color"]))
    if fmt.get("font"):
        for tag in ("latin", "ea", "cs"):
            set_child_ordered(rpr, A(tag), A_RPR_ORDER).set("typeface", str(fmt["font"]))


def pptx_apply(pkg: OfficePackage, op: Dict[str, Any]) -> Dict[str, Any]:
    kind = op.get("op")
    if kind == "replace_text":
        find, repl = op.get("find"), op.get("replace", "")
        if find is None:
            raise EditError("replace_text necesita «find»")
        ignore_case = bool(op.get("ignore_case", False))
        parts = pp_slide_parts(pkg)
        slides = [int(op["slide"])] if op.get("slide") is not None else list(range(1, len(parts) + 1))
        cands = []
        for n in slides:
            part = _pp_slide_part(pkg, n)
            if op.get("shape") is not None:
                els = [_pp_find_shape(pkg, part, op["shape"])[0]]
            else:
                tree = pkg.xml(part).find(f"{P('cSld')}/{P('spTree')}")
                els = [el for el, _, _ in _pp_iter(tree) if el.tag != P("grpSp")]
            for el in els:
                for ap in _pp_paras(el):
                    text = "".join(s.text for s in pptx_segments(ap))
                    for pos in _find_all(text, find, ignore_case):
                        cands.append((n, part, el, ap, pos))
        if not cands:
            raise EditError(f"no encontré «{find}» en las láminas indicadas. Usa inspect con query")
        if not op.get("all"):
            if op.get("occurrence") is None and len(cands) > 1:
                raise EditError(f"«{find}» aparece {len(cands)} veces (láminas {sorted({c[0] for c in cands})}); "
                                "indica «slide», «shape», «occurrence» o «all»: true")
            k = int(op.get("occurrence") or 1)
            if not 1 <= k <= len(cands):
                raise EditError(f"occurrence={k} fuera de rango (hay {len(cands)})")
            cands = [cands[k - 1]]
        where = []
        for n, part, el, ap, pos in sorted(cands, key=lambda c: (c[0], id(c[3]), -c[4])):
            replace_range_inplace(pptx_segments(ap), pos, pos + len(find), repl, is_word=False)
            pkg.touch(part)
            c = _pp_nv(el).find(P("cNvPr"))
            where.append({"slide": n, "shape": c.get("name"), "text": "".join(s.text for s in pptx_segments(ap))[:200]})
        return {"op": kind, "matches": len(cands), "where": where}

    part = _pp_slide_part(pkg, op.get("slide"))
    el, T, grp = _pp_find_shape(pkg, part, op.get("shape"))
    cnv = _pp_nv(el).find(P("cNvPr"))
    label = {"slide": int(op["slide"]), "shape": cnv.get("name"), "id": cnv.get("id")}

    if kind == "set_shape_text":
        paras = _pp_paras(el)
        if not paras:
            raise EditError("esa forma no tiene cuadro de texto")
        before = _pp_text(el)
        lines = str(op.get("text", "")).split("\n")
        for i, line in enumerate(lines):
            if i < len(paras):
                apply_text_diff(lambda ap=paras[i]: pptx_segments(ap), line, is_word=False)
            else:
                clone = copy.deepcopy(paras[-1])
                segs = pptx_segments(clone)
                replace_range_inplace(segs, 0, len("".join(s.text for s in segs)), line, is_word=False)
                paras[-1].addnext(clone)
                paras.append(clone)
        for extra in paras[len(lines):]:
            extra.getparent().remove(extra)
        pkg.touch(part)
        return {"op": kind, **label, "before": before[:200], "after": _pp_text(el)[:200]}

    if kind == "set_geometry":
        xf = _pp_xfrm(el)
        g = _xf_geom(xf)
        inherited = False
        if g is None:
            ph = _pp_ph(el)
            g = _pp_inherited_geom(pkg, part, ph) if ph is not None else None
            if g is None:
                raise EditError("la forma no tiene posición propia ni heredada")
            inherited = True
            if el.tag == P("graphicFrame"):
                raise EditError("tabla/gráfico sin p:xfrm; no se puede mover")
            sppr = el.find(P("spPr"))
            if sppr is None:
                sppr = etree.Element(P("spPr"))
                _pp_nv(el).addnext(sppr)
            xf = set_child_ordered(sppr, A("xfrm"), A_SPPR_ORDER)
            etree.SubElement(xf, A("off"), x=str(g[0]), y=str(g[1]))
            etree.SubElement(xf, A("ext"), cx=str(g[2]), cy=str(g[3]))
        sx, sy, tx, ty = T
        ab = _pp_abs(T, g)
        before = {"x_mm": emu_to_mm(ab[0]), "y_mm": emu_to_mm(ab[1]), "w_mm": emu_to_mm(ab[2]), "h_mm": emu_to_mm(ab[3])}
        new = list(ab)
        if "x_mm" in op:
            new[0] = mm_to_emu(op["x_mm"])
        if "y_mm" in op:
            new[1] = mm_to_emu(op["y_mm"])
        if "w_mm" in op:
            new[2] = mm_to_emu(op["w_mm"])
        if "h_mm" in op:
            new[3] = mm_to_emu(op["h_mm"])
        if "dx_mm" in op:
            new[0] += mm_to_emu(op["dx_mm"])
        if "dy_mm" in op:
            new[1] += mm_to_emu(op["dy_mm"])
        if new[2] <= 0 or new[3] <= 0:
            raise EditError("ancho y alto deben ser mayores que 0 mm")
        local = [int(round((new[0] - tx) / sx)), int(round((new[1] - ty) / sy)), int(round(new[2] / sx)), int(round(new[3] / sy))]
        off, ext = xf.find(A("off")), xf.find(A("ext"))
        off.set("x", str(local[0]))
        off.set("y", str(local[1]))
        ext.set("cx", str(local[2]))
        ext.set("cy", str(local[3]))
        pkg.touch(part)
        after = {"x_mm": emu_to_mm(new[0]), "y_mm": emu_to_mm(new[1]), "w_mm": emu_to_mm(new[2]), "h_mm": emu_to_mm(new[3])}
        return {"op": kind, **label, "before": before, "after": after, "inherited_position_made_explicit": inherited}

    if kind == "set_fill":
        sppr = el.find(P("spPr"))
        if sppr is None:
            raise EditError("esta forma no admite relleno")
        remove_children(sppr, {A("noFill"), A("solidFill"), A("gradFill"), A("blipFill"), A("pattFill"), A("grpFill")})
        if op.get("color") in (None, "", "none"):
            set_child_ordered(sppr, A("noFill"), A_SPPR_ORDER)
        else:
            sf = set_child_ordered(sppr, A("solidFill"), A_SPPR_ORDER)
            etree.SubElement(sf, A("srgbClr"), val=_norm_hex(op["color"]))
        pkg.touch(part)
        return {"op": kind, **label, "fill": op.get("color") or "none"}

    if kind == "set_text_format":
        fmt = {k: op[k] for k in ("size_pt", "bold", "italic", "underline", "color", "font") if k in op}
        if not fmt:
            raise EditError("set_text_format necesita size_pt, bold, italic, underline, color o font")
        touched = 0
        for ap in _pp_paras(el):
            text = "".join(s.text for s in pptx_segments(ap))
            if op.get("find") and op["find"] not in text:
                continue
            for r in [x for x in ap if x.tag in (A("r"), A("fld"))]:
                t = r.find(A("t"))
                if op.get("find") and (t is None or op["find"] not in (t.text or "")) and not op.get("whole_paragraph"):
                    continue
                rpr = r.find(A("rPr"))
                if rpr is None:
                    rpr = etree.Element(A("rPr"), lang="es-PE")
                    r.insert(0, rpr)
                _a_apply_rpr(rpr, fmt)
                touched += 1
        if not touched:
            raise EditError("no había texto que formatear" + (f" con «{op['find']}»" if op.get("find") else ""))
        pkg.touch(part)
        return {"op": kind, **label, "runs_formatted": touched, "format": fmt}

    raise EditError(f"operación desconocida para pptx: «{kind}». Usa replace_text, set_shape_text, set_geometry, "
                    "set_fill o set_text_format")


# ─────────────────────────────────────────────────────────────────────────────
# Orquestación: inspect / edit
# ─────────────────────────────────────────────────────────────────────────────
def inspect(path: str, **kw) -> Dict[str, Any]:
    fmt = detect_format(path)
    if fmt == "pdf":
        raise EditError("inspect trabaja con docx, xlsx y pptx; para PDF usa render")
    pkg = OfficePackage(path)
    if fmt == "docx":
        return docx_inspect(pkg, query=kw.get("query"), start=int(kw.get("start", 0)), limit=int(kw.get("limit", 200)),
                            detail=bool(kw.get("detail", False)), scope=kw.get("scope", "body"))
    if fmt == "xlsx":
        return xlsx_inspect(pkg, query=kw.get("query"), limit=int(kw.get("limit", 300)), sheet=kw.get("sheet"))
    return pptx_inspect(pkg, query=kw.get("query"), slide=kw.get("slide"), limit=int(kw.get("limit", 400)))


def edit(src: str, dst: str, ops: List[Dict[str, Any]], *, track_changes: bool = False,
         author: str = "SiraGPT", partial: bool = False) -> Dict[str, Any]:
    """Aplica `ops` sobre una copia de `src` y la escribe en `dst`. Atómico por defecto."""
    if not isinstance(ops, list) or not ops:
        raise EditError("«ops» debe ser una lista con al menos una operación")
    fmt = detect_format(src)
    if fmt == "pdf":
        raise EditError("los PDF no se editan en sitio; edita el docx/pptx de origen y vuelve a exportar")
    if os.path.abspath(src) == os.path.abspath(dst):
        raise EditError("dst debe ser un archivo nuevo (p. ej. outputs/<nombre>-editado.docx); nunca se sobrescribe el original")
    pkg = OfficePackage(src)
    date = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    applied, errors, state = [], [], {}
    for i, op in enumerate(ops):
        try:
            if not isinstance(op, dict) or "op" not in op:
                raise EditError("cada operación debe ser un objeto con «op»")
            if fmt == "docx":
                res = docx_apply(pkg, op, track=bool(track_changes or op.get("track")), author=author, date=date)
            elif fmt == "xlsx":
                res = xlsx_apply(pkg, op, state)
            else:
                res = pptx_apply(pkg, op)
            applied.append({"index": i, **res})
        except EditError as exc:
            errors.append({"index": i, "op": op.get("op") if isinstance(op, dict) else None, "error": str(exc)})
            if not partial:
                break
        except Exception as exc:  # error interno: se reporta, nunca se oculta
            errors.append({"index": i, "op": op.get("op") if isinstance(op, dict) else None,
                           "error": f"error interno {type(exc).__name__}: {exc}"})
            if not partial:
                break
    if fmt == "xlsx" and state.get("formulas_touched") and pkg.has("xl/calcChain.xml"):
        pkg.remove_part_everywhere("xl/calcChain.xml")
    if errors and not partial:
        return {"ok": False, "written": False, "applied": applied, "errors": errors,
                "note": "No se escribió ningún archivo (edición atómica). Corrige la operación que falló y reintenta."}
    if not applied:
        return {"ok": False, "written": False, "applied": [], "errors": errors}
    changed = pkg.save(dst)
    # autocomprobación: el ZIP abre y cada parte tocada vuelve a parsear
    check = OfficePackage(dst)
    for name in changed:
        if check.has(name) and name.endswith((".xml", ".rels")):
            etree.fromstring(check.data[name], _PARSER)
    return {"ok": not errors, "written": True, "dst": dst, "applied": applied, "errors": errors,
            "changed_parts": changed, "track_changes": bool(track_changes)}


# ─────────────────────────────────────────────────────────────────────────────
# Render: LibreOffice → PDF → PNG por página
# ─────────────────────────────────────────────────────────────────────────────
_RECALC_XCU = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
</oor:items>
"""


def _lo_profile() -> str:
    """Perfil propio de LibreOffice: evita bloqueos entre procesos y fuerza recálculo de fórmulas al abrir."""
    base = os.environ.get("SIRA_LO_PROFILE") or os.path.join(tempfile.gettempdir(), f"sira-lo-profile-{os.getuid()}")
    user = os.path.join(base, "user")
    xcu = os.path.join(user, "registrymodifications.xcu")
    if not os.path.exists(xcu):
        os.makedirs(user, exist_ok=True)
        with open(xcu, "w", encoding="utf-8") as fh:
            fh.write(_RECALC_XCU)
    return "file://" + base


def soffice_convert(src: str, outdir: str, target: str = "pdf", timeout: int = 180) -> str:
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        raise EditError("LibreOffice (soffice) no está instalado en el sandbox: no se puede renderizar")
    os.makedirs(outdir, exist_ok=True)
    cmd = [exe, f"-env:UserInstallation={_lo_profile()}", "--headless", "--norestore", "--nolockcheck",
           "--nologo", "--nodefault", "--convert-to", target, "--outdir", outdir, src]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise EditError(f"LibreOffice tardó más de {timeout} s convirtiendo «{os.path.basename(src)}»")
    out = os.path.join(outdir, os.path.splitext(os.path.basename(src))[0] + "." + target.split(":")[0])
    if not os.path.exists(out):
        raise EditError(f"LibreOffice no generó {os.path.basename(out)} (código {r.returncode}): {(r.stderr or r.stdout)[-300:]}")
    return out


def pdf_page_count(pdf: str) -> int:
    if shutil.which("pdfinfo"):
        r = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True, timeout=60)
        m = re.search(r"^Pages:\s+(\d+)", r.stdout, re.M)
        if m:
            return int(m.group(1))
    with open(pdf, "rb") as fh:
        return len(re.findall(rb"/Type\s*/Page[^s]", fh.read()))


def pdf_to_pngs(pdf: str, outdir: str, dpi: int = 110, first: Optional[int] = None,
                last: Optional[int] = None) -> Tuple[List[str], str]:
    prefix = os.path.join(outdir, "page")
    if shutil.which("pdftoppm"):
        cmd = ["pdftoppm", "-r", str(int(dpi)), "-png"]
        if first:
            cmd += ["-f", str(first)]
        if last:
            cmd += ["-l", str(last)]
        r = subprocess.run(cmd + [pdf, prefix], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise EditError(f"pdftoppm falló: {r.stderr[-300:]}")
        files = glob.glob(prefix + "-*.png")
        files.sort(key=lambda p: int(re.search(r"-(\d+)\.png$", p).group(1)))
        return files, "pdftoppm"
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise EditError("no hay pdftoppm (poppler-utils) ni PyMuPDF para rasterizar el PDF")
    doc = fitz.open(pdf)
    files = []
    lo = (first or 1) - 1
    hi = min(last or doc.page_count, doc.page_count)
    width = len(str(doc.page_count))
    for i in range(lo, hi):
        pix = doc[i].get_pixmap(dpi=int(dpi))
        path = f"{prefix}-{str(i + 1).zfill(width)}.png"
        pix.save(path)
        files.append(path)
    return files, "pymupdf"


def _parse_pages(pages: Any) -> Tuple[Optional[int], Optional[int]]:
    if pages in (None, "", "all"):
        return None, None
    if isinstance(pages, int):
        return pages, pages
    if isinstance(pages, (list, tuple)) and pages:
        return int(min(pages)), int(max(pages))
    m = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+))?\s*", str(pages))
    if not m:
        raise EditError("«pages» debe ser un número, «2-5» o una lista [1, 3]")
    a = int(m.group(1))
    return a, int(m.group(2) or a)


def render(path: str, outdir: str, dpi: int = 110, pages: Any = None) -> Dict[str, Any]:
    fmt = detect_format(path)
    dpi = max(50, min(int(dpi or 110), 300))
    os.makedirs(outdir, exist_ok=True)
    for old in glob.glob(os.path.join(outdir, "page-*.png")):  # nunca reportar capturas viejas
        os.remove(old)
    pdf = path if fmt == "pdf" else soffice_convert(path, outdir, "pdf")
    total = pdf_page_count(pdf)
    first, last = _parse_pages(pages)
    if first and first > total:
        raise EditError(f"la página {first} no existe (el documento tiene {total})")
    files, engine = pdf_to_pngs(pdf, outdir, dpi, first, min(last, total) if last else None)
    from PIL import Image
    out_pages = []
    for f in files:
        n = int(re.search(r"-(\d+)\.png$", f).group(1))
        with Image.open(f) as im:
            w, h = im.size
            gray = im.convert("L")
            hist = gray.histogram()
            mean = sum(i * c for i, c in enumerate(hist)) / max(1, w * h)
        out_pages.append({"page": n, "png": f, "width_px": w, "height_px": h,
                          "width_mm": round(w / dpi * 25.4, 1), "height_mm": round(h / dpi * 25.4, 1),
                          "mean_brightness": round(mean, 1), "blank": mean > 254.5})
    return {"ok": True, "format": fmt, "pdf": pdf, "page_count": total, "dpi": dpi, "engine": engine, "pages": out_pages}


def pdf_text(pdf: str, page: Optional[int] = None) -> str:
    if not shutil.which("pdftotext"):
        raise EditError("pdftotext (poppler-utils) no está instalado")
    cmd = ["pdftotext", "-layout"]
    if page:
        cmd += ["-f", str(page), "-l", str(page)]
    r = subprocess.run(cmd + [pdf, "-"], capture_output=True, text=True, timeout=120)
    return r.stdout


def _font(size: int):
    from PIL import ImageFont
    for name in ("DejaVuSans.ttf", "LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def contact_sheet(pngs: List[str], out_png: str, cols: int = 4, thumb_w: int = 300) -> str:
    """Hoja de contacto con todas las páginas pedidas (máx. 16) para que el modelo vea el conjunto."""
    from PIL import Image, ImageDraw
    pngs = pngs[:16]
    thumbs = []
    for f in pngs:
        im = Image.open(f).convert("RGB")
        s = thumb_w / im.width
        thumbs.append(im.resize((thumb_w, int(im.height * s))))
    if not thumbs:
        raise EditError("no hay páginas para la hoja de contacto")
    cols = max(1, min(cols, len(thumbs)))
    rows = math.ceil(len(thumbs) / cols)
    th = max(t.height for t in thumbs)
    pad, label = 12, 22
    sheet = Image.new("RGB", (cols * (thumb_w + pad) + pad, rows * (th + label + pad) + pad), (236, 236, 232))
    d = ImageDraw.Draw(sheet)
    f = _font(14)
    for k, (t, src) in enumerate(zip(thumbs, pngs)):
        r, c = divmod(k, cols)
        x, y = pad + c * (thumb_w + pad), pad + r * (th + label + pad)
        n = int(re.search(r"-(\d+)\.png$", src).group(1))
        d.text((x, y), f"Página {n}", fill=(90, 90, 86), font=f)
        sheet.paste(t, (x, y + label))
        d.rectangle([x - 1, y + label - 1, x + t.width, y + label + t.height], outline=(200, 200, 194))
    sheet.save(out_png, optimize=True)
    return out_png


# ─────────────────────────────────────────────────────────────────────────────
# Diff visual: zonas cambiadas en mm + compuesto antes/después con zoom
# ─────────────────────────────────────────────────────────────────────────────
def page_diff(before_png: str, after_png: str, dpi: int, threshold: int = 32, classify: bool = True) -> Dict[str, Any]:
    from PIL import Image, ImageChops, ImageFilter
    a = Image.open(before_png).convert("RGB")
    b = Image.open(after_png).convert("RGB")
    size_changed = a.size != b.size
    if size_changed:
        b = b.resize(a.size)
    # diferencia por canal (no en gris): un azul→verde de igual luminosidad también cuenta
    r_, g_, b_ = ImageChops.difference(a, b).split()
    mask = ImageChops.lighter(ImageChops.lighter(r_, g_), b_).point(lambda v: 255 if v > threshold else 0)
    if not mask.getbbox():
        return {"changed": False, "size_changed": size_changed, "boxes_px": [], "boxes_mm": [], "changed_ratio": 0.0}
    W_, H_ = mask.size
    changed_px = mask.histogram()[255]
    cell = max(4, int(round(dpi / 25.4 * 1.5)))          # celdas de ~1,5 mm
    gw, gh = math.ceil(W_ / cell), math.ceil(H_ / cell)
    grid = mask.resize((gw, gh), Image.BOX).point(lambda v: 255 if v > 0 else 0)
    merged = grid.filter(ImageFilter.MaxFilter(5))       # une letras/palabras vecinas (~3 mm)
    gpx, mpx = grid.load(), merged.load()
    seen = bytearray(gw * gh)
    boxes = []
    for y0 in range(gh):
        for x0 in range(gw):
            if not mpx[x0, y0] or seen[y0 * gw + x0]:
                continue
            stack = [(x0, y0)]
            seen[y0 * gw + x0] = 1
            tx0, ty0, tx1, ty1 = gw, gh, -1, -1
            while stack:
                x, y = stack.pop()
                if gpx[x, y]:
                    tx0, ty0, tx1, ty1 = min(tx0, x), min(ty0, y), max(tx1, x), max(ty1, y)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < gw and 0 <= ny < gh and mpx[nx, ny] and not seen[ny * gw + nx]:
                        seen[ny * gw + nx] = 1
                        stack.append((nx, ny))
            if tx1 >= 0:
                # caja exacta en píxeles: bbox real de la máscara dentro de la región de la zona
                rx0, ry0 = tx0 * cell, ty0 * cell
                rx1, ry1 = min(W_, (tx1 + 1) * cell), min(H_, (ty1 + 1) * cell)
                tight = mask.crop((rx0, ry0, rx1, ry1)).getbbox()
                if tight:
                    boxes.append([rx0 + tight[0], ry0 + tight[1], rx0 + tight[2], ry0 + tight[3]])
    boxes.sort(key=lambda bx: -(bx[2] - bx[0]) * (bx[3] - bx[1]))
    # Separar cambios de CONTENIDO de micro-desplazamientos (kerning/shaping sub-píxel al partir un run):
    # tras un desenfoque gaussiano de 1,5 px, un desplazamiento sub-píxel deja diferencias < umbral,
    # mientras que un glifo, color o forma distinta sigue muy por encima (medido: ≤16 vs ≥75).
    content, micro = ([], []) if classify else (list(boxes), [])
    pad = 4
    for bx in (boxes if classify else []):
        region = (max(0, bx[0] - pad), max(0, bx[1] - pad), min(W_, bx[2] + pad), min(H_, bx[3] + pad))
        ba = a.crop(region).filter(ImageFilter.GaussianBlur(1.5))
        bb = b.crop(region).filter(ImageFilter.GaussianBlur(1.5))
        r2, g2, b2 = ImageChops.difference(ba, bb).split()
        m2 = ImageChops.lighter(ImageChops.lighter(r2, g2), b2).point(lambda v: 255 if v > threshold else 0)
        (content if m2.histogram()[255] >= 3 else micro).append(bx)
    to_mm = lambda v: round(v / dpi * 25.4, 1)
    as_mm = lambda bx: {"x": to_mm(bx[0]), "y": to_mm(bx[1]), "w": to_mm(bx[2] - bx[0]), "h": to_mm(bx[3] - bx[1])}
    return {
        "changed": bool(content), "size_changed": size_changed,
        "changed_ratio": round(changed_px / float(W_ * H_), 5),
        "boxes_px": content[:20],
        "boxes_mm": [as_mm(bx) for bx in content[:20]],
        "zones": len(content),
        "micro_px": micro[:20],
        "micro_mm": [as_mm(bx) for bx in micro[:20]],
        "micro_zones": len(micro),
    }


def make_composite(before_png: str, after_png: str, boxes_px: List[List[int]], out_png: str, *, dpi: int,
                   title: str = "", panel_w: int = 700, zooms: int = 3, micro_px: Optional[List[List[int]]] = None) -> str:
    """ANTES | DESPUÉS con recuadros rojos, y debajo el zoom de las zonas más grandes."""
    from PIL import Image, ImageDraw
    A_ = Image.open(before_png).convert("RGB")
    B_ = Image.open(after_png).convert("RGB")
    if B_.size != A_.size:
        B_ = B_.resize(A_.size)
    s = min(1.0, panel_w / A_.width)
    pw, ph = int(A_.width * s), int(A_.height * s)
    red, ink, quiet, bg = (214, 40, 40), (40, 40, 38), (120, 120, 114), (245, 245, 241)
    gut, head = 16, 44
    zoom_rows = []
    px_mm = dpi / 25.4
    for k, bx in enumerate(boxes_px[:zooms]):
        # contexto: al menos 70 mm de ancho y 14 mm de alto alrededor de la zona, para leer la línea entera
        cx, cy = (bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2
        half_w = max((bx[2] - bx[0]) / 2 + 4 * px_mm, 35 * px_mm)
        half_h = max((bx[3] - bx[1]) / 2 + 3 * px_mm, 7 * px_mm)
        x0, y0 = int(max(0, cx - half_w)), int(max(0, cy - half_h))
        x1, y1 = int(min(A_.width, cx + half_w)), int(min(A_.height, cy + half_h))
        ca, cb = A_.crop((x0, y0, x1, y1)), B_.crop((x0, y0, x1, y1))
        zs = min(4.0, panel_w / max(1, ca.width), 320 / max(1, ca.height))
        zs = max(zs, 0.25)
        size = (max(1, int(ca.width * zs)), max(1, int(ca.height * zs)))
        ca, cb = ca.resize(size, Image.LANCZOS), cb.resize(size, Image.LANCZOS)
        for im in (ca, cb):
            d = ImageDraw.Draw(im)
            d.rectangle([int((bx[0] - x0) * zs), int((bx[1] - y0) * zs), int((bx[2] - x0) * zs) - 1,
                         int((bx[3] - y0) * zs) - 1], outline=red, width=2)
        mm = lambda v: v / dpi * 25.4
        label = f"Zona {k + 1} · x {mm(bx[0]):.0f}–{mm(bx[2]):.0f} mm · y {mm(bx[1]):.0f}–{mm(bx[3]):.0f} mm"
        zoom_rows.append((label, ca, cb))
    zh = sum(28 + r[1].height + gut for r in zoom_rows)
    W_ = pw * 2 + gut * 3
    H_ = head + ph + gut + zh + gut
    canvas = Image.new("RGB", (W_, H_), bg)
    d = ImageDraw.Draw(canvas)
    f_big, f_small = _font(18), _font(14)
    d.text((gut, 12), "ANTES", fill=ink, font=f_big)
    d.text((gut * 2 + pw, 12), "DESPUÉS", fill=ink, font=f_big)
    if title:
        tw = d.textlength(title, font=f_small) if hasattr(d, "textlength") else 0
        d.text((W_ - gut - tw, 16), title, fill=quiet, font=f_small)
    a_s, b_s = A_.resize((pw, ph), Image.LANCZOS), B_.resize((pw, ph), Image.LANCZOS)
    for im in (a_s, b_s):
        dd = ImageDraw.Draw(im)
        for bx in (micro_px or [])[:20]:  # micro-desplazamientos: recuadro ámbar fino, sin número
            dd.rectangle([int(bx[0] * s) - 1, int(bx[1] * s) - 1, int(bx[2] * s) + 1, int(bx[3] * s) + 1],
                         outline=(214, 150, 40), width=1)
        for k, bx in enumerate(boxes_px[:12]):
            r = [int(bx[0] * s) - 2, int(bx[1] * s) - 2, int(bx[2] * s) + 2, int(bx[3] * s) + 2]
            dd.rectangle(r, outline=red, width=2)
            if k < zooms:
                dd.text((r[0], max(0, r[1] - 16)), str(k + 1), fill=red, font=f_small)
    canvas.paste(a_s, (gut, head))
    canvas.paste(b_s, (gut * 2 + pw, head))
    y = head + ph + gut
    for label, ca, cb in zoom_rows:
        d.text((gut, y + 4), label, fill=quiet, font=f_small)
        y += 28
        canvas.paste(ca, (gut, y))
        canvas.paste(cb, (gut * 2 + pw, y))
        y += ca.height + gut
    canvas.save(out_png, optimize=True)
    return out_png


# ─────────────────────────────────────────────────────────────────────────────
# Diff semántico (qué cambió, dicho con direcciones que el modelo entiende)
# ─────────────────────────────────────────────────────────────────────────────
def part_diff(before: str, after: str) -> Dict[str, Any]:
    A_, B_ = OfficePackage(before), OfficePackage(after)
    na, nb = set(A_.names), set(B_.names)
    changed = sorted(n for n in na & nb if A_.data[n] != B_.data[n])
    return {"changed": changed, "added": sorted(nb - na), "removed": sorted(na - nb),
            "identical": len((na & nb)) - len(changed)}


def _w_sig(p) -> str:
    ppr = p.find(W("pPr"))
    parts = [etree.tostring(ppr).decode() if ppr is not None else ""]
    for r in _w_runs(p):
        rpr = r.find(W("rPr"))
        parts.append((etree.tostring(rpr).decode() if rpr is not None else "") + "|" +
                     "".join(c.text or "" for c in r if c.tag == W("t")))
    return "\n".join(parts)


def docx_changes(A_: OfficePackage, B_: OfficePackage, limit: int = 40) -> List[Dict[str, Any]]:
    pa, pb = docx_paragraphs(A_), docx_paragraphs(B_)
    ta, tb = [docx_para_text(p) for p in pa], [docx_para_text(p) for p in pb]
    out = []
    sm = difflib.SequenceMatcher(a=ta, b=tb, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for i, j in zip(range(i1, i2), range(j1, j2)):
                if _w_sig(pa[i]) != _w_sig(pb[j]):
                    out.append({"type": "formato", "paragraph": j, "text": tb[j][:120]})
        elif tag == "replace":
            for k in range(max(i2 - i1, j2 - j1)):
                i, j = i1 + k, j1 + k
                out.append({"type": "texto", "paragraph": j if j < j2 else None,
                            "before": ta[i][:200] if i < i2 else None, "after": tb[j][:200] if j < j2 else None})
        elif tag == "insert":
            out.extend({"type": "párrafo nuevo", "paragraph": j, "after": tb[j][:200]} for j in range(j1, j2))
        elif tag == "delete":
            out.extend({"type": "párrafo borrado", "paragraph_before": i, "before": ta[i][:200]} for i in range(i1, i2))
        if len(out) >= limit:
            break
    return out[:limit]


def xlsx_changes(A_: OfficePackage, B_: OfficePackage, limit: int = 60) -> List[Dict[str, Any]]:
    out = []
    sa = {s["name"]: s["part"] for s in xl_sheets(A_)}
    sb = {s["name"]: s["part"] for s in xl_sheets(B_)}
    for name in sorted(set(sa) | set(sb)):
        if name not in sa or name not in sb:
            out.append({"type": "hoja " + ("nueva" if name in sb else "borrada"), "sheet": name})
            continue
        ca, cb = xlsx_cells(A_, sa[name]), xlsx_cells(B_, sb[name])
        for ref in sorted(set(ca) | set(cb), key=lambda r: (int(_REF_RE.match(r).group(2)), col_to_idx(_REF_RE.match(r).group(1)))):
            x, y = ca.get(ref, {}), cb.get(ref, {})
            if (x.get("value"), x.get("formula")) != (y.get("value"), y.get("formula")):
                out.append({"type": "valor", "cell": f"{name}!{ref}", "before": x.get("value"), "after": y.get("value"),
                            "formula_before": x.get("formula"), "formula_after": y.get("formula")})
            elif x.get("s") != y.get("s"):
                out.append({"type": "formato", "cell": f"{name}!{ref}"})
            if len(out) >= limit:
                return out
    return out


def pptx_changes(A_: OfficePackage, B_: OfficePackage, limit: int = 60) -> List[Dict[str, Any]]:
    out = []
    pa, pb = pp_slide_parts(A_), pp_slide_parts(B_)
    if len(pa) != len(pb):
        out.append({"type": "número de láminas", "before": len(pa), "after": len(pb)})
    for n in range(1, min(len(pa), len(pb)) + 1):
        def shapes(pkg, part):
            res = {}
            tree = pkg.xml(part).find(f"{P('cSld')}/{P('spTree')}")
            for el, T, _ in _pp_iter(tree):
                c = _pp_nv(el).find(P("cNvPr"))
                g = _xf_geom(_pp_xfrm(el))
                fill = el.find(f"{P('spPr')}/{A('solidFill')}/{A('srgbClr')}")
                res[c.get("id")] = {"name": c.get("name"), "text": _pp_text(el),
                                    "geom": [emu_to_mm(v) for v in _pp_abs(T, g)] if g else None,
                                    "fill": fill.get("val") if fill is not None else None,
                                    "rpr": "".join(etree.tostring(r).decode() for r in el.iter(A("rPr")))}
            return res
        sa, sb = shapes(A_, pa[n - 1]), shapes(B_, pb[n - 1])
        for sid in sorted(set(sa) | set(sb), key=lambda v: int(v) if str(v).isdigit() else 0):
            x, y = sa.get(sid), sb.get(sid)
            if x is None or y is None:
                out.append({"type": "forma " + ("nueva" if y else "borrada"), "slide": n, "shape": (y or x)["name"]})
                continue
            if x["text"] != y["text"]:
                out.append({"type": "texto", "slide": n, "shape": y["name"], "before": x["text"][:160], "after": y["text"][:160]})
            if x["geom"] != y["geom"]:
                out.append({"type": "posición/tamaño (mm)", "slide": n, "shape": y["name"], "before": x["geom"], "after": y["geom"]})
            if x["fill"] != y["fill"]:
                out.append({"type": "relleno", "slide": n, "shape": y["name"], "before": x["fill"], "after": y["fill"]})
            if x["text"] == y["text"] and x["rpr"] != y["rpr"]:
                out.append({"type": "formato de texto", "slide": n, "shape": y["name"]})
            if len(out) >= limit:
                return out
    return out


def semantic_changes(before: str, after: str) -> List[Dict[str, Any]]:
    fmt = detect_format(after)
    A_, B_ = OfficePackage(before), OfficePackage(after)
    if fmt == "docx":
        return docx_changes(A_, B_)
    if fmt == "xlsx":
        return xlsx_changes(A_, B_)
    if fmt == "pptx":
        return pptx_changes(A_, B_)
    return []


def recalc_values(path: str, cells: List[str]) -> Dict[str, Any]:
    """Recalcula una COPIA con LibreOffice y devuelve los valores de `cells` ("Hoja1!C5" o "C5")."""
    tmp = tempfile.mkdtemp(prefix="sira-recalc-")
    try:
        src = os.path.join(tmp, "in_" + os.path.basename(path))
        shutil.copy(path, src)
        out = soffice_convert(src, os.path.join(tmp, "out"), "xlsx")
        pkg = OfficePackage(out)
        sheets = xl_sheets(pkg)
        res = {}
        for spec in cells:
            sheet, ref = (spec.split("!", 1) if "!" in spec else (sheets[0]["name"], spec))
            sheet = sheet.strip("'")
            part = next((s["part"] for s in sheets if s["name"] == sheet), None)
            if part is None:
                res[spec] = {"error": f"hoja «{sheet}» no existe"}
                continue
            c = _xl_get_cell(pkg.xml(part), ref, create=False)
            res[spec] = _xl_cell_value(c, _xl_shared_strings(pkg))[0] if c is not None else None
        return res
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


# ─────────────────────────────────────────────────────────────────────────────
# verify: todo junto, con un veredicto que el modelo pueda leer
# ─────────────────────────────────────────────────────────────────────────────
def _pdf_pages_text(pdf: str) -> List[str]:
    """Texto de cada página (una sola llamada a pdftotext; las páginas vienen separadas por \f)."""
    if not shutil.which("pdftotext"):
        return []
    r = subprocess.run(["pdftotext", "-layout", pdf, "-"], capture_output=True, text=True, timeout=180)
    pages = r.stdout.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return pages


def _raster(pdf: str, outdir: str, dpi: int, pages: List[int]) -> Dict[int, str]:
    """Rasteriza solo las páginas pedidas → {n: png}."""
    os.makedirs(outdir, exist_ok=True)
    for old in glob.glob(os.path.join(outdir, "page-*.png")):
        os.remove(old)
    out: Dict[int, str] = {}
    if not pages:
        return out
    pages = sorted(set(pages))
    # rangos contiguos → una llamada a pdftoppm por rango
    ranges, a = [], pages[0]
    prev = a
    for n in pages[1:] + [None]:
        if n is not None and n == prev + 1:
            prev = n
            continue
        ranges.append((a, prev))
        if n is not None:
            a = prev = n
    for lo, hi in ranges:
        files, _ = pdf_to_pngs(pdf, outdir, dpi, lo, hi)
        for f in files:
            out[int(re.search(r"-(\d+)\.png$", f).group(1))] = f
    return out


def make_thumb(png: str, out_jpg: str, width: int = 360, quality: int = 72) -> str:
    """Miniatura liviana (JPEG) para el timeline de la interfaz."""
    from PIL import Image
    im = Image.open(png).convert("RGB")
    if im.width > width:
        im = im.resize((width, int(im.height * width / im.width)), Image.LANCZOS)
    im.save(out_jpg, "JPEG", quality=quality, optimize=True)
    return out_jpg


def verify(before: Optional[str], after: str, outdir: str, dpi: int = 110, expect: Optional[Dict[str, Any]] = None,
           max_composites: int = 3, scan_threshold_pages: int = 12, max_detail_pages: int = 8) -> Dict[str, Any]:
    """
    Verifica `after` contra `before` (o solo `after` si es un documento nuevo).
    Documentos largos: primero un barrido rápido a 36 ppp de TODAS las páginas y comparación
    de texto por página; luego solo las páginas candidatas se rasterizan a `dpi` para el diff fino.
    """
    expect = expect or {}
    fmt = detect_format(after)
    dpi = max(50, min(int(dpi or 110), 300))
    os.makedirs(outdir, exist_ok=True)
    for old in glob.glob(os.path.join(outdir, "compare-p*")) + glob.glob(os.path.join(outdir, "contact*")):
        os.remove(old)
    report: Dict[str, Any] = {"before": before, "after": after, "format": fmt}
    if before and fmt != "pdf":
        report["parts"] = part_diff(before, after)
        report["changes"] = semantic_changes(before, after)
    after_dir = os.path.join(outdir, "after")
    after_pdf = after if fmt == "pdf" else soffice_convert(after, after_dir, "pdf")
    na = pdf_page_count(after_pdf)
    text_after = _pdf_pages_text(after_pdf)
    pages: List[Dict[str, Any]] = []
    composites: List[str] = []
    thumbs: List[str] = []
    if before:
        before_dir = os.path.join(outdir, "before")
        before_pdf = before if detect_format(before) == "pdf" else soffice_convert(before, before_dir, "pdf")
        nb = pdf_page_count(before_pdf)
        text_before = _pdf_pages_text(before_pdf)
        common = min(na, nb)
        if max(na, nb) > scan_threshold_pages:
            sb = _raster(before_pdf, os.path.join(before_dir, "scan"), 36, list(range(1, common + 1)))
            sa = _raster(after_pdf, os.path.join(after_dir, "scan"), 36, list(range(1, common + 1)))
            cand = [n for n in range(1, common + 1)
                    if (n <= len(text_before) and n <= len(text_after) and _norm_ws(text_before[n - 1]) != _norm_ws(text_after[n - 1]))
                    or page_diff(sb[n], sa[n], 36, threshold=16, classify=False)["changed"]]
            scanned = True
        else:
            cand = list(range(1, common + 1))
            scanned = False
        detail = cand[:max_detail_pages]
        fb = _raster(before_pdf, before_dir, dpi, detail)
        fa = _raster(after_pdf, after_dir, dpi, detail)
        for n in range(1, max(na, nb) + 1):
            if n > nb:
                pages.append({"page": n, "status": "nueva"})
                continue
            if n > na:
                pages.append({"page": n, "status": "eliminada"})
                continue
            if n not in fb:
                pages.append({"page": n, "status": "cambió" if n in cand else "igual",
                              **({"note": "cambio detectado en el barrido; sin detalle (límite de páginas)"} if n in cand else {})})
                continue
            d = page_diff(fb[n], fa[n], dpi)
            entry = {"page": n, "status": "cambió" if d["changed"] else "igual"}
            if d.get("micro_zones"):
                entry["micro_zones"] = d["micro_zones"]
            if d["changed"]:
                entry.update({"zones": d["zones"], "changed_pct": round(d["changed_ratio"] * 100, 2), "boxes_mm": d["boxes_mm"][:6]})
                if len(composites) < max_composites:
                    out_png = os.path.join(outdir, f"compare-p{n}.png")
                    make_composite(fb[n], fa[n], d["boxes_px"], out_png, dpi=dpi, micro_px=d.get("micro_px"),
                                   title=f"{os.path.basename(after)} · página {n}")
                    composites.append(out_png)
                    thumbs.append(make_thumb(out_png, out_png.replace(".png", ".thumb.jpg")))
                    entry["composite"] = out_png
            pages.append(entry)
        report["visual"] = {"page_count_before": nb, "page_count_after": na, "pagination_changed": nb != na,
                            "pages_changed": [p["page"] for p in pages if p["status"] != "igual"],
                            "pages": pages, "fast_scan": scanned}
    else:
        shown = list(range(1, min(na, 12) + 1))
        fa = _raster(after_pdf, after_dir, dpi, shown)
        sheet = contact_sheet([fa[n] for n in shown], os.path.join(outdir, "contact.png"))
        composites.append(sheet)
        thumbs.append(make_thumb(sheet, os.path.join(outdir, "contact.thumb.jpg")))
        report["visual"] = {"page_count_before": None, "page_count_after": na, "pagination_changed": False,
                            "pages_changed": [], "pages": [{"page": n, "status": "nueva"} for n in range(1, na + 1)],
                            "new_document": True}
    report["composites"] = composites
    report["thumbs"] = thumbs
    # checks: la checklist del modelo convertida en pruebas
    checks = []

    def page_text(page):
        if page:
            return _norm_ws(text_after[page - 1]) if 0 < page <= len(text_after) else ""
        return _norm_ws(" ".join(text_after))

    for item in expect.get("contains", []):
        spec = item if isinstance(item, dict) else {"text": item}
        ok = _norm_ws(spec["text"]) in page_text(spec.get("page"))
        checks.append({"check": f"contiene «{spec['text']}»" + (f" (pág. {spec['page']})" if spec.get("page") else ""), "ok": ok})
    for item in expect.get("not_contains", []):
        spec = item if isinstance(item, dict) else {"text": item}
        ok = _norm_ws(spec["text"]) not in page_text(spec.get("page"))
        checks.append({"check": f"ya no contiene «{spec['text']}»" + (f" (pág. {spec['page']})" if spec.get("page") else ""), "ok": ok})
    changed_pages = report["visual"]["pages_changed"]
    if expect.get("only_pages") and before:
        allowed = {int(x) for x in expect["only_pages"]}
        extra = [n for n in changed_pages if n not in allowed]
        checks.append({"check": f"solo cambian las páginas {sorted(allowed)}", "ok": not extra,
                       "detail": f"también cambiaron: {extra}" if extra else None})
    if before and expect.get("same_page_count", True) and fmt in ("docx", "pptx"):
        vb = report["visual"]
        checks.append({"check": "misma cantidad de páginas", "ok": vb["page_count_before"] == vb["page_count_after"],
                       "detail": f"{vb['page_count_before']} → {vb['page_count_after']}"})
    if expect.get("cells") and fmt == "xlsx":
        vals = recalc_values(after, list(expect["cells"].keys()))
        for spec, want in expect["cells"].items():
            got = vals.get(spec)
            if isinstance(want, (int, float)) and isinstance(got, (int, float)):
                ok = abs(float(got) - float(want)) <= 1e-6 * max(1.0, abs(float(want)))
            else:
                ok = str(got) == str(want)
            checks.append({"check": f"{spec} = {want} (recalculado)", "ok": ok, "detail": f"valor: {got}"})
    if expect.get("allowed_parts") and "parts" in report:
        allowed = set(expect["allowed_parts"])
        bad = [n for n in report["parts"]["changed"] + report["parts"]["added"] + report["parts"]["removed"] if n not in allowed]
        checks.append({"check": "solo cambiaron las partes permitidas", "ok": not bad,
                       "detail": f"otras partes: {bad}" if bad else None})
    if "charts" in expect:
        checks.extend(chart_checks(OfficePackage(after), fmt, expect["charts"]) if fmt in ("xlsx", "pptx")
                      else [{"check": "gráficas nativas requieren XLSX o PPTX", "ok": False}])
    report["checks"] = checks
    report["ok"] = all(c["ok"] for c in checks)
    report["summary"] = summarize(report)
    return report


def _focus(before: str, after: str, ctx: int = 24) -> str:
    """«…contexto [viejo → nuevo] contexto…»: solo la parte que cambió."""
    pre = _common_prefix(before, after)
    suf = _common_suffix(before[pre:], after[pre:])
    old_mid, new_mid = before[pre:len(before) - suf], after[pre:len(after) - suf]
    left = before[max(0, pre - ctx):pre]
    right = before[len(before) - suf:len(before) - suf + ctx]
    clip = lambda s: s if len(s) <= 90 else s[:44] + "…" + s[-44:]
    return (("…" if pre > ctx else "") + left + f"[{clip(old_mid)} → {clip(new_mid)}]" + right +
            ("…" if suf > ctx else "")).replace("\n", " ").strip()


def summarize(report: Dict[str, Any]) -> str:
    L = [f"Verificación: {os.path.basename(report['after'])}" +
         (f" vs {os.path.basename(report['before'])}" if report.get("before") else " (documento nuevo)")]
    parts = report.get("parts")
    if parts:
        ch = parts["changed"] + [f"+{n}" for n in parts["added"]] + [f"-{n}" for n in parts["removed"]]
        L.append(f"• Partes XML cambiadas ({len(ch)}): {', '.join(ch[:8]) or 'ninguna'}; idénticas: {parts['identical']}.")
    changes = report.get("changes") or []
    if changes:
        items = []
        for c in changes[:8]:
            if c["type"] == "texto" and "paragraph" in c:
                items.append(f"párrafo {c['paragraph']}: " + _focus(c.get("before") or "", c.get("after") or ""))
            elif c["type"] == "valor":
                items.append(f"{c['cell']}: {c.get('before')!r} → {c.get('after')!r}" +
                             (f" (fórmula ={c['formula_after']})" if c.get("formula_after") else ""))
            elif "slide" in c:
                items.append(f"lámina {c['slide']} «{c.get('shape')}»: {c['type']}" +
                             (f" {c.get('before')} → {c.get('after')}" if c["type"] != "formato de texto" and c.get("before") is not None else ""))
            elif c["type"] == "formato" and "paragraph" in c:
                items.append(f"formato del párrafo {c['paragraph']} («{(c.get('text') or '')[:40]}»)")
            elif c["type"] == "formato" and "cell" in c:
                items.append(f"formato de {c['cell']}")
            else:
                items.append(f"{c['type']} " + str(c.get("paragraph", c.get("cell", c.get("paragraph_before", "")))))
        more = f" (+{len(changes) - 8} más)" if len(changes) > 8 else ""
        L.append("• Cambios: " + "; ".join(items) + more + ".")
    elif parts is not None:
        L.append("• Cambios: ninguno detectado en el contenido.")
    v = report["visual"]
    pages_txt = []
    for p in v["pages"]:
        if p["status"] == "cambió":
            zones = "; ".join(f"x {b['x']:.0f}–{b['x'] + b['w']:.0f} mm, y {b['y']:.0f}–{b['y'] + b['h']:.0f} mm" for b in p["boxes_mm"][:3])
            micro = f" (+{p['micro_zones']} micro-desplazamiento(s) de kerning, sin cambio visible)" if p.get("micro_zones") else ""
            pages_txt.append(f"pág. {p['page']}: {p['zones']} zona(s), {p['changed_pct']} % [{zones}]{micro}")
        elif p["status"] in ("nueva", "eliminada"):
            pages_txt.append(f"pág. {p['page']}: {p['status']}")
    if v.get("new_document"):
        L.append(f"• Visual: documento nuevo de {v['page_count_after']} página(s); hoja de contacto generada.")
    else:
        total = max(v["page_count_before"], v["page_count_after"])
        L.append(f"• Visual: {len(v['pages_changed'])} de {total} páginas cambiaron" + (": " + " | ".join(pages_txt[:6]) if pages_txt else "") +
                 (" (barrido rápido de todas las páginas + detalle de las que cambiaron)" if v.get("fast_scan") else "") + ".")
        L.append(f"• Paginación: {v['page_count_before']} → {v['page_count_after']}" + (" (CAMBIÓ)" if v["pagination_changed"] else " (igual)") + ".")
    if report.get("checks"):
        L.append("• Checks: " + " · ".join(("✓ " if c["ok"] else "✗ ") + c["check"] + (f" ({c['detail']})" if c.get("detail") and not c["ok"] else "")
                                         for c in report["checks"]))
    L.append("• Resultado: " + ("OK" if report.get("ok") else "REVISAR — hay checks fallidos"))
    if report.get("composites"):
        L.append("• Imagen antes/después: " + ", ".join(report["composites"]))
    return "\n".join(L)


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────
def _dispatch(cmd: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if cmd == "inspect":
        return {"ok": True, **inspect(args["path"], **{k: v for k, v in args.items() if k != "path"})}
    if cmd == "edit":
        return edit(args["src"], args["dst"], args.get("ops", []), track_changes=bool(args.get("track_changes")),
                    author=args.get("author", "SiraGPT"), partial=bool(args.get("partial", False)))
    if cmd == "render":
        res = render(args["path"], args["outdir"], int(args.get("dpi", 110)), args.get("pages"))
        if args.get("contact_sheet", True) and res["pages"]:
            res["contact_sheet"] = contact_sheet([p["png"] for p in res["pages"]], os.path.join(args["outdir"], "contact.png"))
            res["thumb"] = make_thumb(res["contact_sheet"], os.path.join(args["outdir"], "contact.thumb.jpg"))
        return res
    if cmd == "diff":
        rep = verify(args["before"], args["after"], args["outdir"], int(args.get("dpi", 110)), expect={"same_page_count": False})
        rep.pop("checks", None)
        return rep
    if cmd == "verify":
        return verify(args.get("before"), args["after"], args["outdir"], int(args.get("dpi", 110)), args.get("expect"))
    if cmd == "recalc":
        return {"ok": True, "values": recalc_values(args["path"], args.get("cells", []))}
    raise EditError(f"comando desconocido «{cmd}» (inspect, edit, render, diff, verify, recalc)")


def main(argv: List[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = argv[1]
    try:
        if len(argv) >= 4 and argv[2] == "--args-file":
            with open(argv[3], encoding="utf-8") as fh:
                args = json.load(fh)
        elif len(argv) >= 3:
            args = json.loads(argv[2])
        else:
            args = json.load(sys.stdin)
        result = _dispatch(cmd, args)
    except EditError as exc:
        result = {"ok": False, "error": str(exc)}
    except KeyError as exc:
        result = {"ok": False, "error": f"falta el argumento {exc}"}
    except Exception as exc:  # nunca un traceback crudo al modelo
        result = {"ok": False, "error": f"error interno {type(exc).__name__}: {exc}"}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, default=str))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
