# Control UI — SiraGPT (scoped)

Este árbol es la Control UI de OpenClaw vendida bajo `ui/upstream/openclaw/`.
No es un segundo chat. El producto canónico es `/agentes`.
Git, prod, F7 y política dura viven en el `AGENTS.md` de la raíz.

## Producto

- MUST: extender el chat canónico de `/agentes`. No reimplementes transcript ni composer en otra superficie React.
- MUST NOT: no revivas `/code`.
- MUST NOT: no cambies layout, composer ni el indicador Pensando salvo pedido explícito de Luis.
- MUST: Pensando = el SVG de 3 barras `#38BDF8` del producto, para todo thinking/tool. Fases = etiquetas en español. Sin iconos distintos por tool.
- MUST: tools scoped a la sesión, no al process env.
- MUST: caché de prompt — no intercambies toolset ni reconstruyas el system a mitad de un chat (salvo compactación).
- MUST: UI lock — si tocas archivos visuales del lock, actualiza hashes; si no, no los toques.

## i18n

- Los bundles no-EN en `ui/src/i18n/locales/*.ts` son output generado.
- MUST NOT: no edites a mano locales no-EN ni `ui/src/i18n/.i18n/*` salvo un fix de output generado pedido de forma explícita.
- Fuente de verdad: `ui/src/i18n/locales/en.ts` más el wiring en:
  - `scripts/control-ui-i18n.ts`
  - `ui/src/i18n/lib/types.ts`
  - `ui/src/i18n/lib/registry.ts`
- Pipeline: cambia strings EN y wiring aquí, luego `pnpm ui:i18n:sync` y commitea bundles regenerados + metadata `.i18n`.
- Informe: `pnpm ui:i18n:report [--surface <name>] [--locale <locale>] [--top <n>]`. No es gate de drift; el gate es `pnpm ui:i18n:check`.
- Si hay drift, regenera. MUST NOT: no traduzcas a mano los locales generados.

## Scope

- MUST: deja git, prod, F7, modelos y turnos triviales en el `AGENTS.md` raíz.
- MUST: este archivo solo cubre Control UI vendida + i18n de este árbol.
