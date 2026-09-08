# Corpus complejo sintético (§10.1)

Los originales se construyen mediante `../build.ts`, `../build-docs.cjs` y
`../build-docs.py`. No son documentos de usuarios ni salidas del motor editor.
No se comitean binarios: se generan en un directorio **nuevo y vacío**, fuera de
producción. Cada bundle incluye `manifest.json` con SHA-256 del archivo y de cada
parte OOXML, versión del corpus y `editorExecuted: false`.

Desde `backend` (Node + dependencias del backend, Python con
openpyxl, lxml, Pillow y ReportLab):

```sh
DOC_FIXTURE_PYTHON=/ruta/python3 node --import tsx tests/fixtures/build.ts /ruta/absoluta/nueva
DOC_FIXTURE_PYTHON=/ruta/python3 node --test tests/doc-sandbox-complex.fixture.test.cjs
/ruta/python3 tests/fixtures/verify-docs.py /ruta/absoluta/nueva
```

La verificación documental exige LibreOffice y Poppler reales; no hace skips ni
simula validaciones. Se recalcula una **copia** del XLSX y se contrastan resultados
con valores esperados; jamás se regenera el original de una prueba de edición.
Los bytes son deterministas en las mismas versiones de librerías y fuente;
la regresión también los compara entre UTC y Pacific/Auckland.
`python-build.json` registra el hash de la fuente embebida Bitstream Vera,
distribuida por ReportLab. El diagrama raster se genera localmente con Pillow y
no tiene contenido de terceros ni de clientes.

| Archivo | Estructuras cubiertas |
|---|---|
| `tesis.docx` | 2 páginas, encabezado, pie con campo PAGE, 2 notas al pie, lista numerada, tabla, imagen, cuadro de texto y frase con 3 runs de formato diferente |
| `presupuesto.xlsx` | 2 hojas, dependencias entre hojas, gráfico nativo, formato condicional, combinación de celdas, shared string real usado por 3 celdas |
| `defensa.pptx` | 8 diapositivas, 8 notas, imágenes y 2 layouts de master diferentes |
| `informe.pdf` | 2 páginas, texto con fuente embebida y formulario AcroForm |
| `anexo.pdf` | 1 página de texto para fusión con el informe |
| `escaneado.pdf` | 1 página exclusivamente imagen, sin capa de texto |

`../complex-cases.cjs` define candidatos G1, G4, G7, G8 y G11, además de G10
(aceptación F1 por rechazo y devolución intacta); **no los ejecuta ni certifica**. G8 conserva su alcance completo:
fusión + numeración + marca de agua + formulario. No se reduce a un merge simple.
El motor actual admite `pdf_merge` y `pdf_overlay`; las pruebas del motor deberán
verificar que realmente las usa y preserva el contenido. G1 exige preservar la
propiedad del primer run y las otras partes; no basta un Word plano.

Los casos `SMOKE_*` siguen separados y predeterminados. El runner consume este
corpus solo con `--suite=complex --fixtures-dir=/ruta/absoluta/corpus`; su
oráculo exacto está documentado en `../../doc-sandbox-real.README.md`.
Esta implementación no ha realizado ninguna llamada a Anthropic. Las pruebas
locales del generador/oráculo no acreditan aislamiento
gVisor, cobertura total del módulo, E2E ni goldens pagados. Los documentos reales
anonimizados siguen pendientes de entrega.

`macros.xlsm`, tracked changes y edición interna de PDF pertenecen a F2; no se
crean macros ni se declara satisfecha esa cobertura. Los negativos corrupto,
bomba, slip, falso y grande se construyen en las pruebas de validación existentes;
no se guardan archivos peligrosos en este corpus.

La generación corrige exclusivamente dos defectos de sus propias librerías:
openpyxl reemplaza la fecha de modificación al guardar; PptxGenJS 3.x declara
overrides de masters inexistentes al usar layouts. Se fija la metadata del
original y se eliminan solo esos overrides ausentes y sin referencias. No se
aplica esa normalización a salidas del modelo ni se debilita el validador.
