---
name: pdf-preview
description: Preview y validación de PDF para el motor documental. No reescribe OOXML.
---

# PDF skill

Los PDF **NO** son OOXML. Este skill **no** hace unpack-edit-repack.
No uses `ooxml_unpack.py` / `ooxml_repack.py` sobre un PDF.

## When to use

- Contar páginas del preview (`pypdf` o `/Type /Page`).
- Rasterizar páginas para verify visual: `pdftoppm -png -r 110`.

## When not to use

- Editar un DOCX/PPTX/XLSX (usa el skill OOXML correspondiente).
- "Reparar" un PDF reempaquetándolo como ZIP.

## Pipeline

- LibreOffice convierte DOCX/PPTX/XLSX → PDF (`render_preview.py`).
- Este skill opera sobre el PDF resultante.
- El job exige ≥ 1 página.

## Safety / limits

- No se extrae el PDF como ZIP.
- Preview timeout 90s (process-group kill de soffice).
- Vision (host): DeepSeek V4 Flash / Pro. OpenRouter prohibido.
- Closed DSL only — el modelo no emite XML ni código.
