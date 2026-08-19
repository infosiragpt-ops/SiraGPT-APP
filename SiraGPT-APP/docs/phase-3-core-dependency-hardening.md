# Fase 3 - Hardening de dependencias core

Fecha: 2026-05-01

## Alcance implementado

- Eliminacion de `react-syntax-highlighter` y `@types/react-syntax-highlighter`.
- Unificacion de visores de codigo sobre `components/ui/shiki-code-view.tsx`, reutilizando el hook Shiki ya presente.
- Eliminacion de `xlsx` en raiz y backend.
- Migracion de lectura/generacion XLSX confiable a `exceljs@4.4.0`.
- Rechazo de `.xls` binario legacy en upload policy y selector de archivos.
- Regeneracion de `THIRD_PARTY_LICENSES.md`.

## Dependencias validadas

| Dependencia | Version | Licencia | Uso | Decision |
| --- | ---: | --- | --- | --- |
| `exceljs` | `4.4.0` | MIT | Lectura/generacion XLSX Node/browser | Integrada. Sustituye `xlsx` npm para cerrar advisories high sin fix y mantener compatibilidad comercial. |
| `shiki` | `1.29.2` | MIT | Highlighting de codigo TextMate | Reutilizada. Evita mantener `react-syntax-highlighter` y reduce duplicacion de renderizado. |

## Dependencias descartadas

| Dependencia | Motivo |
| --- | --- |
| `xlsx@0.18.5` | Mantiene advisories high sin fix npm; se retira del core. |
| `@e965/xlsx` | Fork/republicacion compatible Apache-2.0, pero con mayor riesgo de supply-chain y menor adopcion que una migracion a ExcelJS. |
| `react-syntax-highlighter` | Arrastra superficie Prism/Refractor innecesaria y duplicaba Shiki, que ya estaba instalado. |
| Python `openpyxl` / `xlsxwriter` en core JS | Alternativas maduras, pero implican runtime Python para flujos que hoy se resuelven en Node/browser. Se mantienen como opcion futura aislada para pipelines batch. |

## Cambios funcionales

- Chat/artifact/document viewers renderizan codigo con Shiki lazy-load y fallback de texto plano.
- Preview XLSX de cliente y backend usa limites de filas/columnas para evitar trabajo no acotado.
- Rutas backend de descarga y engine de artefactos crean workbooks XLSX con ExcelJS.
- `document-intelligence` ya no parsea workbooks con `xlsx`; consume la extraccion estructurada generada por el pipeline seguro.
- `.xls` no se acepta como upload nuevo. Los iconos/heuristicas de mensajes pueden seguir reconociendo adjuntos historicos, pero el core comercial no procesa nuevas cargas `.xls`.

## Riesgo residual

- El sandbox de artefactos interactivos mantiene SheetJS por CDN dentro de un iframe `sandbox="allow-scripts"` sin `allow-same-origin`. No es dependencia npm del core; debe migrarse a un bundle controlado o retirarse en una fase posterior.
- `next@14.2.35` conserva advisories high no criticos; requiere fase mayor Next 15/16.
- `uuid` aparece como advisory moderate por transitivos. No se fuerza override porque podria romper paquetes de agentes/documentos.

## Como probar

Local:

```bash
npm run licenses:check
npm run lint -- --max-warnings 97
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run build
npm test

cd backend
npm run test:security-documents
node --test tests/upload-security-policy.test.js tests/preview-html-sanitizer.test.js tests/mime-type-validator.test.js tests/file-processing-status.test.js tests/document-delivery-policy.test.js tests/xlsx-workbook-validator.test.js tests/sira-stack-extras.test.js
```

Seguridad:

```bash
npm audit --omit=dev --audit-level=critical
cd backend && npm audit --omit=dev --audit-level=critical
```

Smoke manual:

```bash
npm run dev -- -H 127.0.0.1 -p 3000
open http://127.0.0.1:3000/chat
```

Casos a verificar:

- Subir `.xlsx` pequeno y confirmar preview.
- Intentar subir `.xls` y confirmar rechazo antes de procesamiento.
- Pedir una tabla y descargar Excel desde backend; si falla backend, confirmar fallback frontend.
- Renderizar bloques de codigo, JSON y artefactos con Shiki.
