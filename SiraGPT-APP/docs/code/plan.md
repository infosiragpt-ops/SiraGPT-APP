# plan.md — Mejora del módulo `/code`: generador de Landing Pages (Vite 7 + React 18 + TS)

**Objetivo:** que el generador del módulo `/code` produzca una Landing Page
profesional como **proyecto Vite 7 + React 18 + TypeScript real** con la
estructura de artifacts, el stack y el componente "Invitar al proyecto" definidos
en el [prompt](./landing-generator-prompt.md).

**Prompt fuente:** [`landing-generator-prompt.md`](./landing-generator-prompt.md)

**Regla de trabajo:** cada tarea mantiene CI verde (`npm run lint`,
`npx tsc --noEmit --skipLibCheck`, `npm test` cuando aplique). Cambios viven en
`lib/`, `components/code/`, `scripts/` y prompts (no rediseñar UI existente).

---

## Resumen de fases

| Fase | Nombre | Tareas |
|---|---|---|
| 0 | Diseño y contrato | T1 |
| 1 | Prompts del generador | T2, T3 |
| 2 | Scaffold determinista (fallback sin LLM) | T4, T5, T6, T7 |
| 3 | Componente "Invitar al proyecto" | T8 |
| 4 | Animaciones y responsive | T9 |
| 5 | Runner + preview | T10, T11 |
| 6 | Tests, verificación y docs | T12, T13, T14 |

---

## Fase 0 — Diseño y contrato

### T1 · Definir el contrato de salida y el `AgentGoal`
- **Objetivo:** decidir si el target Vite‑React‑TS reemplaza a `goal: "app"` o se
  agrega un `goal: "landing-react"` nuevo, y congelar la estructura de archivos
  exacta (src/App.tsx, src/main.tsx, src/index.css, index.html, vite.config.ts,
  package.json, public/).
- **Archivos:** [`lib/code-agent/types.ts`](../../lib/code-agent/types.ts) (`AgentGoal`, `AgentBuildContext`).
- **Decisión recomendada:** reutilizar `goal: "app"` para landings React (ya
  enruta al motor multi‑archivo + ▶ Ejecutar) y diferenciar landing‑vs‑app por el
  `productType`/secciones, evitando una rama nueva.
- **Aceptación:** documento de 1 párrafo en este plan marcando la decisión; tipos
  actualizados si se añade un goal.

---

## Fase 1 — Prompts del generador

### T2 · Reescribir `landingSystemPrompt(ctx)`
- **Objetivo:** que el prompt mande el output Vite7+React18+TS con la estructura,
  stack, fuentes (Syne/Space Grotesk), Framer Motion + `useInView`, Lucide, CSS
  custom properties y coherencia de nicho del prompt fuente.
- **Archivos:** [`lib/code-agent/prompts.ts`](../../lib/code-agent/prompts.ts) (L12‑83).
- **Aceptación:** el string generado incluye la lista exacta de archivos, las deps
  obligatorias y el bloque "Invitar al proyecto"; `tsc` y `lint` verdes.

### T3 · Actualizar la inyección de "app" en `runEngine`
- **Objetivo:** sustituir la instrucción `.jsx` multi‑componente por el contrato
  `.tsx` (src/App.tsx único + src/main.tsx + src/index.css + index.html +
  vite.config.ts + package.json con vite7/react18/framer‑motion/lucide‑react).
- **Archivos:** [`components/code/ai-code-chat-panel.tsx`](../../components/code/ai-code-chat-panel.tsx) (~L697‑702, rama `ctx.goal === "app"`).
- **Aceptación:** al generar un "app/landing", el motor escribe esos archivos con
  esas extensiones y dependencias.

---

## Fase 2 — Scaffold determinista (fallback sin LLM)

> Garantiza un proyecto válido aunque el LLM no esté disponible (Cerebras/OpenRouter
> sin key) o falle, reusando el patrón de fallback determinista existente.

### T4 · `package.json` + `vite.config.ts` base
- **Objetivo:** plantilla determinista con React 18, Vite 7, `@vitejs/plugin-react`,
  TypeScript, Tailwind/postcss/autoprefixer, framer‑motion, lucide‑react; scripts
  `dev`/`build`/`preview`.
- **Archivos:** nuevo helper en `lib/code-agent/` (p.ej. `vite-scaffold.ts`) o
  extender [`backend/src/services/builder/codegen.js`](../../backend/src/services/builder/codegen.js).
