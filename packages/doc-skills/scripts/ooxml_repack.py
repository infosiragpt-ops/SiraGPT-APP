#!/usr/bin/env python3
"""Reempaqueta un directorio OOXML a ZIP_DEFLATED.

Reglas:
  - [Content_Types].xml SIEMPRE va primero (Word/Excel/PowerPoint lo exigen)
  - ZIP_DEFLATED
  - no pretty_print — se escriben los bytes tal cual están en disco
  - no se reescribe XML; el nsmap original se conserva
"""
from __future__ import annotations

import argparse
import os
import sys
import zipfile

CONTENT_TYPES = "[Content_Types].xml"


def _die(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"ooxml_repack: {msg}\n")
    raise SystemExit(code)


def _walk(root: str) -> list[str]:
    out = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            abs_path = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_path, root).replace(os.sep, "/")
            out.append(rel)
    return out


def repack(src_dir: str, dest_archive: str) -> dict:
    if not os.path.isdir(src_dir):
        _die(f"no es un directorio: {src_dir}")
    names = _walk(src_dir)
    ct = None
    for n in names:
        if n.lower() == CONTENT_TYPES.lower() or n.endswith("/" + CONTENT_TYPES):
            ct = n
            break
    if ct is None:
        _die(f"falta {CONTENT_TYPES}; no se reempaqueta un OOXML incompleto")
    ordered = [ct] + [n for n in sorted(names) if n != ct]
    os.makedirs(os.path.dirname(os.path.abspath(dest_archive)) or ".", exist_ok=True)
    with zipfile.ZipFile(dest_archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in ordered:
            abs_path = os.path.join(src_dir, rel.replace("/", os.sep))
            # writestr/write copian bytes crudos — no pretty_print
            zf.write(abs_path, arcname=rel)
    return {"entries": len(ordered), "archive": dest_archive}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Repack OOXML with Content_Types first")
    p.add_argument("src_dir")
    p.add_argument("dest_archive")
    args = p.parse_args(argv)
    result = repack(args.src_dir, args.dest_archive)
    sys.stdout.write(f"repacked {result['entries']} entries → {result['archive']}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
