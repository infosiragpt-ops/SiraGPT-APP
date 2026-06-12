# Feature 12 — UI: composer réplica

**Fase:** F5 · **Depende de:** 10 · **Spec:** `docs/codex-agent-ux.md` §2.2

## Descripción

El composer mobile-first del patrón Replit Agent para la vista Codex V2 de `/code`: placeholder **"Make, test, iterate..."**, botón **+** (adjuntos), toggle **Plan**, selector de modo **"Power"** mapeado a tiers del catálogo de modelos, **micrófono** para dictado y botón de envío. Reemplaza al composer actual SOLO en la rama V2 (flag on); el composer existente de `/code` queda intacto.

## Requisitos

1. **Componente** (`components/codex/composer.tsx`): textarea auto-resize (patrón del composer actual de `ai-code-chat-panel.tsx`), placeholder i18n "Make, test, iterate...", envío con Enter (Shift+Enter = salto), botón enviar/detener según corrida activa (detener → `POST /api/codex/runs/:id/cancel`).
2. **Toggle Plan:** estado visible (pill activa). Encendido → toda corrida creada lleva `mode: 'plan'` (nunca build). Apagado → el flujo normal: primera corrida plan, siguientes build tras aprobación (feature 11). Tooltip explicando la diferencia.
3. **Selector "Power"** (`lib/codex/model-tiers.ts`): tres tiers mapeados al catálogo existente (`model-quota-router` / modelos disponibles del contexto de chat):
   - **Eco** → FlashGPT/Cerebras (gratis, `costAppliedUsd` 0),
   - **Estándar** → modelo balanceado del catálogo,
   - **Power** → tier alto.
   El tier viaja en `POST /api/codex/runs { tier }`; el mapeo tier→modelo lo resuelve el backend (feature 06). Mostrar el costo relativo (gratis/$/$$$) en el dropdown.
4. **Micrófono:** dictado con Web Speech API (`webkitSpeechRecognition`/`SpeechRecognition`), idioma del locale activo, transcripción incremental al textarea, estado grabando visible. **Degradación**: si la API no existe (Firefox/builds sin soporte), el botón no se renderiza — sin errores de consola.
5. **Botón +:** adjuntos al contexto de la corrida (archivos → texto vía pipeline existente de uploads, o referencia de archivo del workspace). Alcance mínimo de esta feature: adjuntar archivos de texto que se inyectan al prompt de la corrida; el resto queda para iteración futura (anotado).
6. **Mobile-first:** el composer ancla al fondo del viewport en móvil (safe-area), targets táctiles ≥44px, sin zoom raro de iOS (font-size ≥16px en el textarea).

## Pasos técnicos

1. `model-tiers.ts` puro + tests vitest (mapeo, fallback cuando el catálogo no trae el tier, costo relativo).
2. `composer.tsx` + subcomponentes (`plan-toggle.tsx`, `power-selector.tsx`, `dictation-button.tsx` con feature-detection inyectable para tests).
3. Wiring a `POST /api/codex/runs` con `mode`/`tier` + cancel; tests de los handlers (no del DOM completo): plan toggle fuerza mode, tier viaja, cancel llama al run activo.
4. Estilos mobile-first (Tailwind, breakpoints del repo) + revisión manual en viewport 390px.
5. Gates + commits + push.

## Criterios de aceptación

- [ ] Con el toggle Plan activo, TODA corrida creada es `mode: 'plan'` (verificable en red/tests).
- [ ] El tier seleccionado viaja en la creación de la corrida; Eco marca costo gratis en el selector.
- [ ] Dictado funciona en Chrome/Edge (es-*) y el botón desaparece limpio donde no hay API.
- [ ] Enviar/Detener alternan según corrida activa; Detener cancela la corrida real.
- [ ] En 390px de ancho: composer anclado, sin overflow horizontal, targets ≥44px.
- [ ] El composer actual de `/code` (flag off) no cambia ni un píxel.
- [ ] vitest + tsc + lint + suite completa verdes.
