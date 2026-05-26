# Fase 5 - Validacion de seguridad y licencias

Fecha: 2026-05-01

## Alcance implementado

- Auditoria critica de dependencias de produccion en frontend y backend como hard gate de CI.
- Generacion de SBOM CycloneDX 1.5 para frontend y backend desde `package-lock.json`, sin agregar dependencias nuevas.
- Comando local unico `npm run security:validate` para reproducir auditoria critica, licencia, drift de `THIRD_PARTY_LICENSES.md` y SBOM.
- Artefactos GitHub Actions `supply-chain-sbom` con `frontend.cdx.json` y `backend.cdx.json`.
- Gate final `CI · required checks passed` ahora depende tambien de `security-audit`.

## Politica aplicada

- Bloquea `critical` en `npm audit --omit=dev --audit-level=critical`.
- Mantiene GPL/AGPL/LGPL/CDDL/EPL/MPL-1.1/NPOSL fuera del core salvo allowlist documentado en `scripts/generate-third-party-licenses.js`.
- Verifica que `THIRD_PARTY_LICENSES.md` no quede desactualizado respecto a los lockfiles.
- Genera SBOM de dependencias de produccion; las devDependencies de tooling no se consideran parte del binario/comercial runtime.

## Como probar localmente

```bash
npm run security:validate
npm run sbom:generate
```

Archivos generados localmente:

```text
artifacts/sbom/frontend.cdx.json
artifacts/sbom/backend.cdx.json
```

`artifacts/` esta ignorado por Git; los SBOM se publican como artefactos de CI, no como archivos versionados.

## Validacion antes de produccion

```bash
npm run licenses:check
npm run licenses:report
npm audit --omit=dev --audit-level=critical
cd backend && npm audit --omit=dev --audit-level=critical
```

En GitHub Actions deben quedar en verde:

- `Security · npm audit + SBOM`
- `Licenses · third-party audit`
- `Frontend · build`
- `Backend · prisma + boot smoke test`
- `CI · required checks passed`

## Riesgos residuales

- `npm audit` sigue reportando advisories high/moderate existentes en `next`, `nodemailer` y transitivos de `uuid`. Se documentan como deuda de upgrade porque las rutas sugeridas implican cambios mayores o saltos de framework.
- El job e2e continua informativo a nivel branch protection hasta cumplir cinco corridas verdes consecutivas durante al menos tres dias.
- La politica SBOM cubre lockfiles npm; si se agregan runtimes no npm, deben sumarse a esta fase antes de produccion.
