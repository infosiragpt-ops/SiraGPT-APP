---
name: xlsx-ooxml
description: Edición quirúrgica de XLSX (OOXML). Unpack/repack/validate/preview con los scripts compartidos.
---

# XLSX skill

Un `.xlsx` es un ZIP de XML (`xl/workbook.xml`, `xl/worksheets/`).

## When to use

- Editar celdas / sharedStrings con mínimo diff.
- Preview LibreOffice Calc → PDF.

## When not to use

- Reconstruir el libro desde CSV extraído.
- PDF nativo (no es OOXML).
- Pedir XML/código al modelo de visión.

## Pipeline

1. Unpack con `../../scripts/ooxml_unpack.py`.
2. Edita celdas / sharedStrings con mínimo diff.
3. Valida `r:id` / `r:embed` / `r:link` de `xl/workbook.xml` vs `.rels`.
4. Repack sin `pretty_print`, Content_Types primero, timestamps 1980-01-01.
5. Preview: `render_preview.py` (LibreOffice Calc → PDF).

## Safety / limits

Mismos límites que DOCX. Sin `extractall`. Rechaza traversal / symlink / zip-bomb.
Parser seguro (`xml_io.py`). Vision: DeepSeek V4 Flash / Pro. OpenRouter prohibido.
Closed DSL via `apply_visual_patch.py`.
