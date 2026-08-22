#!/usr/bin/env python3
"""transformToTemplate — transplanta el cuerpo de un DOCX fuente a una plantilla.

Contrato (SiraGPT, Luis Carrera):
  1. Copia la PLANTILLA como base (nunca el source).
  2. Mapea w:styleId source→template desde styles.xml (nombre, luego id).
  3. Transplanta w:p y w:tbl del source al body de la plantilla.
  4. NUNCA altera sectPr, headers, footers ni numbering de la plantilla.
  5. El sectPr terminal (último del body) queda byte-idéntico (SHA-256).
  6. Rechaza OLE / ActiveX / macros.
  7. Los placeholders XXXXXXXX del body se reemplazan por el contenido real.

OpenRouter está prohibido en este motor. Vision corre en el control plane.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import tempfile

from xml_io import parse_xml_file, write_xml

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

HERE = os.path.dirname(os.path.abspath(__file__))

UNSAFE_NAME_RE = re.compile(
    r"(vbaproject|vbaData|activex|oleobject|oleObject|\.bin$)",
    re.I,
)
UNSAFE_DIR_RE = re.compile(r"(activex|embeddings|macros|vba)", re.I)
SECTPR_RE = re.compile(br"<w:sectPr[\s>][\s\S]*?</w:sectPr>")


def _die(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"transform_to_template: {msg}\n")
    raise SystemExit(code)


def _qn(local: str, ns: str = W_NS) -> str:
    return f"{{{ns}}}{local}"


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def reject_unsafe_package(root: str) -> None:
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        if UNSAFE_DIR_RE.search(rel_dir):
            _die(f"OLE/ActiveX/macros rechazados en '{rel_dir}'", 6)
        for name in filenames:
            rel = f"{rel_dir}/{name}" if rel_dir != "." else name
            if UNSAFE_NAME_RE.search(name) or UNSAFE_NAME_RE.search(rel):
                _die(f"OLE/ActiveX/macros rechazados: '{rel}'", 6)


def parse_styles(styles_path: str) -> list[dict]:
    if not os.path.isfile(styles_path):
        return []
    tree = parse_xml_file(styles_path)
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


def remap_styles(element, mapping: dict[str, str], allowed: set[str]) -> None:
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


def extract_terminal_sectpr(raw: bytes) -> bytes | None:
    last = None
    for m in SECTPR_RE.finditer(raw):
        last = m.group(0)
    return last


def restore_terminal_sectpr(path: str, original: bytes) -> None:
    raw = open(path, "rb").read()
    matches = list(SECTPR_RE.finditer(raw))
    if not matches:
        return
    last = matches[-1]
    raw2 = raw[: last.start()] + original + raw[last.end() :]
    open(path, "wb").write(raw2)


def _untouched_parts(root: str) -> dict[str, str]:
    hashes = {}
    word = os.path.join(root, "word")
    if not os.path.isdir(word):
        return hashes
    numbering = os.path.join(word, "numbering.xml")
    if os.path.isfile(numbering):
        hashes["word/numbering.xml"] = file_sha256(numbering)
    for name in os.listdir(word):
        if re.match(r"^(header|footer)\d*\.xml$", name, re.I):
            rel = f"word/{name}"
            hashes[rel] = file_sha256(os.path.join(word, name))
    return hashes


def transplant_body(source_doc: str, template_doc: str, mapping: dict[str, str], allowed: set[str]) -> dict:
    from lxml import etree

    src_tree = parse_xml_file(source_doc)
    tmpl_tree = parse_xml_file(template_doc)
    src_body = src_tree.getroot().find(_qn("body"))
    tmpl_body = tmpl_tree.getroot().find(_qn("body"))
    if src_body is None:
        _die("el source no tiene w:body")
    if tmpl_body is None:
        _die("la plantilla no tiene w:body")

    original_sectpr = extract_terminal_sectpr(open(template_doc, "rb").read())
    if not original_sectpr:
        _die("la plantilla no tiene w:sectPr terminal; no se puede preservar el layout")
    original_sha = sha256_bytes(original_sectpr)

    tmpl_sect = None
    for child in list(tmpl_body):
        tag = child.tag if isinstance(child.tag, str) else ""
        if tag.endswith("}sectPr"):
            tmpl_sect = child

    blocks = []
    for child in list(src_body):
        tag = child.tag if isinstance(child.tag, str) else ""
        if tag.endswith("}p") or tag.endswith("}tbl"):
            clone = etree.fromstring(etree.tostring(child, pretty_print=False))
            remap_styles(clone, mapping, allowed)
            blocks.append(clone)

    for child in list(tmpl_body):
        tag = child.tag if isinstance(child.tag, str) else ""
        if tag.endswith("}sectPr"):
            continue
        tmpl_body.remove(child)

    if tmpl_sect is not None:
        idx = list(tmpl_body).index(tmpl_sect)
        for i, block in enumerate(blocks):
            tmpl_body.insert(idx + i, block)
    else:
        for block in blocks:
            tmpl_body.append(block)

    write_xml(tmpl_tree, template_doc)
    restore_terminal_sectpr(template_doc, original_sectpr)

    result_sectpr = extract_terminal_sectpr(open(template_doc, "rb").read())
    if result_sectpr != original_sectpr or sha256_bytes(result_sectpr or b"") != original_sha:
        _die("sectPr terminal no quedó byte-idéntico (SHA-256 mismatch)")
    return {"sectPrSha256": original_sha, "blocks": len(blocks)}


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
    reject_unsafe_package(src_dir)
    reject_unsafe_package(tmpl_dir)

    before = _untouched_parts(tmpl_dir)

    src_styles = parse_styles(os.path.join(src_dir, "word", "styles.xml"))
    tmpl_styles = parse_styles(os.path.join(tmpl_dir, "word", "styles.xml"))
    allowed = {s["id"] for s in tmpl_styles if s["id"]}
    mapping = build_style_map(src_styles, tmpl_styles)

    src_doc = os.path.join(src_dir, "word", "document.xml")
    tmpl_doc = os.path.join(tmpl_dir, "word", "document.xml")
    if not os.path.isfile(src_doc) or not os.path.isfile(tmpl_doc):
        _die("falta word/document.xml en source o plantilla")

    meta = transplant_body(src_doc, tmpl_doc, mapping, allowed)
    after = _untouched_parts(tmpl_dir)
    if before != after:
        _die("headers/footers/numbering.xml de la plantilla fueron alterados")

    validate(tmpl_dir)
    os.makedirs(os.path.dirname(os.path.abspath(out_docx)) or ".", exist_ok=True)
    repack(tmpl_dir, out_docx)
    return {
        "out": out_docx,
        "mappedStyles": len(mapping),
        "templateStyles": len(allowed),
        "sectPrSha256": meta["sectPrSha256"],
        "headerFooterHashes": after,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Transplant source body into template OOXML")
    p.add_argument("--source", required=True)
    p.add_argument("--template", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--work")
    args = p.parse_args(argv)
    result = transform(args.source, args.template, args.out, work=args.work)
    sys.stdout.write(f"ok mapped={result['mappedStyles']} sectPr={result['sectPrSha256'][:12]}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
