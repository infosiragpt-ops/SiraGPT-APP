# Feature 13 — UI: barra de tabs mobile-first

**Fase:** F5 · **Depende de:** 10, 11 · **Spec:** `docs/codex-agent-ux.md` §2.3

## Descripción

La navegación inferior del patrón Replit Agent para la vista Codex V2 en móvil: **Preview · Agent · Web · Conexiones · Checklist · Archivos**. En desktop se conserva el layout de paneles redimensionables actual; la barra existe solo bajo el breakpoint móvil.

## Requisitos

1. **Barra** (`components/codex/bottom-tab-bar.tsx`): 6 tabs con ícono + etiqueta i18n, estado activo visible, safe-area inset inferior (iOS), targets ≥44px. Solo se renderiza en viewport móvil (breakpoint `md` del repo) y con flag on.
2. **Mapeo de tabs** (cada una monta contenido existente o de features previas — esta feature NO reimplementa paneles):
   - **Preview** → `preview-pane` actual (iframe del dev server + estados de arranque).
   - **Agent** → chat + `CodexRunTimeline` (feature 10) + composer (feature 12).
   - **Web** → webview a pantalla completa de la `previewUrl` (iframe sin chrome del editor; barra con la URL y abrir-en-pestaña).
   - **Conexiones** → integraciones/MCP reutilizando `components/settings/McpServersCard.tsx` embebida.
   - **Checklist** → tareas del plan aprobado (`plan_proposed.tasks[]`) con estado por corrida: pendiente / en curso (corrida activa) / hecha (heurística: tareas marcadas por el agente en la narrativa de cierre o todas-hechas al `done`; la fidelidad fina queda anotada como iteración futura).
   - **Archivos** → file tree + editor existentes (`code-hub.tsx`).
3. **Estado de tab persistente** por proyecto (querystring o estado del provider): cambiar de tab no desmonta la corrida en vivo (el stream SSE vive en el provider, no en la tab Agent).
4. **Desktop intacto:** ≥ breakpoint, la barra no existe y el layout de `ResizablePanel` actual se mantiene; la vista V2 en desktop organiza chat/preview/archivos en los paneles existentes.
5. **Indicadores:** badge en la tab Agent cuando hay eventos nuevos sin ver (usuario en otra tab durante streaming); badge de error en Preview si el dev server falló.

## Pasos técnicos

1. Provider de navegación (`lib/codex/workspace-tabs.ts`): estado activo, badges, persistencia — puro + tests vitest.
2. `bottom-tab-bar.tsx` + contenedor móvil que monta el contenido por tab (lazy, manteniendo vivo el stream en el provider).
3. Tab Web (`components/codex/web-tab.tsx`) y tab Checklist (`components/codex/checklist-tab.tsx`, consume el item `plan` del reducer).
4. Verificación responsive manual: 390px (móvil) y ≥1024px (desktop sin barra ni regresiones).
5. Gates + commits + push.

## Criterios de aceptación

- [ ] En móvil: las 6 tabs navegan a su contenido correcto; en desktop la barra no existe y el layout actual no cambia.
- [ ] Cambiar de tab durante un build en streaming no corta el stream; volver a Agent muestra el timeline al día con badge consumido.
- [ ] Checklist refleja las tareas del plan aprobado y su progreso grueso.
- [ ] Web muestra la URL viva del sandbox a pantalla completa.
- [ ] Safe-area respetada en iOS (sin tabs debajo del home indicator).
- [ ] Flag off: nada de esto se monta.
- [ ] vitest + tsc + lint + suite completa verdes.
