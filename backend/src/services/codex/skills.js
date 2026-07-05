'use strict';

/**
 * codex/skills — on-demand playbooks for the APPS agent (Agent Skills pattern).
 *
 * Inspired by the SKILL.md open standard (Claude Code / Cline / Codex CLI):
 * a skill is a named, self-contained playbook the agent loads ONLY when the
 * task calls for it — the context stays lean until specialized knowledge is
 * needed. Two sources, merged at call time:
 *
 *   1. BUILTIN_SKILLS — curated playbooks shipped with the platform (landing
 *      design, CRUD, dashboards, auth, forms, debugging). They encode the
 *      house style: clean, typed, verified code.
 *   2. Workspace skills — `.sira/skills/*.md` inside the project. Frontmatter
 *      (`name:` / `description:`) plus a markdown body. Strictly validated
 *      (count/size/name caps) and NEVER allowed to shadow a builtin.
 *
 * Zero dependencies, pure Node, offline-testable. The agent reaches skills
 * through the `use_skill` tool (build-tools.js); the system prompt only
 * carries the one-line catalog, not the bodies.
 */

const SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const MAX_WORKSPACE_SKILLS = 10;
const MAX_SKILL_BODY_CHARS = 8000;
const MAX_DESCRIPTION_CHARS = 160;