- **Aceptación:** `bun install && vite` levanta el dev server sin errores.

### T5 · `index.html` + `src/main.tsx`
- **Objetivo:** `index.html` con `<div id="root">` y `<script type="module"
  src="/src/main.tsx">`; `main.tsx` con `createRoot` e import de `index.css`.
- **Archivos:** mismo helper de T4.
- **Aceptación:** árbol React monta `<App/>` en el preview.

### T6 · `src/index.css` — tokens + Tailwind
- **Objetivo:** `:root` con CSS custom properties de paleta (`--bg`, `--fg`,
  `--accent`, `--muted`…), capas base de Tailwind, y `--font-display`/`--font-body`.
- **Decisión:** Tailwind por PostCSS (recomendado para Vite) **o** CDN; documentar
  la elegida. Si PostCSS: añadir `tailwind.config.js` + `postcss.config.js`.
- **Aceptación:** clases Tailwind aplican y las vars CSS se reflejan en el render.

### T7 · Fuentes Syne + Space Grotesk
- **Objetivo:** `@import` de Google Fonts en `index.css` (o `<link>` en index.html)
  y mapeo `--font-display: 'Syne'` / `--font-body: 'Space Grotesk'`.
- **Archivos:** `src/index.css` / `index.html`.
- **Aceptación:** titulares en Syne, cuerpo en Space Grotesk, visibles en preview.

---

## Fase 3 — Componente "Invitar al proyecto"

### T8 · Plantilla del componente de invitación
- **Objetivo:** bloque obligatorio dentro de `src/App.tsx` con: botón «Invitar»
  (Lucide), panel/modal con enlace privado (input readOnly), subtexto exacto
  «Cualquier persona con el enlace tendrá acceso de edición», botón Copiar
  (clipboard + feedback «¡Copiado!»), e input + botón «Invitar por correo
  electrónico» (validación de formato, sin llamada real). Apertura animada con
  Framer Motion (`AnimatePresence`).
- **Archivos:** especificación en el prompt (T2/T3) + ejemplo de referencia en
  este repo (`docs/code/` opcional).
- **Aceptación:** el componente aparece en cada landing generada, copia el enlace
  y valida el email en memoria.

---

## Fase 4 — Animaciones y responsive

### T9 · Animaciones por scroll + responsive móvil‑primero
- **Objetivo:** cada sección entra con Framer Motion `useInView`/`whileInView`
  (`viewport={{ once: true }}`), con fades + translate + stagger; layout
  móvil‑primero con `sm`/`md`/`lg`.
- **Archivos:** contrato en el prompt (T2/T3); verificación manual en preview.
- **Aceptación:** al hacer scroll las secciones animan una vez; el layout se adapta
  a móvil/tablet/desktop.

---

## Fase 5 — Runner + preview

### T10 · Verificar el runner con Vite 7 + deps nuevas
- **Objetivo:** confirmar que [`scripts/code-runner.js`](../../scripts/code-runner.js)
  hace `bun install` (instala framer‑motion/lucide‑react) y corre `vite --host
  0.0.0.0 --port 5173`; ajustar detección de framework si hace falta.
- **Aceptación:** ▶ Ejecutar levanta el dev server y el iframe muestra la landing.

### T11 · Preview ▶ Ejecutar
- **Objetivo:** confirmar que [`components/code/preview-pane.tsx`](../../components/code/preview-pane.tsx)
  detecta `package.json` (`hasNodeProject`) y muestra/lanza ▶ Ejecutar contra
  `:5173`.
- **Aceptación:** botón visible y funcional con el proyecto generado.

---

## Fase 6 — Tests, verificación y docs

### T12 · Tests del scaffold/prompt
- **Objetivo:** test que verifique que el scaffold determinista emite los archivos
  obligatorios (src/App.tsx, src/index.css, vite.config.ts, package.json con vite7
  + framer‑motion + lucide‑react) y que el prompt contiene el bloque "Invitar".
- **Archivos:** `backend/tests/` o `tests/` según dónde viva el scaffold; registrar
  en el `test` script correspondiente.
- **Aceptación:** `npm test` verde con los casos nuevos.

