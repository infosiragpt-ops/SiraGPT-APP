# Módulo `/code` — IDE de SiraGPT + Builder determinista

> Referencia técnica del módulo **`/code`**: qué es, cómo funciona por dentro, y la
> integración del **builder determinista** (botón **⚡ Construir**) añadida en la rama
> `feat/builder-e1-intake`.
> URL local: **http://localhost:3000/code**

---

## Tabla de contenidos
1. [Qué es `/code`](#1-qué-es-code)
2. [Layout: los paneles del IDE](#2-layout-los-paneles-del-ide)
3. [Arquitectura interna](#3-arquitectura-interna)
   - [3.1 Modelo de archivos + persistencia](#31-modelo-de-archivos--persistencia)
   - [3.2 API del workspace (contexto)](#32-api-del-workspace-contexto)
   - [3.3 El chat de código](#33-el-chat-de-código)
   - [3.4 El preview en vivo](#34-el-preview-en-vivo)
   - [3.5 Bus de eventos](#35-bus-de-eventos)
4. [Lo nuevo: builder determinista (⚡ Construir)](#4-lo-nuevo-builder-determinista--construir)
5. [El motor de generación (backend) en detalle](#5-el-motor-de-generación-backend-en-detalle)
6. [Cómo correrlo en dev local](#6-cómo-correrlo-en-dev-local)
7. [Verificación y tests](#7-verificación-y-tests)
8. [Solución de problemas](#8-solución-de-problemas)
9. [Archivos tocados / creados](#9-archivos-tocados--creados)

---

## 1. Qué es `/code`

Es un **IDE estilo Cursor/Replit dentro de SiraGPT**: un workspace de código en el
navegador con **chat de IA, árbol de archivos, editor Monaco, preview en vivo y
terminal**. Todo el estado de archivos vive en `localStorage` (no necesita servidor de
archivos), por lo que es instantáneo y cada carpeta/proyecto es independiente.

- Página: [app/code/page.tsx](../app/code/page.tsx) → monta el shell
  [components/code/code-workspace.tsx](../components/code/code-workspace.tsx).
- Proveedor de estado: [lib/code-workspace-context.tsx](../lib/code-workspace-context.tsx).

> ⚠️ **`/codex` es otra cosa** (monitor de GitHub Actions / inteligencia de repos), **no**
> el IDE. El IDE es **`/code`**.

**Filosofía de diseño** (de los comentarios del propio código):
- El proveedor `CodeWorkspaceProvider` es la **única fuente de verdad**. Los componentes
  (árbol, editor, chat, paleta de comandos) hablan con el proveedor, **nunca entre sí** →
  el workspace es componible.
- **Sin llamadas de red en el contexto**: el streaming del chat vive en el propio panel de
  chat (para que la cancelación coincida con el ciclo de vida del panel).

---

## 2. Layout: los paneles del IDE

```
┌───────────────────────────────────────────────────────────────────────┐
│  workspace-top-bar   (carpeta activa · breadcrumb · acciones)           │
├──────────┬───────────────────────────────────┬───────────────┬─────────┤
│          │  file-tree-panel │   editor-panel  │               │ codex-  │
│ activity │   (árbol de      │  (Monaco +      │ preview-pane  │ folders │
│  -bar    │    archivos)     │   pestañas)     │  (iframe en   │ sidebar │
│ (iconos) │                  ├─────────────────┤   vivo,       │ (carpe- │
│          │                  │ terminal-panel  │   opcional)   │  tas /  │
│          │                  │                 │               │ proyec- │
│          │ ── ai-code-chat-panel (chat IA, columna izquierda) ──        │ tos)   │
└──────────┴───────────────────────────────────┴───────────────┴─────────┘
                                status-bar
```

El shell ([code-workspace.tsx](../components/code/code-workspace.tsx)) usa un
`ResizablePanelGroup` horizontal y decide qué paneles se muestran (el preview es
colapsable; se abre solo cuando hay algo que previsualizar).

| Componente ([components/code/](../components/code/)) | Rol |
|---|---|
| `code-workspace.tsx` | Shell: paneles redimensionables, decide visibilidad |
| `ai-code-chat-panel.tsx` | **Chat de código**: envía al LLM, parsea bloques, aplica al workspace. Aquí vive el botón **⚡ Construir** |
| `file-tree-panel.tsx` | Árbol de archivos del workspace |
| `editor-panel.tsx` / `monaco-code-area.tsx` | Editor Monaco con pestañas |
| `preview-pane.tsx` | **Preview en vivo** (`<iframe srcDoc>`, auto-refresh ~400 ms) |
| `terminal-panel.tsx` | Terminal del workspace |
| `diff-view.tsx` | Render de diffs al aplicar bloques de código |
| `codex-folders-sidebar.tsx` | Carpetas/proyectos (scope vía `?folder=<id>`) |
| `activity-bar.tsx`, `status-bar.tsx`, `workspace-top-bar.tsx` | Cromo del IDE |

---

## 3. Arquitectura interna

### 3.1 Modelo de archivos + persistencia

Forma de archivo ([lib/code-workspace-utils.ts](../lib/code-workspace-utils.ts)):

```ts
type CodeFile  = { path: string; language: string; content: string; updatedAt: number }
type CodeFiles = Record<string, CodeFile>   // indexado por path
```

**Persistencia en `localStorage`** (con namespacing por carpeta para no pisar proyectos):

| Clave | Contenido |
|---|---|
| `code-workspace:v1` | Bucket **global** (sesiones sin carpeta seleccionada) |
| `code-workspace:v1:<folderId>` | Archivos + pestañas abiertas + archivo activo, **por carpeta** |
| `code-workspace:active-folder` | Metadatos de la carpeta activa (`ActiveFolder`) |

El estado persistido por bucket es `{ files, openTabs, activePath }`. La clave versionada
(`v1`) permite evolucionar el esquema sin romper a usuarios existentes.

**Fuentes de workspace** (`WorkspaceSource.kind`):
- `starter` — proyecto de arranque por defecto.
- `browser` — archivos en memoria del navegador.
- `local-folder` — carpeta real del disco vía **File System Access API** (el navegador
  pide permiso; los cambios se guardan de vuelta al disco con `saveFileToWorkspace`).

**Chats de código paralelos**: para un mismo workspace (mismos archivos) puede haber
varios hilos de chat independientes (`CodeChatSession[]`), gestionados en
[lib/code-chat-sessions.ts](../lib/code-chat-sessions.ts). Útil para trabajar en
paralelo sin mezclar conversaciones.

### 3.2 API del workspace (contexto)

`useCodeWorkspace()` ([lib/code-workspace-context.tsx](../lib/code-workspace-context.tsx))
expone una API estable. Las más relevantes para **escribir archivos
programáticamente** (lo que usa el botón Construir):

| Método | Firma | Qué hace |
|---|---|---|
| `openFile` | `(path, content?) => void` | Abre o crea un archivo y activa su pestaña |
| `createFile` | `(path, content?) => void` | Crea archivo + abre pestaña |
| `updateFile` | `(path, content) => void` | Actualiza contenido (no-op si es igual) |
| `applyBlock` | `(path, content) => string` | **Crea/sobreescribe, abre pestaña y dispara el preview** (`siragpt:code-open-preview`). Devuelve el path resuelto |
| `renameFile` / `deleteFile` | `(...) => void` | Renombrar / borrar |
| `resetWorkspace` | `() => void` | Vuelve al proyecto starter |
| `saveFileToWorkspace` | `(path?) => Promise<bool>` | Persiste al folder local enlazado (o a localStorage) |
| `focusChat` / `openCommandPalette` | `() => void` | Buses imperativos (sin prop-drilling) |

Estado expuesto: `files`, `openTabs`, `activePath`, `activeFolder`, `codeChatSessions`,
`activeCodeChatSession`, `workspaceSource`, etc.

### 3.3 El chat de código

[ai-code-chat-panel.tsx](../components/code/ai-code-chat-panel.tsx):

1. **Envía el prompt** al stream de IA (`apiClient.generateAIStream`) con `disableAgentic:true`
   (usa un stream LLM plano, no el loop agéntico que hacía timeout en prompts de "construye
   una app").
2. **Contexto del workspace**: antepone (opcional, toggle "Incluir contexto") la lista de
   archivos + el archivo activo + instrucciones de la carpeta.
3. **Modos del composer** (`ComposerMode`): **App · Build · Plan · Debug · Ask · Image**.
   Cada modo inyecta una instrucción de sistema distinta.
4. **Compuerta de intake determinista (modo App)**: ante una petición de "construir desde
   cero", la app **misma** responde con preguntas de contexto (sin llamar al LLM) y espera;
   solo genera cuando el usuario ya respondió o dice "genera ya". Esto garantiza el flujo
   "preguntas primero, construir después" estilo Replit.
5. **Aplicación de bloques**: parsea bloques ` ```lang ruta ` (`parseCodeBlocks`). En modo
   **App** los aplica automáticamente con `applyBlock` y abre el preview; en otros modos el
   usuario revisa y pulsa **Aplicar** (con vista de diff y copiar).

### 3.4 El preview en vivo

[preview-pane.tsx](../components/code/preview-pane.tsx) +
[lib/code-preview-build.ts](../lib/code-preview-build.ts):

- Construye **un único documento HTML** a partir de los archivos del workspace y lo mete en
  `<iframe srcDoc=… sandbox="allow-scripts …">`.
- **Detecta el "kind"** según el archivo activo:
  - **`html`** → sirve el `index.html` tal cual. Inlinea `<link>`/`<script>` **locales**;
    los CDN externos (`https://…`, `//…`) se **respetan intactos** (clave para apps con React
    por CDN). Inyecta un **puente de consola** en `<head>`.
  - **`react`** → transpila JSX/TSX con **Babel standalone**. Globales ya cargados: React 18,
    Recharts, d3, lucide, framer-motion + Tailwind. (Sin bundler → no se usan imports npm.)
  - **`markdown`** (con `marked`) / **`svg`**.
- **Auto-refresh** con debounce ~400 ms al cambiar archivos.
- **Captura `console.*` y errores** del iframe (vía `postMessage`) y los muestra; alimenta el
  botón **"Arreglar con IA"**, que precarga el composer con el error.

### 3.5 Bus de eventos

Eventos `window` que desacoplan shell ↔ paneles
([lib/code-workspace-context.tsx](../lib/code-workspace-context.tsx)):

| Evento | Propósito |
|---|---|
| `siragpt:code-open-preview` | Abre/refresca el panel de preview (lo emite `applyBlock`) |
| `siragpt:code-composer-mode` | Cambia el composer a modo "build" y enfoca |
| `siragpt:code-fix-error` | Precarga el composer con un error del preview |
| `siragpt:switch-codex-workspace` | Carga otro workspace (proyecto cloud / carpeta) |
| `siragpt:code-new-code-chat` / `siragpt:code-select-chat-session` | Gestión de chats paralelos |

### Flujo normal (con LLM)

```
usuario escribe idea → chat (modo App) → LLM (stream)
   → bloques ```html index.html``` → applyBlock por archivo
   → preview en vivo
```

---

## 4. Lo nuevo: builder determinista (⚡ Construir)

**Problema:** el flujo anterior depende del LLM (Opus / API keys). Si el modelo falla o no
hay keys, no se construye nada.

**Solución:** un camino **100 % determinista, sin LLM ni keys**, conectado al mismo `/code`.
Usa el **mismo motor** que el estudio `/builder`.

### Flujo nuevo

```
usuario escribe idea → botón ⚡ Construir
   → POST /api/builder/generate          (heurística pura, sin LLM)
   → { brief, blueprint, files }         (index.html ejecutable + proyecto Next.js)
   → applyBlock por archivo (index.html al final)
   → dispara siragpt:code-open-preview
   → preview en vivo corriendo
```

### Frontend

- **[lib/builder/intake-service.ts](../lib/builder/intake-service.ts)** — método
  `generate(prompt)` (+ tipo `GenerateResult`). Cliente tipado con JWT Bearer
  (`localStorage "auth-token"`) y `credentials:include`.
- **[components/code/ai-code-chat-panel.tsx](../components/code/ai-code-chat-panel.tsx)** —
  botón **⚡ Construir** (violeta) en la barra del composer. Handler `buildApp`:
  1. Toma el texto del input como descripción.
  2. `intakeService.generate(text)`.
  3. Ordena los archivos para aplicar **`index.html` al final** (así el preview aterriza en
     la app corriendo, no en un doc).
  4. `applyBlock` por archivo → dispara `siragpt:code-open-preview`.
  5. Resume en el chat (plataforma · entidades · stack).
  - **Funciona aunque el chat LLM falle.** Solo requiere sesión iniciada + un agente de
    código activo (se crea en `localStorage`).

---

## 5. El motor de generación (backend) en detalle

Todo en [backend/src/services/builder/](../backend/src/services/builder/). **Puro y
determinista**: el mismo prompt produce siempre el mismo resultado (sin red, sin LLM).

### 5.1 `brief-from-prompt.js` *(nuevo)* — texto libre → `ProjectBrief`

[backend/src/services/builder/brief-from-prompt.js](../backend/src/services/builder/brief-from-prompt.js)

- **Entidades** (`extractEntities`): busca marcadores "con X y Y" / "para gestionar…" /
  "entidades:", recorta en el primer límite de cláusula, separa por `,` / `y` / `e` / `/`,
  filtra stopwords, **singulariza** (`clientes`→`cliente`) y **capitaliza**
  (`clientes y turnos` → `Cliente`, `Turno`). Máx. 6 entidades.
- **Campos por defecto** (`fieldsForEntity`, diccionario de dominio) — para que los
  formularios de la app en vivo tengan inputs reales:
  | Entidad (singular contiene) | Campos |
  |---|---|
  | cliente / customer / lead | nombre, email, telefono |
  | usuario / member | nombre, email |
  | turno / cita / reserva / evento | fecha, hora, cliente |
  | producto / articulo / plato | nombre, precio, stock |
  | servicio / corte / tratamiento | nombre, precio, duracion |
  | pedido / orden / venta / compra | cliente, fecha, total |
  | empleado / barbero / staff | nombre, rol |
  | factura / recibo / pago | numero, fecha, total |
  | tarea / ticket | titulo, estado |
  | (cualquier otra) | **nombre, descripcion** |
- **Plataforma** (`normalisePlatform`): escritorio/electron→`desktop`, one-page→`landing`,
  app/móvil→`mobile`, default **`web`**.
- **Tema**: oscuro / minimalista / corporativo / colorido / **moderno** (default).
- **Features**: auth / pagos / dashboard / búsqueda / notificaciones / chat
  (mapeo de keywords; default "Gestión de registros").
- **Fallback seguro**: si no se detecta ninguna entidad y la plataforma no es `landing`,
  siembra una entidad `Registro` (nombre, descripcion) → **nunca una app vacía**.

### 5.2 `POST /api/builder/generate` *(nuevo)*

[backend/src/routes/builder.js](../backend/src/routes/builder.js)

```
body: { prompt }  →  { brief, blueprint, files }
```
- Deriva el brief con `briefFromPrompt` y lo pasa por `scaffoldFromBrief`.
- Auth: `authenticateToken`. Con **Bearer token la CSRF no aplica** (el navegador no manda
  Authorization cross-origin automáticamente), así que el botón funciona sin fricción.
- Errores: `400 validation_failed` (prompt vacío) / `400 generate_failed`.

### 5.3 El scaffold reutilizado (ya existía)

`scaffoldFromBrief` ([scaffold.js](../backend/src/services/builder/scaffold.js)) ensambla:

- **`index.html`** — vía [`live-app.js`](../backend/src/services/builder/live-app.js):
  una **SPA ejecutable de un solo archivo** (React 18 por CDN + Tailwind), con navegación
  real y **CRUD por entidad en `localStorage`**. Los datos del brief viajan como **JSON en
  `window.__APP__`** (nunca interpolados en código ejecutable) y el `<` se escapa → **seguro
  ante inyección**. Corre tal cual en el preview (es la "entry" preferida).
- **Proyecto Next.js 14 real** — vía [`codegen.js`](../backend/src/services/builder/codegen.js)
  (solo plataformas web/landing): `package.json`, `tsconfig.json`, `next.config.mjs`,
  `app/layout.tsx`, `app/page.tsx` (hero+features), `components/site-nav.tsx`, y por entidad
  `app/api/<slug>/route.ts` (CRUD en memoria) + `app/<slug>/page.tsx` (lista/alta). Corre con
  `npm install && npm run dev` **sin DB**.
- **`prisma/schema.prisma`** (si hay entidades y DB), **README.md**, **.env.example**,
  **preview.html** (mockup estático temado).

```
brief-from-prompt.js → scaffold.js ─┬─ live-app.js   → index.html (ejecutable)
                                     ├─ codegen.js    → proyecto Next.js real
                                     ├─ blueprint.js  → plan (stack/pages/dataModel)
                                     └─ preview.js    → preview.html (mockup)
```

---

## 6. Cómo correrlo en dev local

> El stack también corre vía Docker (`npm run docker:up`). Lo siguiente es para **dev local**
> con hot-reload, que fue como se verificó esta feature.

**Prerrequisitos resueltos en este entorno (Windows):**
- **Node**: nvm-windows tenía Node v24.16.0 pero sin symlink activo (falla por el espacio en
  `C:\Users\PSS 5to piso`). Se creó el junction `C:\nvm4w\nodejs` → la versión instalada, así
  `node`/`npm` resuelven en cualquier terminal.
- **Dependencias**: `npm install` en la raíz (frontend) + `backend/node_modules` ya presente.
- **Prisma**: `npx prisma generate` en `backend/`.
- **Base de datos**: la base `siragpt` solo vivía dentro de Docker. Se **clonó** a la
  PostgreSQL de Windows (`pg_dump` desde el contenedor → `pg_restore` en local). Las features
  pgvector/RAG no corren en local (Windows pg no tiene la extensión) — irrelevante para el
  builder. `backend/.env` → `PRISMA_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/siragpt`.
- **Puertos**: se detuvieron los contenedores Docker `frontend`+`backend` para liberar
  3000/5000; se dejó **redis** (Docker, 6379) para el backend de dev.

**Arranque:**
```powershell
# Backend (puerto 5000, nodemon)
cd backend ; npm run dev

# Frontend (puerto 3000, Next dev)  — en otra terminal
npm run dev
```
- Frontend: http://localhost:3000  ·  Backend: http://localhost:5000
- Health: http://localhost:5000/health

**Volver a Docker (prod-like):** primero detén el dev (libera 5000/3000), luego
`docker start siragpt-frontend-1 siragpt-backend-1` (o `npm run docker:up`).

**Probar el botón:**
1. http://localhost:3000 → regístrate/inicia sesión.
2. Ve a **`/code`**.
3. Escribe en el chat: `Sistema de barbería con clientes y turnos`.
4. Click **⚡ Construir** (junto al selector de modelo).
5. Los archivos se escriben al workspace y la **app corre en el Preview** — sin LLM ni keys.

---

## 7. Verificación y tests

| Check | Resultado |
|---|---|
| Tests del builder | **80/80 verde** (incl. 12 nuevos en `builder-brief-from-prompt.test.js`) |
| TypeScript (`npx tsc --noEmit --skipLibCheck`) | **0 errores** |
| Compilación real de `/code` en Next dev | **OK** (2455 módulos) |
| Smoke-test HTTP real (csrf → registro → `/generate`) | **HTTP 200** |

Resultado del smoke-test end-to-end con `"Sistema de barbería con clientes y turnos"`:
- `brief.platform: web`
- `entities: Cliente, Turno`
- 17 archivos: `prisma/schema.prisma, index.html, preview.html, README.md, .env.example,
  package.json, tsconfig.json, next.config.mjs, app/globals.css, components/site-nav.tsx,
  app/layout.tsx, app/page.tsx, lib/store.ts, app/api/cliente/route.ts, app/cliente/page.tsx,
  app/api/turno/route.ts, app/turno/page.tsx`
- `index.html` ejecutable (doctype + React) ✓

Correr los tests del builder:
```powershell
cd backend
node --test tests/builder-brief-from-prompt.test.js tests/builder-route.test.js `
  tests/builder-live-app.test.js tests/builder-codegen.test.js tests/builder-contracts.test.js `
  tests/builder-intake.test.js tests/builder-preview.test.js tests/builder-llm.test.js `
  tests/builder-question-generator.test.js
```

---

## 8. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Botón Construir da "Inicia sesión…" | No hay JWT | Inicia sesión; el token vive en `localStorage "auth-token"` |
| "Selecciona o crea un agente de código" | No hay `codeChatSession` activa | Crea un chat con el botón **+** del panel |
| `/generate` → 401 | Falta Bearer token | El cliente lo adjunta solo si hay sesión; reloguea |
| Preview en blanco | El kind no es `html`/`react`, o el index.html no es la pestaña activa | Asegúrate que `index.html` sea el archivo activo; el handler ya lo aplica al final |
| App en vivo sin formularios | Entidad sin campos | El generador asigna campos por defecto; si pasó, revisa que el prompt mencione la entidad |
| Backend no arranca (DB auth) | `PRISMA_DATABASE_URL` con credenciales de plantilla | Ponerlas reales (ver §6) |
| `node` no se reconoce | nvm sin symlink activo | Junction `C:\nvm4w\nodejs` → versión instalada (ver §6) |

---

## 9. Archivos tocados / creados

```
NUEVO  backend/src/services/builder/brief-from-prompt.js   ← texto libre → ProjectBrief
NUEVO  backend/tests/builder-brief-from-prompt.test.js     ← 12 tests (módulo + ruta)
EDIT   backend/src/routes/builder.js                       ← POST /api/builder/generate
EDIT   backend/package.json                                ← registra el test nuevo
EDIT   lib/builder/intake-service.ts                       ← método generate(prompt) + GenerateResult
EDIT   components/code/ai-code-chat-panel.tsx              ← botón ⚡ Construir + handler buildApp
LOCAL  backend/.env                                        ← PRISMA_DATABASE_URL local (no se commitea)
```

---

_Generado para la rama `feat/builder-e1-intake`. El builder determinista complementa (no
reemplaza) el chat con LLM: da un camino fiable de construir + previsualizar que funciona
aunque el modelo o las API keys fallen._
