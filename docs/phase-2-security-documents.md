# Fase 2 - Seguridad, CI y documentos

Fecha: 2026-05-01

## Alcance implementado

- CI movido a Node.js 24 para anticipar la retirada de Node.js 20 en GitHub Actions.
- Politica central de subida de archivos en `backend/src/services/upload-security-policy.js`.
- Validacion post-upload de MIME real, extension y tamano antes de extraccion, OCR, RAG o subida a OpenAI Files.
- Sanitizacion server-side de previews HTML generados desde DOCX/XLSX/CSV.
- Sanitizacion client-side de previews HTML renderizados en el panel de documentos.
- Tests backend para politica de uploads y sanitizacion de previews.
- Parches backend de supply chain sin dependencias GPL/AGPL:
  `axios@1.15.2`, `express@4.22.1`, `multer@2.1.1`,
  `prisma/@prisma/client@6.19.3`, `nodemailer@8.0.7`,
  `officeparser@6.1.1`.
- Eliminacion de `html-docx-js`, dependencia no usada que arrastraba
  `jszip` y `lodash.merge` vulnerables sin fix directo.

## Dependencias usadas

No se agregaron dependencias nuevas al core. La fase usa dependencias ya presentes:

| Dependencia | Licencia | Uso | Motivo |
| --- | --- | --- | --- |
| `file-type` | MIT | Deteccion por magic bytes | Ya estaba instalada; evita confiar en MIME declarado por navegador |
| `cheerio` | MIT | Sanitizacion server-side de HTML de preview | Parser HTML mantenido, sin traer `sanitize-html` con advisories recientes |
| `dompurify` | Apache-2.0 / MPL-2.0 dual | Sanitizacion client-side | Ya estaba instalada; perfil HTML controlado en previews |
| `mammoth` | BSD-2-Clause | DOCX a HTML/texto | Ya presente; usado solo con sanitizacion posterior |
| `xlsx` | Apache-2.0 | Preview/lectura de hojas existente | Se mantiene con mitigaciones; sigue pendiente reemplazo por no tener fix npm |
| `officeparser` | MIT | Extraccion PPTX/DOCX legacy | Actualizada a `6.1.1`; API adaptada de `parseOfficeAsync` a `parseOffice(...).toText()` |
| `multer` | MIT | Upload multipart | Actualizada a `2.1.1` para cerrar advisories DoS |
| `nodemailer` | MIT-0 | Email transaccional | Actualizada a `8.0.7`; API `createTransport` validada |

## Variables de entorno

| Variable | Default | Descripcion |
| --- | --- | --- |
| `MAX_FILE_SIZE` | unset | Limite por archivo en MB. Tiene prioridad por compatibilidad con CI actual. |
| `UPLOAD_MAX_FILE_MB` | unset | Alias explicito en MB para despliegues donde `MAX_FILE_SIZE` este reservado. |
| `MAX_UPLOAD_FILES` | `10` | Maximo de archivos por request; tope duro interno de 25. |
| `ALLOW_UNBOUNDED_UPLOADS` | `false` | Si es `true` elimina el limite por archivo. Solo para entornos aislados con cuotas externas. |

Cuando no hay limite configurado, el backend aplica `100 MB` por archivo para evitar agotamiento de disco/memoria.

## Riesgos mitigados

- Archivo renombrado: `.docx` con bytes de PDF ahora se rechaza por `extension_mime_mismatch`.
- Tipo binario no permitido: se rechaza aunque el navegador declare `text/plain`.
- HTML activo en previews: se eliminan `script`, `iframe`, handlers `on*`, `srcdoc`, `javascript:` y CSS con `@import`, `url(...)` o `expression(...)`.
- CI: se elimina la advertencia de deprecacion de Node 20.

## Riesgo residual

- `next@14.2.35`: advisories `high` requieren migracion mayor a Next 15/16 o mitigacion de infraestructura. No se hizo salto mayor en esta fase para evitar ruptura.
- `xlsx@0.18.5`: mantiene advisories sin fix npm. Fase siguiente recomendada: aislar lectura XLSX en backend worker con limites estrictos y migrar generacion/lectura confiable a `exceljs`/Python `openpyxl`.
- `react-syntax-highlighter`: queda como deuda en visores secundarios; chat principal ya usa Shiki y diff2html.
- `uuid` via LangGraph/ExcelJS/node-cron queda como `moderate`; los fixes sugeridos implican downgrades o saltos mayores incompatibles, por eso se documenta para una fase de migracion de agentes.

## Como probar

Local:

```bash
cd backend
npm run test:security-documents
```

Validacion completa:

```bash
npm test
npm run lint -- --max-warnings 97
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run build
npm run licenses:check
```

Produccion:

- Configurar `MAX_FILE_SIZE` o `UPLOAD_MAX_FILE_MB` en MB.
- Mantener `ALLOW_UNBOUNDED_UPLOADS=false` salvo storage aislado.
- Confirmar que GitHub Actions `CI · required checks passed` queda en verde.
