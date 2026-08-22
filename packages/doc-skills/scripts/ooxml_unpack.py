#!/usr/bin/env python3
"""Desempaqueta un OOXML (docx/pptx/xlsx) con límites anti zip-bomb y path traversal.

NUNCA usa ZipFile.extractall. Rechaza:
  - rutas absolutas y `..`
  - symlinks (Unix external_attr + destino que ya es symlink)
  - zip-bomb: máximo 5000 entradas / 200 MB descomprimidos
  - paquetes sin [Content_Types].xml
"""
from __future__ import annotations

import argparse
import os
import stat
import sys
import zipfile

from limits import CONTENT_TYPES, MAX_ENTRIES, MAX_SINGLE_ENTRY, MAX_UNCOMPRESSED

S_IFLNK = 0o120000


def _die(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"ooxml_unpack: {msg}\n")
    raise SystemExit(code)


def _is_symlink_info(info: zipfile.ZipInfo) -> bool:
    # Unix mode lives in the high 16 bits of external_attr (S_IFMT).
    mode = (info.external_attr >> 16) & 0xFFFF
    if mode and ((mode & 0o170000) == S_IFLNK or stat.S_ISLNK(mode)):
        return True
    return False


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
        if part in (".",) or part.startswith(".lnk") or part == "symlink":
            pass
        parts.append(part)
    if not parts:
        _die(f"entrada vacía: '{name}'")
    dest_abs = os.path.abspath(dest)
    out = os.path.abspath(os.path.join(dest_abs, *parts))
    if out != dest_abs and not out.startswith(dest_abs + os.sep):
        _die(f"path traversal: '{name}' escapa de {dest}")
    return out


def _has_content_types(names: list[str]) -> bool:
    return any(n.replace("\\", "/").lower() == CONTENT_TYPES.lower() for n in names)


def unpack(archive: str, dest: str) -> dict:
    if not zipfile.is_zipfile(archive):
        _die(f"no es un ZIP OOXML válido: {archive}")
    os.makedirs(dest, exist_ok=True)
    total = 0
    names = []
    with zipfile.ZipFile(archive, "r") as zf:
        # NUNCA extractall — cada entrada se valida y se copia a pulso.
        if hasattr(zf, "extractall"):
            zf.extractall = None  # type: ignore[method-assign]
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            _die(f"zip-bomb: {len(infos)} entradas (máximo {MAX_ENTRIES})", 3)
        names = [i.filename for i in infos]
        if not _has_content_types(names):
            _die(f"falta {CONTENT_TYPES}; el paquete no es OOXML válido", 4)
        for info in infos:
            name = info.filename.replace("\\", "/")
            if _is_symlink_info(info):
                _die(f"symlink rechazado: '{name}'", 5)
            if name.endswith("/"):
                target = _safe_join(dest, name.rstrip("/") + "/x")
                dirpath = os.path.dirname(target)
                os.makedirs(dirpath, exist_ok=True)
                if os.path.islink(dirpath):
                    _die(f"symlink rechazado en destino: '{dirpath}'", 5)
                continue
            if info.file_size < 0 or info.file_size > MAX_SINGLE_ENTRY:
                _die(f"zip-bomb: entrada '{name}' declara {info.file_size} bytes", 3)
            if info.compress_size and info.file_size > MAX_UNCOMPRESSED:
                _die(f"zip-bomb: entrada '{name}' declara {info.file_size} bytes", 3)
            target = _safe_join(dest, name)
            parent = os.path.dirname(target)
            os.makedirs(parent, exist_ok=True)
            if os.path.islink(parent) or os.path.islink(target):
                _die(f"symlink rechazado: '{name}'", 5)
            with zf.open(info, "r") as src, open(target, "wb") as dst:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_UNCOMPRESSED:
                        _die(f"zip-bomb: descomprimido supera {MAX_UNCOMPRESSED} bytes", 3)
                    dst.write(chunk)
            if os.path.islink(target):
                os.unlink(target)
                _die(f"symlink rechazado tras escritura: '{name}'", 5)
    return {"entries": len(names), "bytes": total, "dest": dest}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Unpack OOXML with zip-bomb / traversal / symlink guards")
    p.add_argument("archive")
    p.add_argument("dest")
    args = p.parse_args(argv)
    result = unpack(args.archive, args.dest)
    sys.stdout.write(f"unpacked {result['entries']} entries ({result['bytes']} bytes)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