### T13 · Verificación end‑to‑end manual
- **Objetivo:** en http://localhost:3000/code, modo App, pedir una landing (p.ej.
  «landing para una cafetería de especialidad»), generar, ▶ Ejecutar y revisar:
  estructura de archivos, fuentes, animaciones scroll, responsive y "Invitar".
- **Aceptación:** checklist del prompt cumplido en el preview real.

### T14 · Documentación
- **Objetivo:** actualizar [`CLAUDE.md`](../../CLAUDE.md) (sección del builder/`/code`)
  con el nuevo contrato de salida y enlazar este plan + el prompt.
- **Aceptación:** docs reflejan el comportamiento nuevo.

---

## Criterios de aceptación globales
1. Una landing generada produce EXACTAMENTE la estructura artifacts (src/App.tsx,
   src/main.tsx, src/index.css, index.html, vite.config.ts, package.json, public/).
2. Stack: React 18 + TS, Vite 7, Tailwind + CSS vars, Framer Motion, Lucide React,
   Syne + Space Grotesk.
3. SPA sin router, 100% estática, animaciones scroll con `useInView`, responsive
   móvil‑primero.
4. Componente "Invitar al proyecto" presente y funcional (copiar enlace + invitar
   por email, en memoria).
5. ▶ Ejecutar levanta el dev server y muestra la landing en el preview.
6. `lint` + `tsc` + `test` verdes.

## Decisiones tomadas (2026-06-11 — implementado ✅)
- **T1 · Goals**: AMBOS goals (`landing` y `app`) emiten el contrato Vite 7 +
  React 18 + TS; sin goal nuevo. Landing = `src/App.tsx` único; app puede usar
  `src/components/*.tsx` (≤6). El delta vive dentro de `landingSystemPrompt`.
- **T6 · Tailwind**: **v4 vía `@tailwindcss/vite`** (NO PostCSS, NO CDN): cero
  archivos de config (`@import "tailwindcss"` en `src/index.css` + `@theme
  inline` mapeando la paleta de `:root`). Esto SUPERSEDE la recomendación
  PostCSS original y el `tailwindcss ^3 + postcss + autoprefixer` del prompt
  fuente. El prompt prohíbe explícitamente la sintaxis v3.
- **Contrato de archivos**: lista del prompt + **`tsconfig.json`** (proyecto TS
  real). Fuente de verdad: `VITE_LANDING_CONTRACT_PATHS` en
  [`lib/code-agent/vite-scaffold.ts`](../../lib/code-agent/vite-scaffold.ts).
- **Fallback determinista (T4-T8)**: `lib/code-agent/vite-scaffold.ts` +
  `vite-app-template.ts` + `escape.ts` — frontend puro, sin red, landing
  completa (hero/features/about/testimonios/CTA/footer + Invitar + Framer
  Motion `useInView`). El goal `app` determinista conserva el backend
  (`/api/builder/generate`, Next.js CRUD) con fallback offline a la landing.
- **Formato streaming**: un bloque fenced por archivo con la ruta SOLO en el
  encabezado (` ```json package.json `); PROHIBIDO `// path:` dentro del
  contenido (parseCodeBlocks no lo quita cuando el header ya trae ruta y
  rompería package.json).
- **Versiones**: fijadas en `VITE_DEPS`/`VITE_DEV_DEPS` (vite ^7.1.0,
  @vitejs/plugin-react ^4.7.0, tailwindcss + @tailwindcss/vite ^4.1.0,
  framer-motion ^11.18.2 — última 11.x, lucide-react ^0.454.0, TS ^5.9.3).

## Riesgos restantes
- Modelos LLM que emiten sintaxis Tailwind v3 pese al bloque CRÍTICO → el
  guard del iterate + SRE cubren la reparación.
- Binarios nativos (oxide/lightningcss) bajo `bun install` en el runner: si
  fallara, fijar parche exacto 4.1.x conocido-bueno o cambiar la imagen del
  runner a node+npm.

### Decisiones originales (histórico, resueltas arriba)
- **Tailwind CDN vs PostCSS** en Vite (T6): CDN es más simple pero menos "real";
  PostCSS es el estándar. Recomendado: PostCSS con `tailwind.config.js`.
- **Versiones exactas** (Vite 7, framer‑motion, lucide‑react): fijar últimas
  estables compatibles con React 18 al implementar T4.
- **`goal` nuevo vs reutilizar `app`** (T1): reutilizar `app` minimiza cambios.
