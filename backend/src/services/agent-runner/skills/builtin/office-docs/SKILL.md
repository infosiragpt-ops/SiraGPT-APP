---
name: office-docs
description: Use when creating or editing PPT/Word — claim the format, paint hex, append slides THEN paint, verify actual>=requested, never lie Validado.
---

# office-docs — PPT y Word sin mentir Validado

## Overview

Entregables Office (pptx/docx) se construyen con las tools nativas y se
verifican de verdad. "Validado" solo si la evidencia programática cierra.
Este playbook no anula `office-verify`: lo especializa para formato,
color y conteo de slides.

## Cuándo usar

- Crear o editar una presentación o un Word.
- Follow-up de color, de "agrega una slide", de "pásalo a Word".

No uses para planillas xlsx disfrazadas de Word, ni para declarar éxito
con el preview todavía oscuro.

## 1. Reclama el formato (claim format)

- Si pidieron **Word / docx / documento**, escribe un `.docx`. Nunca
  entregues `.xlsx` ni `.pptx` marcados Validado.
- Si pidieron **PPT / diapositivas / presentación**, escribe un `.pptx`.
- El nombre y la extensión del artefacto deben coincidir con el pedido.

## 2. Pinta el hex

- Color pedido (nombre o `#RRGGBB`) se pinta de verdad en el OOXML.
- Usa `set_slide_background` / helpers con el hex exacto (sin `#` en XML).
- Tras pintar: `office_helpers.xml_has_hex(path, 'RRGGBB')` debe ser True
  en **cada** slide afectada. Si falta, reintenta (máx. 3), no mientas.

## 3. Append slides THEN paint

Orden obligatorio cuando piden N slides o "agrega una":

1. **Append** — `add_slide` / `append_text_slide` / crear el deck con N
   slides. `set_slide_background` **NO** agrega slides.
2. **Paint** — recién entonces pinta el hex en las slides nuevas (y en
   las que pidieron).
3. **Verify** — cuenta real ≥ pedida.

Nunca pintes un fondo y digas que "ya son 7" si el zip sigue con 6.

## 4. actual >= requested

- Si pidieron 10 slides, `countSlides` debe ser ≥ 10.
- Si pidieron "la 7ª" o "una más", el conteo tiene que subir.
- Si `actual < requested`: NO Validado. Agrega slides y re-verifica.

## 5. Nunca mientas Validado

Validado exige **todas**:

- Archivo en `/workspace/outputs/` y OOXML válido.
- `render_preview` hecho (o skip honesto si no hay soffice) **después**
  de la última edición.
- Hex presente si pidieron color.
- `actual >= requested` en slides / formato correcto (docx vs pptx).
- Texto pedido presente; lo que no debía cambiar sigue intacto.

Si algo falla: reintenta ≤3, luego error honesto en español. Jamás
"listo / Validado" sin evidencia.

## Receta rápida

```python
import sys; sys.path.insert(0, '/workspace/tmp')
import office_helpers as oh
path = '/workspace/outputs/deck.pptx'
assert oh.count_slides(path) >= 10, 'faltan slides'
assert oh.xml_has_hex(path, 'FFC0CB'), 'hex ausente'
print(oh.list_slide_texts(path))
```

## Checklist

- [ ] Extensión = formato pedido
- [ ] Slides appendidas **antes** de pintar
- [ ] Hex en XML de cada slide afectada
- [ ] actual >= requested
- [ ] preview (o skip honesto) post-edición
- [ ] Sin badge Validado si alguna casilla falla
