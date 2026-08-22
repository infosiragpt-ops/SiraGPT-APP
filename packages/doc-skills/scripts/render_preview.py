#!/usr/bin/env python3
"""Renderiza un OOXML a PDF (LibreOffice) y PNGs por página (pdftoppm).

  soffice --headless --convert-to pdf   (timeout 90s, process-group kill)
  pdftoppm -png -r 110
"""
from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys

from limits import PDFTOPPM_DPI, SOFFICE_TIMEOUT_SEC


def _die(msg: str, code: int = 2) -> None:
    sys.stderr.write(f"render_preview: {msg}\n")
    raise SystemExit(code)


def _which(name: str) -> str | None:
    return shutil.which(name) or shutil.which(name + ".exe")


def _kill_process_group(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def _run_group(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc)
        _die(f"timeout ({timeout}s) ejecutando {' '.join(cmd[:3])}", 3)
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def render(src: str, out_dir: str, timeout: int = SOFFICE_TIMEOUT_SEC) -> dict:
    if not os.path.isfile(src):
        _die(f"no existe el archivo: {src}")
    os.makedirs(out_dir, exist_ok=True)
    soffice = _which("soffice") or _which("libreoffice")
    if not soffice:
        _die("LibreOffice (soffice) no está en PATH. Instala libreoffice-writer.")
    cmd = [
        soffice,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--convert-to",
        "pdf",
        "--outdir",
        out_dir,
        src,
    ]
    proc = _run_group(cmd, timeout)
    if proc.returncode != 0:
        _die(
            f"soffice falló (exit {proc.returncode}): {(proc.stderr or proc.stdout or '').strip()[:500]}",
            4,
        )
    base = os.path.splitext(os.path.basename(src))[0]
    pdf = os.path.join(out_dir, base + ".pdf")
    if not os.path.isfile(pdf):
        pdfs = [os.path.join(out_dir, n) for n in os.listdir(out_dir) if n.lower().endswith(".pdf")]
        if not pdfs:
            _die(f"soffice no produjo PDF en {out_dir}")
        pdf = pdfs[0]
    pdftoppm = _which("pdftoppm")
    pages = []
    if pdftoppm:
        prefix = os.path.join(out_dir, "page")
        ppm = _run_group([pdftoppm, "-png", "-r", str(PDFTOPPM_DPI), pdf, prefix], timeout=60)
        if ppm.returncode != 0:
            _die(f"pdftoppm falló: {(ppm.stderr or '').strip()[:400]}", 5)
        pages = sorted(
            os.path.join(out_dir, n)
            for n in os.listdir(out_dir)
            if n.startswith("page") and n.endswith(".png")
        )
    sys.stdout.write(f"pdf={pdf}\npages={len(pages)}\n")
    return {"pdf": pdf, "pages": pages}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Render OOXML → PDF + PNG pages")
    p.add_argument("src")
    p.add_argument("out_dir")
    p.add_argument("--timeout", type=int, default=SOFFICE_TIMEOUT_SEC)
    args = p.parse_args(argv)
    render(args.src, args.out_dir, timeout=args.timeout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
