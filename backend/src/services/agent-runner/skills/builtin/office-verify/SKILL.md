---
name: office-verify
description: Verificación programática de entregables Office (pptx/docx/xlsx) antes de declarar éxito.
---

# office-verify — verificar entregables Office de verdad

Objetivo: NUNCA declarar "listo" sin prueba programática de que el archivo en
`/workspace/outputs/` contiene exactamente lo pedido.

## Checklist obligatorio (en orden)

1. **Existencia y estructura**: el archivo está en `/workspace/outputs/` y abre
   como OOXML válido (zipfile lo abre sin error, `[Content_Types].xml` presente).
2. **render_preview**: llama `render_preview` sobre el output. Si reporta que
   soffice no está disponible, se salta HONESTAMENTE y la verificación pasa a
   ser 100% por XML (paso 3) — nunca se omite.
3. **Inspección XML** con `execute_python`:
   - Colores: `office_helpers.xml_has_hex(path, 'RRGGBB')` debe ser True en
     CADA slide afectada (`ppt/slides/slide*.xml`).
   - Texto: `office_helpers.list_slide_texts(path)` (pptx) o leer
     `word/document.xml` (docx) y confirmar que el texto pedido está y que el
     texto que NO debía cambiar sigue intacto.
   - Conteos: número de slides/tablas/filas esperado tras agregar/eliminar.

## Recetas rápidas (python, stdlib + tmp/office_helpers.py)

```python
import sys; sys.path.insert(0, '/workspace/tmp')
import office_helpers as oh
assert oh.xml_has_hex('/workspace/outputs/deck.pptx', 'FFC0CB'), 'color ausente'
print(oh.list_slide_texts('/workspace/outputs/deck.pptx'))
```

```python
import zipfile
with zipfile.ZipFile('/workspace/outputs/doc.docx') as z:
    xml = z.read('word/document.xml').decode('utf8', 'ignore')
assert 'texto esperado' in xml
```

## Reglas

- Si una verificación falla: reintenta la edición (máx. 3) y re-verifica.
- Si sigue fallando: repórtalo con honestidad en español (ver skill
  `spanish-honest-errors`). Jamás afirmes que quedó bien sin evidencia.
