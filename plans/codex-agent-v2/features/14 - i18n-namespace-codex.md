# Feature 14 — i18n del namespace `codex`

**Fase:** F5 · **Depende de:** 10, 11, 12, 13 · **Spec:** `docs/codex-agent-ux.md` §9 (i18n)

## Descripción

Todas las cadenas de la UI Codex V2 (timeline, tarjetas, composer, tabs, diálogos, toasts) bajo el namespace `codex` de next-intl, con **español como fuente** y propagación a los 59 locales de `messages/` siguiendo el patrón existente de `scripts/add-agent-locale-keys.js` (traducciones a mano para los locales principales + fallback EN para el resto).

## Requisitos

1. **Inventario de claves:** auditoría de las features 10–13 — ninguna cadena visible hardcodeada. Grupos mínimos:
   - `codex.timeline.*` (actions count "N acciones", expandir/colapsar, "Scroll to latest", duraciones "(Xs)", estados running/done/error).
   - `codex.plan.*` (título del plan, aprobar y construir, ajustar, esperando aprobación).
   - `codex.checkpoint.*` (título "Checkpoint", "hace X", Rollback here, Changes, View preview, diálogo de confirmación con su advertencia).
   - `codex.summary.*` ("Worked for N minutes" humanizado, Time worked, Work done, Items read, Code changed, Agent Usage, "estimado").
   - `codex.actionRequired.*` ("Acción requerida de su parte", copiar, capacidades bloqueadas, remediar).
   - `codex.composer.*` (placeholder "Make, test, iterate...", Plan, tiers Eco/Estándar/Power con descripciones, dictado, enviar/detener).
   - `codex.tabs.*` (Preview, Agent, Web, Conexiones, Checklist, Archivos) y `codex.errors.*` (toasts).
2. **Script de propagación** (`scripts/add-codex-locale-keys.js`, clon del patrón `add-agent-locale-keys.js`): inserta el namespace en los 59 `messages/*.json`; **idempotente** (segunda corrida no duplica ni pisa traducciones manuales existentes); ~16 locales principales con traducción a mano (los mismos que cubre el namespace `agent`), resto con fallback EN.
3. **Pluralización y números:** "N acciones" / "N minutes" con ICU plurals de next-intl, no concatenación; tiempos relativos ("hace 2 min") con el formateador del repo si existe, o `Intl.RelativeTimeFormat`.
4. **Components limpios:** features 10–13 consumen `useTranslations('codex')`; ninguna clave fuera del namespace (no contaminar `agent`/`thinking`).

## Pasos técnicos

1. Barrido de cadenas en `components/codex/**` y `lib/codex/**` (grep de literales en JSX) → inventario.
2. `messages/es.json` + `messages/en.json` completos a mano (es = fuente, en = base de fallback).
3. Script de propagación + corrida + revisión de diff (solo adiciones).
4. Test (node --test o vitest según el lado): el script es idempotente; `es` y `en` tienen el set completo de claves; un sample de locales contiene el namespace.
5. Sustitución de literales por `t()` en los componentes; verificación visual en es/en.
6. Gates + commits + push.

## Criterios de aceptación

- [ ] `grep` de literales visibles en `components/codex/**` → cero resultados (solo claves i18n).
- [ ] Los 59 locales contienen el namespace `codex`; es/en completos; el script corre dos veces sin cambios en la segunda.
- [ ] Plurales correctos en es/en ("1 acción" / "3 acciones").
- [ ] Cambiar el locale del navegador cambia toda la UI V2 sin claves crudas visibles.
- [ ] vitest/node --test + lint + suite completa verdes.
