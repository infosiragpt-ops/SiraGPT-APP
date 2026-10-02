---
name: office-docs
description: Use when creating, editing or REDESIGNING PPT/Word/Excel — claim the format, paint hex, append THEN paint, restyle to -v2, verify, never lie Validado.
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

## 6. Rediseño profesional («más diseño», «más profesional», «mejora el formato»)

Pedido sobre un archivo que YA existe (artefacto previo o adjunto): se
cambia el aspecto, jamás el contenido. Entregable = el MISMO formato con
nombre versionado `<stem>-v2.<ext>` (`-v3` si ya era `-v2`). Nunca un
`.html` de "vista previa", un script `.py` ni un PDF en su lugar.

No es rediseño (va al flujo quirúrgico o de contenido): reescribir,
traducir, resumir o corregir el texto; agregar/quitar láminas, gráficos o
imágenes; un objetivo preciso (columna C, tabla 2, título 3, formato de
moneda); tesis y trabajos académicos (plantilla institucional).

1. **Inventario** — `inspect_document` sobre el original: títulos, textos,
   tablas, gráficos, imágenes, cantidad y orden de diapositivas/páginas/hojas.
2. **Tema** — tokens en `/workspace/tmp/sira_theme.json` (paleta hex sin `#`,
   fuentes display/body, colores de gráfico). Color pedido por el usuario =
   fondo de TODAS las diapositivas; si no, el estilo pedido (oscuro/elegante,
   minimalista, corporativo, cálido) o `aurora`. Los colores de texto se
   eligen por contraste WCAG (≥ 4,5:1 texto, ≥ 3:1 cifras KPI).
3. **Restyle determinista** — primero el helper, luego retoques propios:

```python
import sys, json; sys.path.insert(0, '/workspace/tmp')
import sira_design as sd
r = sd.restyle('uploads/deck.pptx')          # → outputs/deck-v2.pptx
print(json.dumps(r, ensure_ascii=False))     # ok, output, theme, titles, warnings
```

   - `ok: false` (p. ej. `.pptm`/`.docm`/`.xlsm`/`.potx` no soportados) o
     `warnings` no vacío → termina esas partes con tu propio python **sobre
     el mismo** `outputs/<stem>-vN.<ext>`. Un solo entregable: cada arreglo
     sobrescribe ese archivo y vuelves a correr `inspect_document` +
     `verify_visual`.
   - Archivo ya rediseñado por SiraGPT: el helper cambia de tema solo
     (`theme_rotated_from`); en docx/xlsx puedes pasar
     `sd.restyle(src, theme=sd.alternate_theme('<id actual>'))`. Un segundo
     «más diseño» debe verse distinto, nunca una copia idéntica.
   - **PPTX**: fondo del tema en cada slide, barra de acento + regla bajo el
     título (centrada si el título lo está en el layout), fuentes
     display/body, listas cortas → tarjetas con chip numerado, métricas
     («35 %», «$2,4 M») → KPI (una numeración «1.» o un conteo «5
     estrategias» NO es KPI), portada / separadores / cierre oscuros, pie
     «NN / TT», tablas con cabecera de acento, gráficos existentes
     recoloreados con texto legible sobre el fondo. Gráfico nativo nuevo solo
     con datos reales del deck (`pickChartType`: serie temporal → línea,
     partes de un todo → dona, resto → barras). Fondos con imagen o
     transparencia se conservan.
   - **DOCX**: `styles.xml` (Title, Heading 1-3; interlineado de Normal solo si
     no estaba definido), regla de acento bajo el título, tablas con cabecera
     de acento + filas bandeadas + bordes finos, números de página en el pie
     vacío. Fuentes de símbolos, ecuaciones y código se conservan. Tesis /
     trabajos académicos: perfil `academic` (fuentes, interlineado y títulos
     negros intactos; solo tablas y numeración).
   - **XLSX**: cabecera con relleno de acento y texto blanco, fila de título,
     paneles inmovilizados, anchos de columna, formatos numéricos (miles; 2
     decimales solo en columnas con decimales o de montos), bordes finos,
     filas bandeadas, fila Total en negrita, barras de datos en la medida
     principal, ajuste a una página de ancho y un gráfico openpyxl si la hoja
     no tenía (a la derecha de imágenes/gráficos existentes). Valores y
     fórmulas intactos (`values_preserved: true`).
4. **Verificar** — `verify_visual(before=<original>, after=<v2>,
   checklist=[mismo contenido y orden, diseño visiblemente más profesional,
   sin texto desbordado], expect={contains: <todos los títulos>,
   same_page_count: true (pptx) | false (docx, xlsx)})`. En Word y Excel las
   fuentes, el interlineado y el ajuste de página mueven los saltos de página:
   no exijas el mismo número de páginas. Si no es VERIFICADO, corrige solo lo
   fallido (máx. 3).
   `inspect_document` ya reabre los bytes guardados. En XLSX/PPTX devuelve
   el inventario nativo de gráficas (tipo, título, series y referencias): usa
   esos valores con `expect.charts` para verificar. Python queda para requisitos
   adicionales que el inspector no cubra; no reconstruyas el inventario mediante
   atributos internos supuestos. Si una API falla por tipo o atributo, consulta
   su firma/documentación instalada antes de otro cambio. El fallo no valida el
   documento ni autoriza entregarlo.
5. **Respuesta** — en español: qué cambió visualmente, nombre del archivo,
   que el contenido se conservó y si hubo revisión visual.

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
- [ ] Rediseño: mismo formato, `-v2`, títulos y conteo intactos, verify_visual
- [ ] Sin badge Validado si alguna casilla falla
