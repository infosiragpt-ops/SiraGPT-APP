---
name: pptx-ooxml
description: Edición quirúrgica de PPTX (OOXML). Unpack/repack/validate/preview con los scripts compartidos.
---

# PPTX skill

Un `.pptx` es un ZIP de XML (`ppt/slides/slideN.xml`).

1. Unpack con `../../scripts/ooxml_unpack.py` (mismos límites zip-bomb / traversal).
2. Edita slides; no reconstruyas el deck desde texto extraído.
3. Valida r:id de `ppt/presentation.xml` vs `.rels`.
4. Repack (`[Content_Types].xml` primero, `ZIP_DEFLATED`).
5. Preview: `render_preview.py` (LibreOffice Impress → PDF → PNG).

No uses OpenRouter. El verify visual del host usa DeepSeek V4 Flash / Pro.
