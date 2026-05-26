# Fase 4 - Pruebas unitarias y e2e

Fecha: 2026-05-01

## Alcance implementado

- Cobertura unitaria del allowlist cliente para adjuntos: `.xlsx` permitido, `.xls` legacy rechazado.
- Cobertura unitaria de generacion Excel frontend con `exceljs`, validando que el Blob producido abre como workbook real.
- Cobertura backend del helper `xlsx-safe-workbook`, incluyendo lectura/escritura y limites de filas/columnas para previews.
- Cobertura Playwright del picker de archivos del chat: cuando el compositor esta montado, acepta `.xlsx` y no anuncia `.xls`; cuando la sesion local cae en login/bootstrap, conserva el smoke sin exigir usuario sembrado.
- Cobertura Playwright de primer render del chat sin `pageerror` y smoke de shell estable en `/chat`.
- CI backend actualizado para ejecutar el nuevo test de helper XLSX.

## Pruebas agregadas

| Archivo | Tipo | Riesgo cubierto |
| --- | --- | --- |
| `tests/attachment-ingest.test.ts` | Unit frontend | Drift entre politica cliente y backend tras retirar `.xls`. |
| `tests/download-excel.test.ts` | Unit frontend | Regresion en fallback de descarga Excel con `exceljs`. |
| `backend/tests/xlsx-safe-workbook.test.js` | Unit backend | Workbook ExcelJS valido y preview acotada. |
| `e2e/chat-upload.spec.ts` | Browser smoke | El chat expone upload moderno cuando el compositor esta disponible y no reintroduce `.xls`. |
| `e2e/chat.spec.ts` | Browser smoke | `/chat` no se rompe cuando el entorno e2e no tiene usuario autenticado. |

## Como probar

Local:

```bash
npm test
npm run test:e2e

cd backend
node --test tests/xlsx-safe-workbook.test.js tests/upload-security-policy.test.js tests/preview-html-sanitizer.test.js tests/xlsx-workbook-validator.test.js
```

Validacion completa antes de merge:

```bash
npm run lint -- --max-warnings 97
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run build
npm run licenses:check
npm audit --omit=dev --audit-level=critical
cd backend && npm audit --omit=dev --audit-level=critical
```

Nota de seguridad: `npm audit --omit=dev --audit-level=critical` pasa en frontend y backend. El arbol actual aun reporta avisos high/moderate existentes en `next`, `nodemailer` y `uuid`; corregirlos requiere una actualizacion mayor de framework/dependencias y debe tratarse como fase separada para no mezclar riesgo de upgrade con hardening de pruebas.

## Criterio de salida

- Todos los tests unitarios y Playwright smoke pasan localmente.
- GitHub Actions queda verde en `frontend`, `backend`, `licenses`, `security-audit`, `e2e` y `CI · required checks passed`.
- El job e2e sigue siendo informativo a nivel branch protection; la promocion a hard gate queda condicionada a cinco corridas verdes consecutivas durante al menos tres dias.
