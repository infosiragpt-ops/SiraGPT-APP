#!/usr/bin/env python3
"""transformToTemplate — transplanta el cuerpo de un DOCX fuente a una plantilla.

Contrato (SiraGPT, Luis Carrera):
  1. Copia la PLANTILLA como base (nunca el source).
  2. Mapea w:styleId source→template desde styles.xml (nombre, luego id).
  3. Transplanta w:p y w:tbl del source al body de la plantilla.
  4. NUNCA altera sectPr, headers, footers ni numbering de la plantilla.
  5. Los placeholders XXXXXXXX del body de la plantilla se reemplazan
     por el contenido real del source — ese era el bug de /chat UPN.

OpenRouter está prohibido en este motor.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NSMAP_W = {"w": W_NS, "r": R_NS}

# Scripts vecinos en este mismo directorio
HERE = os.path.dirname(os.path.abspath(__file__))


def _die(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"transform_to_template: {msg}\n")
    raise SystemExit(code)


def _qn(local: str, ns: str = W_NS) -> str:
    return f"{{{ns}}}{local}"


def _load(path: str) -> etree._ElementTree:
    parser = etree.XMLParser(remove_blank_text=False, huge_tree=True)
    return etree.parse(path, parser)


def _write(tree: etree._ElementTree, path: str) -> None:
    # no pretty_print — conserva whitespace y nsmap del árbol
    tree.write(
        path,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
        pretty_print=False,
    )


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def parse_styles(styles_path: str) -> list[dict]:
    if not os.path.isfile(styles_path):
        return []
    tree = _load(styles_path)
    out = []
    for el in tree.getroot().findall(_qn("style")):
        sid = el.get(_qn("styleId")) or ""
        name_el = el.find(_qn("name"))
        name = (name_el.get(_qn("val")) if name_el is not None else "") or sid
        typ = el.find(_qn("basedOn"))
        based = typ.get(_qn("val")) if typ is not None else ""
        out.append({"id": sid, "name": name, "basedOn": based})
    return out


def build_style_map(source_styles: list[dict], template_styles: list[dict]) -> dict[str, str]:
    """source styleId → template styleId. Nunca inventa ids que no existan en la plantilla."""
    tmpl_ids = {s["id"] for s in template_styles if s["id"]}
    tmpl_by_name = {}
    for s in template_styles:
        if s["id"]:
            tmpl_by_name.setdefault(_norm(s["name"]), s["id"])
            tmpl_by_name.setdefault(_norm(s["id"]), s["id"])
    fallback = "Normal" if "Normal" in tmpl_ids else (next(iter(tmpl_ids), ""))
    mapping: dict[str, str] = {}
    for s in source_styles:
        sid = s["id"]
        if not sid:
            continue
        if sid in tmpl_ids:
            mapping[sid] = sid
            continue
        by_name = tmpl_by_name.get(_norm(s["name"])) or tmpl_by_name.get(_norm(sid))
        mapping[sid] = by_name if by_name in tmpl_ids else fallback
    return mapping


def remap_styles(element: etree._Element, mapping: dict[str, str], allowed: set[str]) -> None:
    for el in element.iter():
        tag = el.tag if isinstance(el.tag, str) else ""
        if tag.endswith("}pStyle") or tag.endswith("}rStyle") or tag.endswith("}tblStyle"):
            val = el.get(_qn("val"))
            if not val:
                continue
            mapped = mapping.get(val, val if val in allowed else mapping.get(val, val))
            if mapped not in allowed:
                mapped = "Normal" if "Normal" in allowed else (next(iter(allowed), mapped))
            el.set(_qn("val"), mapped)


def _extract_sectpr_bytes(document_xml_path: str) -> bytes | None:
    raw = open(document_xml_path, "rb").read()
    # último sectPr del body — se conserva byte-a-byte
    matches = list(re.finditer(br"<w:sectPr[\s>][\s\S]*?</w:sectPr>", raw))
    return matches[-1].group(0) if matches else None


def transplant_body(source_doc: str, template_doc: str, mapping: dict[str, str], allowed: set[str]) -> None:
    src_tree = _load(source_doc)
    tmpl_tree = _load(template_doc)
    src_body = src_tree.getroot().find(_qn("body"))
    tmpl_body = tmpl_tree.getroot().find(_qn("body"))
    if src_body is None:
        _die("el source no tiene w:body")
    if tmpl_body is None:
        _die("la plantilla no tiene w:body")

    # Conservar sectPr de la PLANTILLA (objeto + bytes originales)
    tmpl_sect = tmpl_body.find(_qn("sectPr"))
    original_sectpr = _extract_sectpr_bytes(template_doc)

    blocks = []
    for child in list(src_body):
        tag = child.tag if isinstance(child.tag, str) else ""
        if tag.endswith("}p") or tag.endswith("}tbl"):
            clone = etree.fromstring(etree.tostring(child, pretty_print=False))
            for el in list(clone.iter()):
                eltag = el.tag if isinstance(el.tag, str) else ""
                if eltag.endswith("}sectPr"):
                    parent = el.getparent()
                    if parent is not None:
                        parent.remove(el)
            remap_styles(clone, mapping, allowed)
            blocks.append(clone)

    # Vaciar body de la plantilla EXCEPTO sectPr
    for child in list(tmpl_body):
        tag = child.tag if isinstance(child.tag, str) else ""
        if tag.endswith("}sectPr"):
            continue
        tmpl_body.remove(child)

    # Insertar bloques fuente ANTES del sectPr
    if tmpl_sect is not None:
        idx = list(tmpl_body).index(tmpl_sect)
        for i, block in enumerate(blocks):
            tmpl_body.insert(idx + i, block)
    else:
        for block in blocks:
            tmpl_body.append(block)

    _write(tmpl_tree, template_doc)

    # Restaurar sectPr byte-idéntico si el serializer lo tocó
    if original_sectpr:
        raw = open(template_doc, "rb").read()
        raw2, n = re.subn(br"<w:sectPr[\s>][\s\S]*?</w:sectPr>", original_sectpr, raw, count=1)
        if n:
            open(template_doc, "wb").write(raw2)


def transform(source_docx: str, template_docx: str, out_docx: str, work: str | None = None) -> dict:
    sys.path.insert(0, HERE)
    from ooxml_unpack import unpack
    from ooxml_repack import repack
    from ooxml_validate import validate

    tmp = work or tempfile.mkdtemp(prefix="doc-engine-")
    src_dir = os.path.join(tmp, "source")
    tmpl_dir = os.path.join(tmp, "template")
    os.makedirs(src_dir, exist_ok=True)
    os.makedirs(tmpl_dir, exist_ok=True)
    unpack(source_docx, src_dir)
    unpack(template_docx, tmpl_dir)

    src_styles = parse_styles(os.path.join(src_dir, "word", "styles.xml"))
    tmpl_styles = parse_styles(os.path.join(tmpl_dir, "word", "styles.xml"))
    allowed = {s["id"] for s in tmpl_styles if s["id"]}
    mapping = build_style_map(src_styles, tmpl_styles)

    src_doc = os.path.join(src_dir, "word", "document.xml")
    tmpl_doc = os.path.join(tmpl_dir, "word", "document.xml")
    if not os.path.isfile(src_doc) or not os.path.isfile(tmpl_doc):
        _die("falta word/document.xml en source o plantilla")

    transplant_body(src_doc, tmpl_doc, mapping, allowed)
    validate(tmpl_dir)
    os.makedirs(os.path.dirname(os.path.abspath(out_docx)) or ".", exist_ok=True)
    repack(tmpl_dir, out_docx)
    return {"out": out_docx, "mappedStyles": len(mapping), "templateStyles": len(allowed)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Transplant source body into template OOXML")
    p.add_argument("--source", required=True)
    p.add_argument("--template", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--work")
    args = p.parse_args(argv)
    result = transform(args.source, args.template, args.out, work=args.work)
    sys.stdout.write(f"ok mapped={result['mappedStyles']}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
