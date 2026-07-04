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
      '- UNA fuente display para titulares y una de texto (system-ui vale). Escala tipográfica clara: hero ~clamp(2.2rem,5vw,3.6rem).',
      '- Paleta: 1 color de acento + neutros (fondo casi blanco o casi negro, NUNCA gris medio). Definir como variables CSS en :root.',
      '- Espaciado generoso: secciones con padding vertical ≥ 96px desktop / 56px móvil.',
      '- Bordes redondeados consistentes (una sola escala: p.ej. 12px/20px) y sombras suaves, no duras.',
      '',
      '## Motion (si framer-motion está disponible; si no, transiciones CSS)',
      '- Entrada por sección con fade+rise (once: true). Hover en tarjetas: translateY(-2px) + sombra. NADA de animaciones largas o loops que distraigan.',
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
      '- Valor grande (tabular-nums), etiqueta corta, delta vs periodo anterior con color semántico (verde sube/rojo baja) y flecha. Nada de decimales absurdos.',
      '',
      '## Gráficas',
      '- Si recharts está en package.json úsalo; si no, SVG propio simple (barras/línea) — NO instales librerías pesadas solo para esto.',
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
    name: 'debug-runtime',
    description: 'Diagnóstico disciplinado cuando la app no compila o no corre: leer el error REAL antes de tocar código.',
    body: [
      '# Skill: debug-runtime',
      '',
      '1. **Lee el error real**: type_check para compilación, dev_server_check para runtime (module not found, overlay de Vite, sintaxis). NO adivines.',
      '2. **Clasifica**: (a) import/ruta mal → corrige el path exacto; (b) dependencia no declarada → añádela a package.json y reinstala; (c) error de tipos → arregla el TIPO, no le pongas `any`; (d) JSX/sintaxis → lee el archivo con read_file y corrige el fragmento exacto.',
      '3. **Un fix por ciclo**: cambia lo mínimo, re-verifica (type_check / dev_server_check), repite. Nunca reescribas el archivo entero por un error de una línea.',
      '4. **Si el mismo fix falla 2 veces**, retrocede: relee el archivo completo y cuestiona el diagnóstico — el error suele estar aguas arriba (un tipo exportado mal, un import circular).',
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
