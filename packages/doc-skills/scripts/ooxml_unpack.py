#!/usr/bin/env python3
"""Desempaqueta un OOXML (docx/pptx/xlsx) con límites anti zip-bomb y path traversal.

Límites:
  - máximo 5000 entradas
  - máximo 200 MB descomprimidos
  - rechaza rutas absolutas, `..` y escapes fuera del destino
  - conserva [Content_Types].xml tal cual (no se reescribe)
"""
from __future__ import annotations

import argparse
import os
import sys
import zipfile

MAX_ENTRIES = 5000
MAX_UNCOMPRESSED = 200 * 1024 * 1024
CONTENT_TYPES = "[Content_Types].xml"


def _die(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"ooxml_unpack: {msg}\n")
    raise SystemExit(code)


def _safe_join(dest: str, name: str) -> str:
    if not name or name.endswith("/"):
        return ""
    raw = name.replace("\\", "/")
    if raw.startswith("/") or raw.startswith("\\"):
        _die(f"path traversal: ruta absoluta '{name}'")
    if raw.startswith("../") or "/../" in raw or raw == ".." or raw.endswith("/.."):
        _die(f"path traversal: '{name}'")
    parts = []
    for part in raw.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            _die(f"path traversal: '{name}'")
        parts.append(part)
    if not parts:
        _die(f"entrada vacía: '{name}'")
    dest_abs = os.path.abspath(dest)
    out = os.path.abspath(os.path.join(dest_abs, *parts))
    if out != dest_abs and not out.startswith(dest_abs + os.sep):
        _die(f"path traversal: '{name}' escapa de {dest}")
    return out


def unpack(archive: str, dest: str) -> dict:
    if not zipfile.is_zipfile(archive):
        _die(f"no es un ZIP OOXML válido: {archive}")
    os.makedirs(dest, exist_ok=True)
    total = 0
    names = []
    with zipfile.ZipFile(archive, "r") as zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            _die(f"zip-bomb: {len(infos)} entradas (máximo {MAX_ENTRIES})", 3)
        names = [i.filename for i in infos]
        if CONTENT_TYPES not in names and CONTENT_TYPES.replace("\\", "/") not in names:
            # algunos writers usan mayúsculas distintas; buscamos case-insensitive
            has_ct = any(n.replace("\\", "/").lower() == CONTENT_TYPES.lower() for n in names)
            if not has_ct:
                _die(f"falta {CONTENT_TYPES}; el paquete no es OOXML válido", 4)
        for info in infos:
            name = info.filename.replace("\\", "/")
            if name.endswith("/"):
                target = _safe_join(dest, name.rstrip("/") + "/x")
                # directorio: crear sin el dummy
                dirpath = os.path.dirname(target)
                os.makedirs(dirpath, exist_ok=True)
                continue
            if info.file_size < 0 or (info.compress_size and info.file_size > MAX_UNCOMPRESSED):
                _die(f"zip-bomb: entrada '{name}' declara {info.file_size} bytes", 3)
            target = _safe_join(dest, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info, "r") as src, open(target, "wb") as dst:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_UNCOMPRESSED:
                        _die(f"zip-bomb: descomprimido supera {MAX_UNCOMPRESSED} bytes", 3)
                    dst.write(chunk)
    return {"entries": len(names), "bytes": total, "dest": dest}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Unpack OOXML with zip-bomb / traversal guards")
    p.add_argument("archive")
    p.add_argument("dest")
    args = p.parse_args(argv)
    result = unpack(args.archive, args.dest)
    sys.stdout.write(f"unpacked {result['entries']} entries ({result['bytes']} bytes)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
