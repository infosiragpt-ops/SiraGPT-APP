# Evidencia local del corpus complejo (2026-09-05 UTC)

Estado: generadores y controles de **originales sintéticos**, no golden del editor.
Bundle verificado: `/private/tmp/siragpt-complex-final.2iHpHM`.
`manifest.json` registra hashes de los seis archivos y de todas sus partes OOXML.

## Comandos y resultados

Desde `backend`:

```sh
DOC_FIXTURE_PYTHON=/Users/luis/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 node --import tsx tests/fixtures/build.ts /private/tmp/siragpt-complex-final.2iHpHM
```

Salida: `{"version":"phase1-complex-synthetic-v1","files":6,"editorExecuted":false}`.
El warning experimental `localStorage` de Node 26 no afectó la generación.

Desde la raíz:

```sh
DOC_FIXTURE_PYTHON=/Users/luis/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 node --test backend/tests/doc-sandbox-complex.fixture.test.cjs
```

Resultado: **6 tests, 6 pass, 0 fail, 0 skipped**, 857.192583 ms.
Comprueba reproducibilidad de archivos/partes, rechazo de sobrescritura, igualdad
entre zonas UTC/Pacific-Auckland, fechas fijas, alcance completo de candidatos y
rechazo de alteración de bytes antes de usar un corpus.

```sh
env PATH="/Users/luis/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin:$PATH" /Users/luis/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 backend/tests/fixtures/verify-docs.py /private/tmp/siragpt-complex-final.2iHpHM
```

Resultado: **Ran 11 tests in 3.011s — OK**, sin mocks ni skips. Incluye:

- Inspector OOXML real del sandbox en los tres originales Office.
- DOCX: tres runs y propiedades diferentes, dos notas, header/footer/campo PAGE,
  lista, tabla, imagen y cuadro de texto.
- XLSX: dos hojas, dependencias, gráfico nativo, formato condicional, merge y
  shared string usado por A8/A9/A10. Recalculo LibreOffice real de una copia,
  cero errores; totales 2560, 460.8 y 3020.8 concuerdan con las caches del original.
- PPTX: 8 slides, 8 notas, imagen por slide y 2 layouts distintos.
- PDF: pypdf real comprueba fuente embebida, formulario y 2+1 páginas; Poppler
  confirma ausencia de texto en el PDF escaneado, cuya página contiene una imagen.
- LibreOffice/Poppler renderizan 2 páginas de Word, 2 de Excel y 8 de PowerPoint.

Además: `git diff --check` y `node --check` de los tres CJS nuevos, exit 0.
Se inspeccionaron visualmente las 8 diapositivas y las 2 páginas de Word del
bundle previo `LVO578`; después solo cambió metadata/timestamp ZIP, no contenido.
Las vistas están en `/private/tmp/siragpt-complex-fixtures.LVO578/visual`.

## Fallos detectados y corregidos

1. PptxGenJS declaraba masters ausentes en Content_Types; el inspector real
   fallaba `OOXML_CONTENT_TYPES`. Se corrige exclusivamente la generación del
   original, retirando overrides de masters ausentes y no referenciados.
2. openpyxl sobrescribía `modified`; se normaliza después de generar y se añadió
   regresión que exige timestamps fijos (dos construcciones en el mismo segundo
   no bastan para acreditar determinismo).
3. PizZip usa campos horarios locales; se fijan fechas DOS locales y se prueba
   igualdad cruzada UTC/Pacific-Auckland.

## Límites explícitos

No hubo llamadas Anthropic, SSH, producción, datos de usuarios, gVisor ni
validaciones de ediciones del modelo. Los candidatos G1/G4/G7/G8/G11 aún deben
conectarse al runner y ejecutarse con el motor real. G10 forma parte del contrato
de preservación F1 conforme a D15; su candidato tampoco acredita ejecución real.

`qpdf` no existe en el PATH del Mac: los PDF aquí pasan controles pypdf/Poppler,
**no** el gate completo de PDF del sandbox. No se sustituyó `qpdf` por un stub.
El validador XSD adicional de la skill PPTX se intentó y falló porque su runtime
no tiene `defusedxml` (`ModuleNotFoundError`); no se declara ese gate aprobado.
Estos 17 controles locales no son pruebas E2E ni una certificación de fase 1.
