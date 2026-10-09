"""Bounded, transactional conversions inside the existing document sandbox.

Use through execute_python: convert('uploads/source.docx', 'outputs/result.pdf').
This module never installs packages, fetches URLs, or replaces an existing file.
PDF -> DOCX reconstructs editable text/tables/images; it does not promise the
original page layout. Reports describe the actual saved bytes and limitations.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


MAX_BYTES = 100 * 1024 * 1024
MAX_PAGES = 200
MAX_SECONDS = 1200
PAIRS = {("docx", "pdf"), ("pdf", "docx"), ("mp3", "mp4"), ("mp4", "mp3")}


class ConversionError(Exception):
    def __init__(self, code, message, next_action=None):
        super().__init__(message)
        self.code = code
        self.next_action = next_action


def _path(value, root):
    raw = str(value)
    if raw.startswith("/workspace/"):
        raw = raw[len("/workspace/"):]
    path = (root / raw).resolve()
    if not path.is_relative_to(root):
        raise ConversionError("E_PARAMS", "La ruta debe permanecer dentro del espacio de trabajo.")
    return path


def _tool(*names):
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    raise ConversionError("E_PROVIDER", "El entorno aislado no tiene el conversor necesario.",
                          "Preparar la imagen oficial del sandbox con sus dependencias y reanudar la conversión.")


def _run(args, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ConversionError("E_TIMEOUT", "Se agotó el tiempo de conversión; el original sigue intacto.")
    try:
        result = subprocess.run(args, capture_output=True, timeout=remaining,
                                env={**os.environ, "LC_ALL": "C"})
    except subprocess.TimeoutExpired:
        raise ConversionError("E_TIMEOUT", "Se agotó el tiempo de conversión; el original sigue intacto.") from None
    if result.returncode:
        # Input metadata and native stderr may contain user data. Do not echo it.
        raise ConversionError("E_CONTENT", "El conversor no pudo procesar este archivo.",
                              "Comprueba que el archivo se abre correctamente y no está protegido.")
    return result


def _pdf_reader(path):
    from pypdf import PdfReader
    with open(path, "rb") as source:
        if b"%PDF-" not in source.read(1024):
            raise ConversionError("E_CONTENT", "El archivo no contiene un PDF válido.")
    reader = PdfReader(path)
    if reader.is_encrypted:
        raise ConversionError("E_CONTENT", "El PDF está protegido; se necesita una copia desbloqueada.")
    if not 0 < len(reader.pages) <= MAX_PAGES:
        raise ConversionError("E_PARAMS", f"La conversión admite entre 1 y {MAX_PAGES} páginas por archivo.")
    return reader


def _word_to_pdf(src, dst, work, deadline):
    from docx import Document
    Document(src)  # Reopen the actual input package before invoking an engine.
    profile = work / "profile"
    converted = work / "render"
    converted.mkdir()
    _run([_tool("soffice", "libreoffice"), f"-env:UserInstallation={profile.as_uri()}",
          "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
          "--convert-to", "pdf:writer_pdf_Export", "--outdir", str(converted), str(src)], deadline)
    result = converted / (src.stem + ".pdf")
    if not result.is_file() or result.stat().st_size == 0:
        raise ConversionError("E_CONTENT", "No se generó un PDF válido.")
    reader = _pdf_reader(result)
    shutil.move(result, dst)
    return {"pages": len(reader.pages), "fidelity": "office_render",
            "warnings": ["Comprueba las fuentes y los saltos de página en la vista previa del PDF."]}


def _words(text):
    return Counter(re.findall(r"\w+", text.casefold()))


def _pdf_to_word(src, dst, _work, deadline):
    import pdfplumber
    from docx import Document
    from docx.shared import Inches

    reader = _pdf_reader(src)
    document = Document()
    source_text = []
    copied_text = []
    table_count = 0
    image_count = 0
    pages_without_text = []
    warnings = ["El Word contiene texto, tablas e imágenes editables reconstruidos. "
                "La distribución, los gráficos vectoriales y los saltos no son una copia exacta del PDF."]
    with pdfplumber.open(src) as pdf:
        for index, page in enumerate(pdf.pages):
            if time.monotonic() >= deadline:
                raise ConversionError("E_TIMEOUT", "Se agotó el tiempo de conversión del PDF.")
            text = page.extract_text() or ""
            source_text.append(text)
            if not text.strip():
                pages_without_text.append(index + 1)
            tables = page.find_tables()

            def outside_tables(obj):
                if obj.get("object_type") != "char":
                    return True
                cx = (obj["x0"] + obj["x1"]) / 2
                cy = (obj["top"] + obj["bottom"]) / 2
                return not any(t.bbox[0] <= cx <= t.bbox[2] and t.bbox[1] <= cy <= t.bbox[3] for t in tables)

            plain = page.filter(outside_tables).extract_text() or ""
            for line in plain.splitlines():
                document.add_paragraph(line)
                copied_text.append(line)
            for found in tables:
                rows = found.extract()
                columns = max((len(row) for row in rows), default=0)
                if not rows or not columns:
                    continue
                table = document.add_table(rows=len(rows), cols=columns)
                table.style = "Table Grid"
                for row_no, row in enumerate(rows):
                    for col_no, value in enumerate(row):
                        value = value or ""
                        table.cell(row_no, col_no).text = value
                        copied_text.append(value)
                table_count += 1
            # Resources may be shared by several PDF pages, including pages
            # that never draw an image. Copy actual paint occurrences only.
            resources = reader.pages[index].images
            for occurrence in page.images:
                name = "/" + occurrence["name"]
                keys = [key for key in resources.keys()
                        if (key[-1] if isinstance(key, (list, tuple)) else key) == name]
                if len(keys) != 1:
                    warnings.append(f"Una imagen de la página {index + 1} requiere revisión manual.")
                    continue
                try:
                    # python-docx accepts common raster formats. An unsupported
                    # embedded image is disclosed rather than silently dropped.
                    image = resources[keys[0]]
                    width = max(.1, min(5.8, float(occurrence["x1"] - occurrence["x0"]) / 72))
                    document.add_picture(io.BytesIO(image.data), width=Inches(width))
                    image_count += 1
                except (ValueError, TypeError, OSError, KeyError):
                    warnings.append(f"Una imagen de la página {index + 1} no se pudo trasladar al Word.")
            if index < len(pdf.pages) - 1:
                document.add_page_break()
    if not any(text.strip() for text in source_text):
        raise ConversionError("E_CONTENT", "El PDF no tiene texto extraíble; requiere OCR antes de crear un Word editable.",
                              "Aplicar OCR al PDF en el sandbox y volver a convertir; no entregar un Word vacío.")
    if _words("\n".join(source_text)) - _words("\n".join(copied_text)):
        raise ConversionError("E_CONTENT", "La reconstrucción no conservó todo el texto extraíble del PDF.",
                              "Revisar las tablas y la extracción antes de entregar una conversión incompleta.")
    if pages_without_text:
        warnings.append("Páginas sin texto extraíble (requieren OCR para editar su contenido): "
                        + ", ".join(map(str, pages_without_text)))
    document.save(dst)
    reopened = Document(dst)
    native_text = "\n".join([p.text for p in reopened.paragraphs]
                             + [cell.text for table in reopened.tables for row in table.rows for cell in row.cells])
    if _words("\n".join(source_text)) - _words(native_text):
        raise ConversionError("E_CONTENT", "El Word guardado no superó la comprobación de texto.")
    return {"pages": len(reader.pages), "tables": table_count, "images": image_count,
            "fidelity": "editable_reconstruction", "text_preserved": True, "warnings": warnings}


def _media_input(path):
    # Force a local demuxer; a playlist disguised with an MP3/MP4 extension
    # must never cause FFmpeg to fetch another file or a network resource.
    return ["-protocol_whitelist", "file,pipe", "-f", "mp3" if path.suffix.lower() == ".mp3" else "mov",
            "-i", str(path)]


def _probe_media(path, deadline):
    ffmpeg = _tool("ffmpeg")
    result = _run([ffmpeg, "-hide_banner", "-nostdin", *_media_input(path),
                   "-map", "0:a?", "-map", "0:v?", "-c", "copy", "-t", "0", "-f", "null", "-"], deadline)
    # Read only the input section (the output section repeats stream names).
    info = result.stderr.decode("utf-8", "replace").split("Output #", 1)[0]
    duration = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", info)
    if not duration:
        raise ConversionError("E_CONTENT", "No se pudo verificar la duración del archivo multimedia.")
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
    if not math.isfinite(seconds) or not 0 < seconds <= MAX_SECONDS:
        raise ConversionError("E_PARAMS", f"La conversión admite hasta {MAX_SECONDS // 60} minutos por archivo.")
    streams = [{"type": kind.lower(), "codec": codec}
               for kind, codec in re.findall(r"Stream #0:\d+[^\n]*?: (Audio|Video): ([\w]+)", info)]
    if not streams:
        raise ConversionError("E_CONTENT", "No se encontraron pistas multimedia legibles.")
    return {"duration_seconds": seconds, "streams": streams}


def _convert_media(src, dst, _work, deadline):
    source = _probe_media(src, deadline)
    if not any(s["type"] == "audio" for s in source["streams"]):
        raise ConversionError("E_CONTENT", "El archivo no contiene una pista de audio para convertir.")
    command = [_tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-y"]
    warnings = []
    if dst.suffix == ".mp4":
        command += ["-f", "lavfi", "-i", "color=c=0x111827:s=1280x720:r=25",
                    *_media_input(src), "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "libx264", "-threads", "1", "-tune", "stillimage", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-shortest", "-t", str(source["duration_seconds"]),
                    "-movflags", "+faststart"]
        warnings.append("El MP4 usa un fondo fijo y conserva el audio; no se generó una escena de video.")
    else:
        command += [*_media_input(src), "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-q:a", "2"]
        warnings.append("Se extrajo la primera pista de audio. El MP3 no contiene imagen ni otras pistas.")
    command += ["-map_metadata", "-1", str(dst)]
    _run(command, deadline)
    output = _probe_media(dst, deadline)
    tracks = {(s["type"], s["codec"]) for s in output["streams"]}
    expected = {("video", "h264"), ("audio", "aac")} if dst.suffix == ".mp4" else {("audio", "mp3")}
    if not expected.issubset(tracks) or (dst.suffix == ".mp3" and any(s["type"] == "video" for s in output["streams"])):
        raise ConversionError("E_CONTENT", "Las pistas guardadas no coinciden con el formato solicitado.")
    if abs(output["duration_seconds"] - source["duration_seconds"]) > max(0.5, source["duration_seconds"] * .01):
        raise ConversionError("E_CONTENT", "La duración cambió durante la conversión; no se entregó el archivo.")
    _decode_media(dst, output, deadline)
    return {**output, "decoded": True, "fidelity": "transcoded", "warnings": warnings}


def _decode_media(path, metadata, deadline):
    # Decode every saved stream, catching corrupt middle/end frames. Progress
    # also rejects a container with valid metadata but no actual media packets.
    result = _run([_tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror",
                   *_media_input(path), "-map", "0:a?", "-map", "0:v?", "-progress", "pipe:1",
                   "-nostats", "-f", "null", "-"], deadline)
    progress = result.stdout.decode("utf-8", "replace")
    times = re.findall(r"^out_time_us=(\d+)$", progress, re.M)
    decoded = int(times[-1]) / 1_000_000 if times else 0
    frames = re.findall(r"^frame=(\d+)$", progress, re.M)
    duration = metadata["duration_seconds"]
    if decoded <= 0 or decoded < duration - max(.5, duration * .02):
        raise ConversionError("E_CONTENT", "No se pudo decodificar la duración completa del archivo.")
    if any(s["type"] == "video" for s in metadata["streams"]) and (not frames or int(frames[-1]) == 0):
        raise ConversionError("E_CONTENT", "El video no contiene fotogramas decodificables.")


def verify_media_file(path, timeout=120, expected_sha256=None):
    """Read actual bytes again. Used independently by the server delivery gate."""
    path = Path(path)
    if path.suffix.lower() not in (".mp3", ".mp4") or not 0 < path.stat().st_size <= MAX_BYTES:
        raise ConversionError("E_PARAMS", "Formato o tamaño multimedia no permitido.")
    content = path.read_bytes()
    if not 0 < len(content) <= MAX_BYTES:
        raise ConversionError("E_PARAMS", "Formato o tamaño multimedia no permitido.")
    digest = hashlib.sha256(content).hexdigest()
    if expected_sha256 is not None and digest != expected_sha256:
        raise ConversionError("E_CONTENT", "Los bytes cambiaron antes de verificarse.")
    deadline = time.monotonic() + timeout
    # Decode a private snapshot of the bytes read and hashed once, not the
    # mutable model workspace path. Also detect a changed validation copy.
    with tempfile.TemporaryDirectory(prefix="sira-media-verify-") as directory:
        snapshot = Path(directory) / ("snapshot" + path.suffix.lower())
        snapshot.write_bytes(content)
        snapshot.chmod(0o600)
        metadata = _probe_media(snapshot, deadline)
        required = "audio" if path.suffix.lower() == ".mp3" else "video"
        if not any(s["type"] == required for s in metadata["streams"]):
            raise ConversionError("E_CONTENT", "El archivo no contiene la pista necesaria para ese formato.")
        if required == "audio" and not any(s["codec"] == "mp3" for s in metadata["streams"]):
            raise ConversionError("E_CONTENT", "El archivo no contiene audio MP3.")
        _decode_media(snapshot, metadata, deadline)
        if hashlib.sha256(snapshot.read_bytes()).hexdigest() != digest:
            raise ConversionError("E_CONTENT", "Los bytes cambiaron durante la verificación.")
    return {**metadata, "decoded": True, "sha256": digest}


def convert(src, dst, *, timeout=180):
    """Return a JSON-safe report. On failure no new output file is published."""
    try:
        if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 180:
            raise ConversionError("E_PARAMS", "El tiempo máximo debe estar entre 1 y 180 segundos.")
        root = Path.cwd().resolve()
        source, target = _path(src, root), _path(dst, root)
        if not target.is_relative_to(root / "outputs"):
            raise ConversionError("E_PARAMS", "El resultado debe guardarse en outputs/.")
        if target.exists() or target.is_symlink():
            raise ConversionError("E_PARAMS", "Ese archivo de salida ya existe; usa un nombre nuevo para conservarlo.")
        if not source.is_file() or not 0 < source.stat().st_size <= MAX_BYTES:
            raise ConversionError("E_PARAMS", "El archivo de origen no existe, está vacío o supera 100 MB.")
        pair = (source.suffix.lower().lstrip("."), target.suffix.lower().lstrip("."))
        if pair not in PAIRS:
            raise ConversionError("E_PARAMS", "Este conversor admite Word/PDF y MP3/MP4 en ambos sentidos.")
        target.parent.mkdir(parents=True, exist_ok=True)
        temp_root = _path("tmp", root)
        temp_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="conversion-", dir=temp_root) as folder:
            work = Path(folder)
            pending = work / ("result." + pair[1])
            deadline = time.monotonic() + timeout
            handler = _word_to_pdf if pair == ("docx", "pdf") else _pdf_to_word if pair == ("pdf", "docx") else _convert_media
            details = handler(source, pending, work, deadline)
            size = pending.stat().st_size
            if not 0 < size <= MAX_BYTES:
                raise ConversionError("E_CONTENT", "El archivo convertido está vacío o supera 100 MB.")
            digest = hashlib.sha256(pending.read_bytes()).hexdigest()
            # Exclusive publication protects an existing artifact even when
            # another worker uses the same destination concurrently.
            try:
                os.link(pending, target)
            except FileExistsError:
                raise ConversionError("E_PARAMS", "Ese nombre de salida acaba de utilizarse; elige otro.") from None
            return {"ok": True, "output": str(target.relative_to(root)), "format": pair[1],
                    "bytes": size, "sha256": digest, "validated": True, **details}
    except ConversionError as exc:
        return {"ok": False, "code": exc.code, "error": str(exc), "next_action": exc.next_action}
    except ImportError:
        return {"ok": False, "code": "E_PROVIDER", "error": "Falta una dependencia del conversor en el sandbox.",
                "next_action": "Preparar la imagen oficial del sandbox y reanudar; no instalar paquetes arbitrarios."}
    except Exception:
        return {"ok": False, "code": "E_CONTENT", "error": "El archivo no pudo convertirse y verificarse; el original sigue intacto.",
                "next_action": "Revisa que el archivo se abre correctamente y prueba con una copia desbloqueada."}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args()
    print(json.dumps(convert(args.source, args.destination), ensure_ascii=False))
