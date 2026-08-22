#!/usr/bin/env python3
"""Valida un OOXML desempaquetado: XML bien formado + r:id / r:embed / r:link vs .rels.

Parser seguro (sin DTD, sin entidades, sin red). Sale con código distinto de 0
y un mensaje accionable si algo falla.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

from xml_io import parse_xml_file

RID_RE = re.compile(r"""(?:r:id|r:embed|r:link)\s*=\s*["']([^"']+)["']""")
REL_ID_RE = re.compile(r"""\bId\s*=\s*["']([^"']+)["']""")

CHECK_PARTS = (
    "word/document.xml",
    "ppt/presentation.xml",
    "xl/workbook.xml",
)


def _die(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"ooxml_validate: {msg}\n")
    raise SystemExit(code)


def _iter_xml_files(root: str):
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if name.endswith(".xml") or name.endswith(".rels"):
                yield os.path.join(dirpath, name)


def _rels_for_part(root: str, rel_part: str) -> str | None:
    directory, base = os.path.split(rel_part)
    candidate = os.path.join(root, directory, "_rels", base + ".rels")
    if os.path.isfile(candidate):
        return candidate
    return None


def _collect_rel_ids(rels_path: str) -> set[str]:
    text = open(rels_path, "r", encoding="utf-8").read()
    return set(REL_ID_RE.findall(text))


def _header_footer_parts(root: str) -> list[str]:
    word = os.path.join(root, "word")
    if not os.path.isdir(word):
        return []
    out = []
    for name in os.listdir(word):
        if re.match(r"^(header|footer)\d*\.xml$", name, re.I):
            out.append(os.path.join("word", name))
    return out


def validate(root: str) -> None:
    if not os.path.isdir(root):
        _die(f"no es un directorio: {root}")
    xml_files = list(_iter_xml_files(root))
    if not xml_files:
        _die("no hay XML que validar; ¿olvidaste unpack?")
    for path in xml_files:
        try:
            parse_xml_file(path)
        except Exception as err:
            rel = os.path.relpath(path, root)
            _die(f"XML mal formado en {rel}: {err}. Revisa namespaces y tags cerrados.")

    parts = [p for p in CHECK_PARTS if os.path.isfile(os.path.join(root, p))]
    parts.extend(_header_footer_parts(root))
    seen = set()
    ordered = []
    for p in parts:
        if p not in seen:
            seen.add(p)
            ordered.append(p)

    for rel_part in ordered:
        abs_part = os.path.join(root, rel_part)
        if not os.path.isfile(abs_part):
            continue
        text = open(abs_part, "r", encoding="utf-8").read()
        rids = RID_RE.findall(text)
        if not rids:
            continue
        rels = _rels_for_part(root, rel_part)
        if not rels:
            _die(
                f"{rel_part} referencia r:id {rids[0]} pero no existe "
                f"{os.path.dirname(rel_part)}/_rels/{os.path.basename(rel_part)}.rels. "
                "Añade la Relationship o elimina el r:id huérfano."
            )
        known = _collect_rel_ids(rels)
        missing = [rid for rid in rids if rid not in known]
        if missing:
            _die(
                f"{rel_part} usa r:id '{missing[0]}' que no está en {os.path.relpath(rels, root)}. "
                f"Ids conocidos: {', '.join(sorted(known)) or '(ninguno)'}. "
                "Corrige el Id o restaura la Relationship."
            )


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Validate unpacked OOXML with a secure parser")
    p.add_argument("root")
    args = p.parse_args(argv)
    validate(args.root)
    sys.stdout.write("ok\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
