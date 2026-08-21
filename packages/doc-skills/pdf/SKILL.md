---
name: pdf-preview
description: Preview y validación de PDF para el motor documental. No reescribe OOXML.
---

# PDF skill

Los PDF no son OOXML. Este skill solo cubre preview / conteo de páginas.

- `pdftoppm -png -r 110` para páginas de verificación visual.
- `pypdf` para contar páginas (el job exige ≥ 1 página).
- LibreOffice convierte DOCX/PPTX/XLSX → PDF; este skill opera sobre el PDF resultante.

El verify visual (host) llama DeepSeek V4 Flash / Pro. OpenRouter está prohibido.
