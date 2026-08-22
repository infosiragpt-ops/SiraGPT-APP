---
name: pptx-ooxml
description: Edición quirúrgica de PPTX (OOXML). Unpack/repack/validate/preview con los scripts compartidos.
---

# PPTX skill

Un `.pptx` es un ZIP de XML (`ppt/slides/slideN.xml`).

## When to use

- Editar slides conservando layouts, relaciones y media del deck.
- Preview LibreOffice Impress → PDF → PNG.

## When not to use

- Reconstruir el deck desde texto extraído.
- PDF nativo (no es OOXML).
- Pedir XML/código al modelo de visión.

## Pipeline

1. Unpack con `../../scripts/ooxml_unpack.py` (límites zip-bomb / traversal / symlink).
2. Edita slides; no reconstruyas el deck desde texto extraído.
3. Valida `r:id` / `r:embed` / `r:link` de `ppt/presentation.xml` vs `.rels`.
4. Repack (`[Content_Types].xml` primero, `ZIP_DEFLATED`, timestamps deterministas).
5. Preview: `render_preview.py` (LibreOffice Impress → PDF → PNG @ 110 dpi).

## Safety / limits

Mismos scripts y límites que DOCX (`limits.py`, `xml_io.py`). Sin `extractall`.
Parser seguro. Vision: DeepSeek V4 Flash / Pro en el host. OpenRouter prohibido.
Closed DSL via `apply_visual_patch.py` — nunca XML del modelo.