const BUILTIN_SKILLS = [
  {
    name: 'landing-profesional',
    description: 'Diseño de landing page de nivel agencia: estructura, tipografía, paleta, motion y conversión.',
    body: [
      '# Skill: landing-profesional',
      '',
      'Contrato de diseño para una landing que se sienta hecha por una agencia, no por una plantilla.',
      '',
      '## Estructura (en este orden)',
      '1. **Hero**: titular de beneficio (≤9 palabras), subtítulo concreto, CTA primario + secundario, elemento visual (mockup/ilustración CSS). Nada de "Bienvenido a…".',
      '2. **Prueba social**: logos o métricas ("+2.400 pedidos/mes") inmediatamente bajo el hero.',
      '3. **Features**: 3 tarjetas máximo por fila, icono + título de 2-4 palabras + 1 frase. Beneficios, no características técnicas.',
      '4. **Sección de detalle**: alterna imagen/texto (zig-zag) para 2-3 casos de uso.',
      '5. **Testimonios**: cita corta + nombre + rol. Reales en tono, sin superlativos vacíos.',
      '6. **CTA final** de ancho completo con contraste fuerte + **footer** con columnas.',
      '',
      '## Sistema visual',
      '- Estiliza con clases TAILWIND (v4 ya activo). Los tokens del tema viven en src/index.css (:root → --bg/--surface/--fg/--muted/--accent/--line → clases bg-bg, bg-surface, text-fg, text-muted, bg-accent, border-line); ajusta SOLO esas variables para la paleta de la marca.',
      '- UNA fuente display para titulares y una de texto (system-ui vale). Escala tipográfica clara: hero ~clamp(2.2rem,5vw,3.6rem).',
      '- Paleta: 1 color de acento + neutros (fondo casi blanco o casi negro, NUNCA gris medio).',
      '- Espaciado generoso: secciones con padding vertical ≥ 96px desktop / 56px móvil.',
      '- Bordes redondeados consistentes (una sola escala: p.ej. 12px/20px) y sombras suaves, no duras.',
      '',
      '## Motion (framer-motion YA está en el starter — úsalo)',
      '- Entrada por sección con fade+rise (once: true). Hover en tarjetas: translateY(-2px) + sombra. NADA de animaciones largas o loops que distraigan.',
      '- TIPADO de componentes animados: NUNCA extiendas React.ButtonHTMLAttributes y hagas spread en motion.button (choca onAnimationStart/onDrag → TS2322). Usa `HTMLMotionProps<"button">` de framer-motion como tipo de props, o define solo las props que necesitas (children, onClick, className).',
      '',
      '## Calidad',
      '- Responsive real: probar mentalmente 360px, 768px, 1280px. Grid → 1 columna en móvil.',
      '- Accesible: contraste AA, alt en imágenes, botones con texto real.',
      '- Al terminar: type_check + dev_server_check y corrige lo que salga.',
    ].join('\n'),
  },
  {
    name: 'crud-entidades',
    description: 'CRUD limpio por entidad: estado tipado, lista + alta + edición + borrado, validación y estados vacíos.',
    body: [
      '# Skill: crud-entidades',
      '',
      'Patrón para módulos de datos (clientes, productos, pedidos…) en React+TS sin backend.',
      '',
      '## Modelo',
      '- `src/types.ts`: interfaz por entidad con id (string), timestamps y campos tipados (nunca `any`).',
      '- `src/store/<entidad>.ts`: estado con useState/useReducer en el componente raíz del módulo O un hook `use<Entidad>()` que encapsula CRUD + persistencia en localStorage (clave versionada `app:<entidad>:v1`).',
      '- Datos de ejemplo realistas del dominio (5-8 filas) al primer arranque.',
      '',
      '## UI por entidad',
      '- Usa el kit src/ui (Button, Card, Input, Textarea, Label, Badge) + clases Tailwind — NO reinventes controles básicos ni uses estilos inline.',
      '- **Lista**: tabla o tarjetas con búsqueda por texto, orden por columna clave y estado vacío con CTA ("Aún no hay clientes — crea el primero").',
      '- **Alta/edición**: formulario controlado en modal o panel lateral; validación por campo al blur; botón deshabilitado mientras haya errores; feedback de éxito.',
      '- **Borrado**: confirmación explícita (no window.confirm — un mini-diálogo propio).',
      '',
      '## Limpieza',
      '- Componentes ≤150 líneas; extrae `EntityForm`, `EntityRow`, `EmptyState`.',
      '- Handlers nombrados (handleCreate/handleUpdate), no lambdas gigantes inline.',
      '- IDs con crypto.randomUUID(). Fechas ISO. Formateo de moneda con Intl.NumberFormat.',
      '- type_check al terminar cada módulo, no al final de todo.',
    ].join('\n'),
  },
  {
    name: 'dashboard-kpis',
    description: 'Dashboard ejecutivo: tarjetas KPI, gráficas coherentes, grid responsive y datos de ejemplo creíbles.',
    body: [
      '# Skill: dashboard-kpis',
      '',
      '## Layout',
      '- Header con título + rango de fechas (aunque sea decorativo). Grid: fila de 3-4 KPI cards arriba, luego 2 columnas de gráficas, luego tabla de detalle.',
      '- En móvil todo apila a 1 columna. Usa CSS grid con minmax, no anchos fijos.',
      '',
      '## KPI cards',
      '- Base: Card/CardContent del kit src/ui + clases Tailwind (bg-surface, border-line); Badge para el delta.',
      '- Valor grande (tabular-nums), etiqueta corta, delta vs periodo anterior con color semántico (verde sube/rojo baja) y flecha. Nada de decimales absurdos.',
      '',
      '## Gráficas',
      '- recharts YA está en el starter: úsalo para líneas/barras/áreas. Para sparklines minúsculas un SVG propio vale.',
      '- Una gráfica = una pregunta ("¿cómo van las ventas por semana?"). Ejes legibles, tooltip, paleta consistente con el acento de la app.',
      '',
      '## Datos',
      '- Generador determinista de datos de ejemplo con tendencia creíble (crecimiento + ruido), no random puro que cambia en cada render.',
      '',
      '## Limpieza',
      '- `src/data/metrics.ts` para el generador; componentes de gráfica separados; cero `any`; type_check al cerrar.',
    ].join('\n'),
  },
  {
    name: 'auth-basica',
    description: 'Login/registro con sesión local, rutas protegidas y UX correcta de errores — sin backend.',
    body: [
      '# Skill: auth-basica',
      '',
      '## Alcance honesto',
      'Sin backend real la "auth" es de DEMO: sesión en localStorage. Dilo en el resumen final — nunca la presentes como segura.',
      '',
      '## Implementación',
      '- `src/auth/useAuth.ts`: hook con {user, login, register, logout}; usuarios en localStorage (`app:users:v1`), sesión en `app:session:v1`.',
      '- Pantallas Login y Registro: formularios controlados, validación (email válido, password ≥8), error visible bajo el campo, estado cargando en el botón.',
      '- Rutas protegidas: si no hay sesión, muestra Login en lugar del contenido (guard en el componente raíz; sin router basta un switch de vista).',
      '- Header con nombre del usuario + botón salir cuando hay sesión.',
      '',
      '## Limpieza',
      '- Nunca guardes la password en claro en el objeto sesión. Tipos estrictos para User. type_check al terminar.',
    ].join('\n'),
  },
  {
    name: 'formularios-validados',
    description: 'Formularios controlados con validación por campo, estados de envío y accesibilidad.',
    body: [
      '# Skill: formularios-validados',
      '',
      '- Estado por campo + objeto `errors` tipado; valida al blur y re-valida al cambiar si ya había error.',
      '- Reglas en funciones puras (`validators.ts`) — testeables y reutilizables.',
      '- Botón de envío: disabled con errores, spinner mientras "envía", éxito visible (mensaje o reset + toast propio).',
      '- Accesibilidad: label con htmlFor, aria-invalid en campos con error, el error como texto asociado (aria-describedby).',
      '- Nunca alert(); estados de UI propios.',
    ].join('\n'),
  },
  {
    name: 'ecommerce-catalogo',
    description: 'Tienda con catálogo, carrito y checkout de demo: grid de productos, filtros, estado del carrito y momentos de confianza.',
    body: [
      '# Skill: ecommerce-catalogo',
      '',
      '## Estructura',
      '- Header con logo, búsqueda y carrito (badge con contador). Grid de productos responsive (minmax 240px).',
      '- Tarjeta de producto: imagen (placeholder CSS con gradiente por categoría), nombre, precio con Intl.NumberFormat, botón añadir con feedback inmediato.',
      '- Filtros por categoría + orden (precio/nombre) como estado controlado, no recarga.',
      '- Carrito en panel lateral: líneas con cantidad editable, subtotal por línea, total, y CTA de checkout.',
      '- Checkout de DEMO (formulario validado + pantalla de éxito con resumen) — dilo honesto: sin pagos reales.',
      '',
      '## Datos y estado',
      '- `src/data/products.ts`: 8-12 productos realistas del dominio pedido (nombre, precio, categoría, descripción corta).',
      '- Carrito con useReducer + persistencia localStorage (`app:cart:v1`). Tipos estrictos: Product, CartLine.',
      '',
      '## Confianza y UX',
      '- Estados: carrito vacío con CTA, añadido con micro-feedback (badge anima), stock/etiquetas si aplican.',
      '- Accesible: botones con aria-label, foco visible en el panel del carrito.',
      '- type_check + dev_server_check al cerrar; browser_check confirma que el flujo añadir→carrito→checkout renderiza.',
    ].join('\n'),
  },
  {
    name: 'portfolio-personal',
    description: 'Portfolio/CV de una persona o estudio: hero con identidad, proyectos con casos, about y contacto — sobrio y memorable.',
    body: [
      '# Skill: portfolio-personal',
      '',
      '## Estructura',
      '1. Hero: nombre grande + rol en una frase con personalidad ("Diseño interfaces que venden") + CTA a proyectos/contacto.',
      '2. Proyectos: 3-6 tarjetas con visual (gradiente/patrón CSS por proyecto), problema→solución en 2 líneas, stack como chips.',
      '3. About: párrafo humano (primera persona) + foto placeholder circular + 3-5 skills clave.',
      '4. Contacto: email visible + enlaces (GitHub/LinkedIn) con iconos lucide — sin formularios falsos si no hay backend.',
      '',
      '## Sistema visual',
      '- Personalidad > plantilla: elige UN gesto memorable (tipografía display marcada, acento inesperado, o grid asimétrico) y sé sobrio en el resto.',
      '- Modo oscuro por defecto suele vestir mejor un portfolio; contraste AA.',
      '- Micro-motion con framer-motion: entrada del hero y hover en proyectos, nada más.',
      '',
      '## Limpieza',
      '- Datos de la persona en `src/data/profile.ts` (editable en un solo lugar). Componentes por sección. type_check al cerrar.',
    ].join('\n'),
  },
  {
    name: 'app-empresarial',
    description: 'Software de empresa multi-módulo (CRM/ERP/inventario/facturación/RRHH): shell con sidebar, dashboard, CRUD por módulo y datos realistas.',
    body: [
      '# Skill: app-empresarial',
      '',
      'Para software de EMPRESA delega PRIMERO en enterprise_analyst (convierte el pedido en módulos, entidades, roles y flujos) y construye sobre su especificación.',
      '',
      '## Shell de la aplicación',
      '- Todo con clases Tailwind + el kit src/ui (Button/Card/Input/Badge) — cero estilos inline; los tokens de tema (--accent, --surface…) se ajustan a la marca en src/index.css.',
      '- Sidebar fija con módulos (icono lucide + nombre) + header con búsqueda global y usuario. Módulo activo resaltado.',
      '- Vista = estado controlado (switch por módulo); sin router basta un useState<ModuleId>.',
      '- Primer módulo SIEMPRE un Dashboard: 3-4 KPIs del dominio + 1-2 gráficas (recharts) + tabla de actividad reciente.',
      '',
      '## Por módulo (CRUD completo)',
      '- Sigue el patrón de crud-entidades: lista con búsqueda/orden/estado vacío, alta-edición en panel lateral validado, borrado con confirmación propia.',
      '- Relaciones simples por id (pedido.clienteId → nombre resuelto al render); nada de joins falsos complejos.',
      '- 6-10 filas de datos de ejemplo REALISTAS del dominio por entidad (nombres/importes/fechas creíbles, es-ES).',
      '',
      '## Código',
      '- `src/types.ts` (todas las entidades), `src/data/seed.ts` (semillas), un componente por módulo en `src/modules/`.',
      '- Persistencia localStorage por entidad (`app:<entidad>:v1`). Moneda con Intl.NumberFormat("es-PE"/"es-ES" según el dominio).',
      '- type_check TRAS CADA MÓDULO (no al final). Cierra con browser_check.',
      '',
      '## Honestidad',
      '- Sin backend real: dilo en el resumen (datos locales de demostración). Roles/permisos solo visuales si no hay auth real.',
    ].join('\n'),
  },
  {
    name: 'app-con-ia',
    description: 'Apps con IA integrada (chat tipo ChatGPT/Claude, asistentes, generadores): UI de chat profesional sobre el helper askAI de la plataforma.',
    body: [
      '# Skill: app-con-ia',
      '',
      'El starter YA trae `src/lib/ai.ts` con `askAI(messages, { system? })` (respuesta completa) y `askAIStream(messages, { onDelta })` (tokens fluyendo en tiempo real como ChatGPT): habla con la IA de la plataforma SIN API keys (el proxy del servidor las gestiona). NUNCA pidas al usuario una API key ni inventes un endpoint propio.',
      '',
      '## UI de chat (estándar ChatGPT/Claude)',
      '- Lista de mensajes con burbujas diferenciadas (usuario derecha/acento, asistente izquierda/neutra), auto-scroll al final.',
      '- Composer: textarea que crece, Enter envía / Shift+Enter salto, botón enviar deshabilitado en vacío o mientras responde.',
      '- **USAR askAIStream** para que los tokens fluyan en vivo — la burbuja del asistente crece mientras se escribe, igual que ChatGPT.',
      '- Estado "pensando": indicador animado mientras llega el primer token del stream.',
      '- Errores VISIBLES: si askAI/askAIStream lanza, muestra el mensaje en una burbuja de error con botón reintentar. Nunca lo silencies.',
      '- 3-4 sugerencias de inicio (chips clicables) relevantes al dominio pedido, que desaparecen al primer mensaje.',
      '',
      '## Estado y memoria',
      '- Historial tipado `AIMessage[]` en useState + persistencia localStorage (`app:chat:v1`) con botón "Nueva conversación".',
      '- SYSTEM PROMPT del dominio: define la personalidad/rol del asistente según el pedido (ej. asesor legal, tutor de inglés, chef) y pásalo en opts.system. Esto convierte la app genérica en EL producto pedido.',
      '- Envía como contexto los últimos ~12 mensajes (la API acepta máx 30, 4000 chars por mensaje).',
      '',
      '## Calidad',
      '- La respuesta puede tardar segundos: la UI nunca se congela (async + estados).',
      '- Diseña la pantalla completa (header con nombre del asistente, área de chat, composer fijo abajo) — es un producto, no un demo.',
      '- type_check + browser_check al cerrar: envía un mensaje de prueba mentalmente imposible de fallar ("hola") en tu revisión del flujo.',
    ].join('\n'),
  },
  {
    name: 'debug-runtime',
    description: 'Diagnóstico disciplinado cuando la app no compila o no corre: leer el error REAL antes de tocar código.',
    body: [
      '# Skill: debug-runtime',
      '',
      '1. **Lee el error real**: type_check para compilación, dev_server_check para runtime (module not found, overlay de Vite, sintaxis). NO adivines.',
      '2. **Clasifica**: (a) import/ruta mal → corrige el path exacto; (b) dependencia no declarada → añádela a package.json y reinstala; (c) error de tipos → arregla el TIPO, no le pongas `any`; (d) JSX/sintaxis → lee el archivo con read_file y corrige el fragmento exacto.',
      '3. **Un fix por ciclo**: cambia lo mínimo, re-verifica (type_check / dev_server_check), repite. Nunca reescribas el archivo entero por un error de una línea.',
      '4. **Si el mismo fix falla 2 veces**, retrocede: relee el archivo completo y cuestiona el diagnóstico — el error suele estar aguas arriba (un tipo exportado mal, un import circular).',
      '5. **Pitfalls conocidos**: TS2322 en motion.button/motion.div con props spread → el tipo debe ser HTMLMotionProps<"button"> (framer-motion), no React.ButtonHTMLAttributes; "module not found ./X" tras crear X.tsx → revisa mayúsculas exactas del archivo.',
    ].join('\n'),
  },
  {
    name: 'backend-real',
    description: 'Apps full-stack con backend Express + SQLite: datos persistentes REALES, no localStorage.',
    body: [
      '# Skill: backend-real',
      '',
      'El starter full-stack YA trae Express corriendo en el puerto 3001 + SQLite (better-sqlite3) + Vite con proxy /api. Los datos persisten de verdad: recarga la página y siguen ahí.',
      '',
      '## Arquitectura',
      '- `server/index.js` — servidor Express con SQLite. Modifica este archivo para añadir entidades/rutas.',
      '- `/api/*` — proxy de Vite al servidor Express. El frontend llama a `/api/items` (no a localhost:3001).',
      '- `server/data.db` — archivo SQLite real (se crea en el primer arranque).',
      '',
      '## Cuando añadas una nueva entidad',
      '1. Crea la tabla en `server/index.js` con `CREATE TABLE IF NOT EXISTS` + columnas apropiadas.',
      '2. Añade rutas REST: `GET /api/<entidad>`, `POST /api/<entidad>`, `PATCH /api/<entidad>/:id`, `DELETE /api/<entidad>/:id`.',
      '3. Inserta seed data realista (5-10 filas) la primera vez con `INSERT IF NOT EXISTS` o `count===0`.',
      '4. En el frontend, consume la API con `fetch(\'/api/<entidad>\')` — nunca uses localStorage para datos que el backend maneja.',
      '',
      '## Calidad',
      '- Validación server-side: 400 con mensaje claro si falta un campo requerido.',
      '- Manejo de errores: try/catch en el frontend, mostrar el error al usuario.',
      '- Estados: loading mientras fetch, empty state si no hay datos, error state si falla.',
      '- El runner arranca Express y Vite con concurrently — ambos logs aparecen en dev_server_check.',
      '- type_check TRAS añadir rutas. Cierra con browser_check.',
    ].join('\n'),
  },
];

function looksLikeSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name);
}

/** Parse optional `--- name: x\ndescription: y ---` frontmatter from a .md body. */
function parseSkillMarkdown(raw, fallbackName) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let name = fallbackName;
  let description = '';
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const nameLine = fm[1].match(/^name:\s*(.+)$/m);
    const descLine = fm[1].match(/^description:\s*(.+)$/m);
    if (nameLine) name = nameLine[1].trim();
    if (descLine) description = descLine[1].trim();
    body = text.slice(fm[0].length).trim();
  }
  if (!description) {
    const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#'));
    description = (firstLine || '').trim();
  }
  if (!looksLikeSkillName(name)) return null;
  if (!body) return null;
  return {
    name,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    body: body.slice(0, MAX_SKILL_BODY_CHARS),
    source: 'workspace',
  };
}

/**
 * Load `.sira/skills/*.md` from the project workspace. Best-effort by
 * contract: any runner/parse failure yields [] — a broken skill file must
 * never break a build turn. Workspace skills cannot shadow builtins.
 */
async function loadWorkspaceSkills({ runner, project } = {}) {
  if (!runner || !project) return [];
  let names = [];
  try {
    const out = await runner.exec(project, ['ls', '.sira/skills'], { timeoutMs: 10_000 });
    names = String(out?.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.md'))
      .slice(0, MAX_WORKSPACE_SKILLS);
  } catch {
    return [];
  }
  const builtinNames = new Set(BUILTIN_SKILLS.map((s) => s.name));
  const skills = [];
  for (const file of names) {
    try {
      const read = await runner.readFile(project, `.sira/skills/${file}`);
      const parsed = parseSkillMarkdown(read?.content, file.replace(/\.md$/, ''));
      if (parsed && !builtinNames.has(parsed.name) && !skills.some((s) => s.name === parsed.name)) {
        skills.push(parsed);
      }
    } catch {
      /* skip unreadable skill — never fail the turn */
    }
  }
  return skills;
}

/** Merged catalog: builtins first, then valid workspace skills. */
function listSkills(workspaceSkills = []) {
  return [
    ...BUILTIN_SKILLS.map((s) => ({ name: s.name, description: s.description, source: 'builtin' })),
    ...workspaceSkills.map((s) => ({ name: s.name, description: s.description, source: 'workspace' })),
  ];
}

function getSkill(name, workspaceSkills = []) {
  const wanted = String(name || '').trim().toLowerCase();
  return (
    BUILTIN_SKILLS.find((s) => s.name === wanted) ||
    workspaceSkills.find((s) => s.name === wanted) ||
    null
  );
}

/** One-line-per-skill catalog for tool observations / prompts. */
function formatCatalog(workspaceSkills = []) {
  return listSkills(workspaceSkills)
    .map((s) => `- ${s.name}${s.source === 'workspace' ? ' (del proyecto)' : ''}: ${s.description}`)
    .join('\n');
}

/** Compact system-prompt line — names only; bodies load on demand. */
function skillsPromptLine() {
  const names = BUILTIN_SKILLS.map((s) => s.name).join(', ');
  return `SKILLS (playbooks bajo demanda): antes de construir algo de un tipo conocido, carga su playbook con use_skill — disponibles: ${names}, más los .md que el proyecto defina en .sira/skills/ (use_skill sin nombre lista todo). Sigue el playbook cargado: encodea el estándar de calidad esperado.`;
}

module.exports = {
  BUILTIN_SKILLS,
  loadWorkspaceSkills,
  listSkills,
  getSkill,
  formatCatalog,
  skillsPromptLine,
  parseSkillMarkdown,
  MAX_WORKSPACE_SKILLS,
  MAX_SKILL_BODY_CHARS,
};

// ─── Deterministic skill detection ──────────────────────────────────────────
// The E2E validation run showed models skip a passively-listed use_skill —
// so the loop AUTO-INJECTS the matching playbook at run start (media-intent
// doctrine: critical behaviour must not depend on the model asking for it).
const SKILL_TRIGGERS = [
  { name: 'backend-real', re: /\b(base de datos real|backend real|api real|que guarde de verdad|con (backend|servidor|base de datos|api|bd))\b/i },
  { name: 'app-con-ia', re: /\b(chat\s?bot|chatbot|asistente( virtual| de ia| inteligente| con ia)?|como (chat\s?gpt|chatgpt|claude|gemini|gpt)|con (ia|inteligencia artificial)|(usando|con|mediante) (la )?api de (ia|openai|gpt|claude)|agente de ia|ia integrada|tutor (virtual|de)|generador de texto)\b/i },
  { name: 'landing-profesional', re: /\b(landing|p[aá]gina (de aterrizaje|web|principal)|one[- ]?page|sitio (web )?promocional|portada)\b/i },
  { name: 'dashboard-kpis', re: /\b(dashboard|panel (de )?(control|m[eé]tricas|admin)|kpis?|anal[ií]tica|reportes? ejecutivos?)\b/i },
  { name: 'auth-basica', re: /\b(login|inicio de sesi[oó]n|registro de usuarios?|autenticaci[oó]n|sign ?in|sign ?up)\b/i },
  { name: 'app-empresarial', re: /\b(crm|erp|inventario|facturaci[oó]n|rr\s?hh|recursos humanos|punto de venta|pos\b|sistema (de )?(gesti[oó]n|administraci[oó]n) (empresarial|de empresa|de negocio)|software (de )?empresa)\b/i },
  { name: 'crud-entidades', re: /\b(crud|gesti[oó]n de (clientes|productos|pedidos|empleados|proveedores|proyectos|tareas)|cat[aá]logo de (clientes|contactos|art[ií]culos))\b/i },
  { name: 'ecommerce-catalogo', re: /\b(tienda( online| virtual)?|e-?commerce|cat[aá]logo de productos|carrito|shop\b|venta de productos)\b/i },
  { name: 'portfolio-personal', re: /\b(portafolio|portfolio|cv online|curr[ií]culum web|p[aá]gina personal)\b/i },
  { name: 'formularios-validados', re: /\b(formulario|encuesta|form(?:s)?\b|captura de datos)\b/i },
];

/** First matching builtin skill for a build prompt, or null. */
function detectSkillForPrompt(prompt) {
  const text = String(prompt || '');
  if (!text.trim()) return null;
  for (const trigger of SKILL_TRIGGERS) {
    if (trigger.re.test(text)) {
      return BUILTIN_SKILLS.find((s) => s.name === trigger.name) || null;
    }
  }
  return null;
}

module.exports.detectSkillForPrompt = detectSkillForPrompt;
module.exports.SKILL_TRIGGERS = SKILL_TRIGGERS;
