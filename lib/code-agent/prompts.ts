/**
 * code-agent · system prompts.
 *
 * The role-specific System Prompts the chat agent layers on top of the
 * workspace contract. Only used by the client panel (the deterministic tier
 * does not need them). Kept here so prompt copy lives in one place.
 *
 * The generator contract (Vite 7 + React 18 + TypeScript project, per
 * docs/code/landing-generator-prompt.md + docs/code/plan.md) is transport-
 * neutral: `landingSystemPrompt` carries the contract WITHOUT an output-format
 * section; callers append `streamOutputFormat()` (fenced-blocks streaming) or
 * `engineTransportInstructions()` (OpenCode write/edit tools) per transport.
 * File list + dependency versions are imported from vite-scaffold.ts so the
 * prompt can never drift from the deterministic scaffold.
 */

import type { AgentBuildContext } from "./types"
import { VITE_DEPS, VITE_DEV_DEPS, VITE_LANDING_CONTRACT_PATHS } from "./vite-scaffold"

const CONTRACT_FILES = VITE_LANDING_CONTRACT_PATHS.join(", ")
export const FULL_STACK_APP_CONTRACT_PATHS = [
  "package.json",
  "tsconfig.json",
  "next.config.mjs",
  "docker-compose.yml",
  ".env.example",
  "README.md",
  "prisma/schema.prisma",
  "prisma/seed.ts",
  "app/globals.css",
  "app/layout.tsx",
  "app/page.tsx",
  "lib/db.ts",
] as const
const DEPS_LINE = Object.entries(VITE_DEPS)
  .map(([name, version]) => `${name} ${version}`)
  .join(", ")
const DEV_DEPS_LINE = Object.entries(VITE_DEV_DEPS)
  .map(([name, version]) => `${name} ${version}`)
  .join(", ")

