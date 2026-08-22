---
name: xlsx-ooxml
description: Edición quirúrgica de XLSX (OOXML). Unpack/repack/validate/preview con los scripts compartidos.
---

# XLSX skill

Un `.xlsx` es un ZIP de XML (`xl/workbook.xml`, `xl/worksheets/`).

1. Unpack con `../../scripts/ooxml_unpack.py`.
2. Edita celdas / sharedStrings con mínimo diff.
3. Valida r:id de `xl/workbook.xml` vs `.rels`.
4. Repack sin pretty_print.
5. Preview: `render_preview.py` (LibreOffice Calc → PDF).

OpenRouter está prohibido en el verify loop.