/** Generator role: agency-grade landing/app as a REAL Vite 7 + React 18 + TS project. */
export function landingSystemPrompt(ctx: AgentBuildContext): string {
  const product = ctx.productType || "(no especificado — asume un negocio genérico)"
  const brand = ctx.brand || "(sin nombre — PROPÓN uno corto y memorable)"
  const style = ctx.styleAudience || "moderno y minimalista"
  const isApp = ctx.goal === "app"
  const sections = ctx.sections ? `- Secciones/funciones pedidas: ${ctx.sections}` : null
  const features = ctx.features ? `- Funcionalidades clave: ${ctx.features}` : null
  const colorRef = ctx.colorRef ? `- Color/paleta/referencias: ${ctx.colorRef}` : null
  const data = ctx.dataEntities ? `- Entidades de datos: ${ctx.dataEntities}` : null

  return [
    `[ROL: INGENIERO DE SOFTWARE SENIOR + DIRECTOR DE DISEÑO — estudio premium]`,
    isApp
      ? "Genera el código COMPLETO de una APLICACIÓN FULL-STACK profesional como un PROYECTO Next.js 14 App Router + TypeScript + Prisma + PostgreSQL REAL, ejecutable con ▶ Ejecutar (dev server). NO un único index.html autocontenido y NO una demo en memoria."
      : "Genera el código COMPLETO de una LANDING PAGE profesional como un PROYECTO Vite 7 + React 18 + TypeScript REAL, ejecutable con ▶ Ejecutar (dev server). NO un único index.html autocontenido.",
    "Tu trabajo debe parecer hecho por un estudio de diseño top — NO una plantilla, NO 'AI slop'.",
    "",
    "AUTONOMÍA:",
    "• NO hagas preguntas ni esperes confirmación. Si falta contexto, inventa un brief plausible y coherente con el prompt.",
    "• Diseña internamente un plan extendido (producto, UX, arquitectura, componentes, datos demo, responsive, accesibilidad) y ejecútalo en archivos.",
    "• El resultado final debe funcionar en preview; prioriza entregar una versión completa antes que pedir más datos.",
    "",
    "CONTEXTO CONSOLIDADO (no vuelvas a preguntar):",
    `- Producto/servicio: ${product}`,
    `- Marca: ${brand}`,
    `- Estilo y público: ${style}`,
    sections,
    features,
    colorRef,
    data,
    "",
    "ESTRUCTURA DE ARCHIVOS (EXACTA — rutas relativas a la raíz del workspace):",
    isApp
      ? `  ${FULL_STACK_APP_CONTRACT_PATHS.join(", ")}  (+ app/api/<entidad>/route.ts y app/<entidad>/page.tsx por cada entidad principal)`
      : `  ${CONTRACT_FILES}  (+ public/ SOLO si aplica: favicon/og-image)`,
    isApp
      ? "• Puedes añadir components/*.tsx y lib/*.ts cuando reduzcan complejidad real. Cada entidad debe tener una página frontend y una API route backend."
      : "• TODA la landing vive en src/App.tsx: secciones, animaciones y componentes internos en el MISMO archivo (SPA de un solo árbol). NO crees src/components/.",
    "• Extensiones SIEMPRE .tsx/.ts — PROHIBIDO .jsx/.js. Tipado estricto, sin `any` salvo necesidad real.",
    isApp
      ? "• app/layout.tsx importa app/globals.css. app/page.tsx es el dashboard/home. app/api/<entidad>/route.ts expone GET y POST reales."
      : "• index.html en la raíz: <div id=\"root\"> + <script type=\"module\" src=\"/src/main.tsx\">.",
    isApp ? null : "• src/main.tsx: createRoot(...).render(<App/>) e importa ./index.css.",
    "",
    isApp
      ? "STACK OBLIGATORIO (versiones exactas en package.json):"
      : "STACK OBLIGATORIO (versiones exactas en package.json):",
    isApp
      ? "  dependencies: next 14.2.5, react 18.3.1, react-dom 18.3.1, @prisma/client 5.19.1"
      : `  dependencies: ${DEPS_LINE}`,
    isApp
      ? "  devDependencies: typescript 5.5.4, prisma 5.19.1, tsx 4.19.1, @types/node 20.14.0, @types/react 18.3.3, @types/react-dom 18.3.0"
      : `  devDependencies: ${DEV_DEPS_LINE}`,
    isApp
      ? '  scripts: { "dev": "next dev", "build": "next build", "start": "next start", "db:generate": "prisma generate", "db:migrate": "prisma migrate dev", "db:push": "prisma db push", "db:seed": "tsx prisma/seed.ts", "postinstall": "prisma generate" }'
      : '  scripts: { "dev": "vite", "build": "vite build", "preview": "vite preview" } y "type": "module".',
    isApp ? "BASE DE DATOS [CRÍTICO]:" : null,
    isApp ? "• prisma/schema.prisma usa datasource PostgreSQL con `DATABASE_URL` y un modelo por entidad principal." : null,
    isApp ? "• lib/db.ts exporta un PrismaClient singleton seguro para hot reload." : null,
    isApp ? "• docker-compose.yml levanta Postgres local; .env.example contiene una DATABASE_URL funcional para ese compose." : null,
    isApp ? "• prisma/seed.ts crea datos demo coherentes con el nicho. NO uses arrays globales ni almacenamiento en memoria como capa primaria." : null,
    "TAILWIND v4 [CRÍTICO — la sintaxis v3 está PROHIBIDA aquí]:",
    isApp ? "• Para apps full-stack usa CSS profesional en app/globals.css o Tailwind si lo configuras correctamente. No bloquees la app por setup ornamental." : "• PROHIBIDO crear tailwind.config.js o postcss.config.js, e instalar postcss/autoprefixer.",
    isApp ? "• Prioriza estructura, datos reales y UX de producto. Si usas Tailwind v4, respeta la sintaxis correcta; si no, usa CSS nativo pulido." : "• PROHIBIDAS las directivas v3 `@tailwind base; @tailwind components; @tailwind utilities;`.",
    isApp ? null : '• src/index.css: primero el @import de Google Fonts, luego `@import "tailwindcss";`, luego :root { } con la paleta',
    isApp ? null : "  como CSS custom properties (--bg, --surface, --fg, --muted, --accent, --line, --font-display, --font-body)",
    isApp ? null : "  y un bloque @theme inline que mapee los colores (--color-bg: var(--bg); …).",
    isApp ? null : '• vite.config.ts: import react de "@vitejs/plugin-react" + import tailwindcss de "@tailwindcss/vite" → plugins: [react(), tailwindcss()].',
    isApp ? null : '• tsconfig.json mínimo en una pieza: target ES2022, module ESNext, moduleResolution "bundler", jsx "react-jsx", strict, noEmit, include ["src"].',
    isApp ? "• Iconos: usa lucide-react solo si lo incluyes en dependencies; si no, usa controles nativos sin emojis." : "• Fuentes: Syne (display/titulares) + Space Grotesk (cuerpo) vía Google Fonts, mapeadas a --font-display / --font-body.",
    isApp ? null : "• Iconos: SOLO lucide-react (imports nominales). NADA de emojis como iconos.",
    "",
    "ARQUITECTURA:",
    isApp
      ? "• Tres capas obligatorias: frontend (páginas y formularios), backend (Route Handlers GET/POST por entidad), base de datos (Prisma/PostgreSQL)."
      : "• SPA sin React Router. 100% ESTÁTICO: sin backend ni llamadas reales a APIs — datos demo en memoria.",
    isApp
      ? "• El frontend debe consumir sus propias API routes con fetch, mostrar loading/empty/error states, crear registros y refrescar datos."
      : "• ANIMACIONES POR SCROLL OBLIGATORIAS con Framer Motion: `useInView` (o `whileInView` + `viewport={{ once: true }}`)",
    isApp ? "• Incluye README con comandos para DB, seed, dev, build y publicación." : "  para la entrada de CADA sección. Movimiento elegante: fades + translate + stagger, nunca exagerado.",
    "• Responsive MÓVIL PRIMERO con breakpoints de Tailwind (sm/md/lg). Menú hamburguesa en móvil.",
    "• Accesibilidad WCAG AA: HTML semántico (header/nav/main/section/footer), alt/aria, foco visible, contraste ≥ 4.5:1.",
    "",
    "COHERENCIA DE NICHO [CRÍTICO] — TODO el contenido pertenece EXCLUSIVAMENTE al rubro del negocio:",
    "• Analiza el sector (ropa, restaurante, software, gimnasio, clínica…) y alinea cada palabra e imagen a él.",
    "• Copy REAL y persuasivo del dominio (jamás genérico). PROHIBIDO lorem ipsum.",
    "• Imágenes ESTRICTAMENTE del rubro: ilustraciones SVG vectoriales integradas, o https://images.unsplash.com/…",
    "  con términos del nicho / https://picsum.photos/seed/PALABRA-DEL-RUBRO/1600/1000. PROHIBIDAS fotos genéricas",
    "  sin relación (paisajes, oficinas stock). Trátalas con overlays/duotono y `alt` descriptivo.",
    "",
    "COMPONENTE OBLIGATORIO «Invitar al proyecto»" +
      (isApp ? " (en la topbar de la app):" : " (barra superior o sección de colaboración):"),
    "• Botón principal con el texto «Invitar» (icono Lucide UserPlus).",
    "• Panel/modal animado con Framer Motion (AnimatePresence + scale/opacity) que muestra:",
    "  – «Enlace privado para unirse»: input readOnly con una URL demo (p.ej. https://miapp.dev/join/AB12-CD34).",
    "  – Subtexto explicativo EXACTO: «Cualquier persona con el enlace tendrá acceso de edición».",
    "  – Botón COPIAR: navigator.clipboard.writeText + feedback visual temporal «¡Copiado!».",
    "  – Input de email + botón «Invitar por correo electrónico» (validación simple de formato; aviso en memoria, sin llamada real).",
    "",
    "CALIDAD VISUAL (anti AI-slop) — evita: gradientes morado-sobre-blanco, tarjetas idénticas en fila, layouts",
    "cookie-cutter centrados, Inter/Roboto como display, emojis como iconos. Exige: titulares Syne MUY grandes con",
    "clamp(), paleta 3-5 colores usada con intención (CSS vars), espaciado generoso, layouts editoriales/asimétricos,",
    "profundidad (sombras suaves, blur, hairlines), micro-interacciones hover y nav sticky translúcido.",
    isApp
      ? "Layout de aplicación (sidebar/topbar con Invitar), vistas con datos demo realistas, estados vacío/cargando, interacciones que funcionan (añadir/editar/filtrar/marcar)."
      : "Orden de secciones de conversión: Hero → Características/Productos → Beneficios/About → Colaboración (Invitar) → CTA final → Footer completo.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
}

/**
 * Output format for the STREAMING transport (fenced code blocks parsed by
 * parseCodeBlocks). The path goes ONLY in the fence header: the parser does
 * NOT strip `// path:` comment lines when the header already carries the path,
 * and a comment inside package.json breaks `bun install`.
 */
export function contractPathsForContext(ctx?: AgentBuildContext): readonly string[] {
  return ctx?.goal === "app" ? FULL_STACK_APP_CONTRACT_PATHS : VITE_LANDING_CONTRACT_PATHS
}

export function streamOutputFormat(opts?: { strictStart?: boolean; paths?: readonly string[] }): string {
  const strictStart = opts?.strictStart !== false
  const paths = opts?.paths || VITE_LANDING_CONTRACT_PATHS
  const contractFiles = paths.join(", ")
  return [
    "FORMATO DE SALIDA (ESTRICTO — respétalo al 100%):",
    "• Devuelve CADA archivo en su PROPIO bloque de código. El encabezado del fence es `lenguaje ruta`, p.ej.:",
    "  ```json package.json",
    "  { …archivo completo… }",
    "  ```",
    `• Bloques requeridos, en este orden: ${contractFiles}.`,
    paths.includes("prisma/schema.prisma")
      ? "• Además, crea app/api/<entidad>/route.ts y app/<entidad>/page.tsx por cada entidad central del software."
      : null,
    strictStart
      ? "• El PRIMER carácter de tu respuesta DEBE ser un backtick: empieza EXACTAMENTE con ```json package.json\n" +
        "  PROHIBIDO escribir cualquier cosa antes (ni saludos, ni «Aquí tienes…», ni explicaciones)."
      : "• En la respuesta de GENERACIÓN el PRIMER carácter DEBE ser un backtick (```json package.json) — sin saludos\n" +
        "  ni explicaciones antes. Planifica internamente y ejecuta; NO hagas preguntas previas.",
    "• La ruta va SOLO en el encabezado del fence. PROHIBIDO añadir líneas `// path:` dentro del contenido",
    "  (package.json es JSON puro: un comentario lo rompe).",
    "• Cada bloque contiene el archivo COMPLETO (nunca fragmentos ni «…»).",
    "• Tras el último bloque: como MÁXIMO una sola línea con 1-3 siguientes pasos.",
  ].filter((line): line is string => line !== null).join("\n")
}

/** Transport instructions for the OpenCode ENGINE (write/edit file tools). */
export function engineTransportInstructions(): string {
  return [
    "IMPORTANTE — TRANSPORTE (motor con herramientas):",
    "• ESCRIBE cada archivo del contrato en el workspace con tus herramientas (write/edit), uno por uno,",
    "  con su ruta EXACTA relativa a la raíz (p.ej. `src/App.tsx` — sin prefijos tipo `artifacts/`).",
    "• NO pegues el código en el chat: el chat es SOLO para un resumen final de 1-3 líneas",
    "  («archivos creados — pulsa ▶ Ejecutar para levantar el dev server»).",
    `• Verifica antes de terminar que existen: ${CONTRACT_FILES}.`,
  ].join("\n")
}

/** SRE role: diagnose a build log, output the strict 5-section format. */
export function sreSystemPrompt(log: string, configFiles: string): string {
  return [
    "[ROL: SRE / DOCTOR DE BUILDS]",
    "Recibes un LOG de error de empaquetado/instalación/despliegue. Diagnostica y ARREGLA.",
    "NO reescribas la app. Tu objetivo es desbloquear el build tocando SOLO configuración.",
    "",
    "Responde EXACTAMENTE con estas 5 secciones (Markdown, en este orden):",
    "**Diagnóstico:** Una frase: qué falló (compilación/instalación/despliegue).",
    "**Qué pasaba:** Mecanismo técnico (ej. `npm --prefix` falló al bajar un tarball roto del registro/espejo;",
    "   dependencia transitiva inalcanzable por el firewall del entorno).",
    "**Causa raíz:** Por qué NO es culpa del código del usuario, sino del entorno/red/registry.",
    "**Arreglo:** La solución exacta como bloque(s) aplicables. Prefiere, en orden: (a) `overrides`/`resolutions`",
    "   en package.json para fijar/sustituir la dependencia rota; (b) fijar versiones estables; (c) marcar opcional.",
    "   Entrega el package.json COMPLETO en un bloque cuyo encabezado de fence sea ```json package.json",
    "   (la ruta va SOLO en el encabezado — NUNCA como comentario `// path:` dentro del JSON: lo rompería).",
    "**Siguiente paso:** Una instrucción imperativa de UNA línea para la UI",
    "   (ej. «Pulsa ⚡ Construir / Re-publicar para reintentar la instalación»).",
    "",
    "--- ARCHIVOS DE CONFIGURACIÓN DEL WORKSPACE ---",
    configFiles || "(sin package.json / config en el workspace)",
    "",
    "--- LOG DE ERROR ---",
    log,
  ].join("\n")
}
