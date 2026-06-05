'use strict';

/**
 * siraGPT Builder · E2 — blueprint.
 *
 * Consumes the ProjectBrief emitted by the E1 intake and produces a
 * deterministic build plan: tech stack, screens/pages, a typed data model,
 * the integrations to wire, and ordered milestones with tasks. No LLM calls —
 * a pure, repeatable mapping so the same brief always yields the same plan.
 */

const { z } = require('zod');
const { ProjectBriefSchema } = require('./contracts');

const BlueprintSchema = z.object({
  stack: z.object({
    frontend: z.string(),
    backend: z.string(),
    database: z.string(),
    hosting: z.string(),
  }),
  pages: z.array(z.object({
    name: z.string(),
    purpose: z.string(),
    components: z.array(z.string()),
  })),
  dataModel: z.array(z.object({
    entity: z.string(),
    fields: z.array(z.object({ name: z.string(), type: z.string() })),
  })),
  integrations: z.array(z.string()),
  milestones: z.array(z.object({
    title: z.string(),
    tasks: z.array(z.string()),
  })),
  estimate: z.object({
    screens: z.number(),
    entities: z.number(),
    complexity: z.enum(['low', 'medium', 'high']),
  }),
});

const STACK_BY_PLATFORM = {
  web: { frontend: 'Next.js (React)', backend: 'Express.js', database: 'PostgreSQL', hosting: 'Docker / Vercel' },
  mobile: { frontend: 'React Native (Expo)', backend: 'Express.js', database: 'PostgreSQL', hosting: 'EAS / Docker' },
  landing: { frontend: 'Next.js (static export)', backend: '—', database: '—', hosting: 'Vercel / CDN' },
};

// coreFeature keyword → the page(s) it implies.
const FEATURE_PAGES = [
  { match: /auth|autentica|sesi[oó]n|login|registro|cuenta|usuarios?/i, pages: [
    { name: 'Login', purpose: 'Inicio de sesión', components: ['form', 'oauth-buttons'] },
    { name: 'Registro', purpose: 'Alta de usuarios', components: ['form', 'validation'] },
  ] },
  { match: /pago|payment|checkout|suscrip|precio|pricing/i, pages: [
    { name: 'Checkout', purpose: 'Procesar pagos', components: ['pricing-table', 'payment-form'] },
  ] },
  { match: /panel|dashboard|control|m[eé]tricas|admin/i, pages: [
    { name: 'Dashboard', purpose: 'Panel de control con KPIs', components: ['kpi-cards', 'charts', 'table'] },
  ] },
  { match: /b[uú]squeda|search|filtr/i, pages: [
    { name: 'Búsqueda', purpose: 'Buscar y filtrar', components: ['search-bar', 'filters', 'results-list'] },
  ] },
  { match: /notif/i, pages: [
    { name: 'Notificaciones', purpose: 'Centro de notificaciones', components: ['notification-list', 'badges'] },
  ] },
  { match: /chat|mensaj|messaging/i, pages: [
    { name: 'Chat', purpose: 'Mensajería en tiempo real', components: ['message-list', 'composer', 'presence'] },
  ] },
];

// Field name → inferred type. First match wins.
const FIELD_TYPE_RULES = [
  { match: /(^|_)id$/i, type: 'id' },
  { match: /email|correo/i, type: 'email' },
  { match: /url|enlace|link|web/i, type: 'url' },
  { match: /(fecha|date|_at$|created|updated|nacimiento)/i, type: 'datetime' },
  { match: /(precio|price|monto|amount|total|costo|cost|salario)/i, type: 'decimal' },
  { match: /(cantidad|count|qty|stock|edad|numero|n[uú]mero|orden)/i, type: 'integer' },
  { match: /(activo|enabled|is[_A-Z]|tiene|has[_A-Z]|verificado)/i, type: 'boolean' },
  { match: /(descripci[oó]n|description|nota|notes|comentario|body|contenido|texto)/i, type: 'text' },
  { match: /(tel[eé]fono|phone|celular|movil)/i, type: 'phone' },
];

function inferFieldType(name) {
  for (const rule of FIELD_TYPE_RULES) {
    if (rule.match.test(name)) return rule.type;
  }
  return 'string';
}

function landingPage(brief) {
  return {
    name: brief.platform === 'landing' ? 'Landing' : 'Home',
    purpose: brief.purpose ? `Presentar: ${brief.purpose}`.slice(0, 120) : 'Página de inicio',
    components: ['hero', 'features', 'cta'],
  };
}

function pagesFromBrief(brief) {
  const pages = [landingPage(brief)];

  for (const feature of brief.coreFeatures) {
    const rule = FEATURE_PAGES.find((r) => r.match.test(feature));
    if (rule) {
      for (const p of rule.pages) {
        if (!pages.some((existing) => existing.name === p.name)) pages.push({ ...p, components: [...p.components] });
      }
    }
  }

  // Landing pages stay single-purpose; apps get a CRUD surface per entity.
  if (brief.platform !== 'landing') {
    for (const entity of brief.dataEntities) {
      const label = entity.name;
      pages.push({ name: `${label} · Lista`, purpose: `Listar ${label}`, components: ['table', 'pagination', 'filters'] });
      pages.push({ name: `${label} · Detalle`, purpose: `Crear/editar ${label}`, components: ['form', 'validation'] });
    }
  }
  return pages;
}

function dataModelFromBrief(brief) {
  return brief.dataEntities.map((entity) => {
    const declared = (entity.fields || []).map((name) => ({ name, type: inferFieldType(name) }));
    // Every entity gets an id + timestamps if not already declared.
    const fields = [];
    if (!declared.some((f) => /(^|_)id$/i.test(f.name))) fields.push({ name: 'id', type: 'id' });
    fields.push(...declared);
    if (!declared.some((f) => /created/i.test(f.name))) fields.push({ name: 'createdAt', type: 'datetime' });
    return { entity: entity.name, fields };
  });
}

function milestonesFromBrief(brief, pages, dataModel) {
  const milestones = [
    { title: 'Setup & scaffolding', tasks: [
      `Inicializar proyecto ${STACK_BY_PLATFORM[brief.platform].frontend}`,
      'Configurar linter, formato y CI',
      'Configurar variables de entorno',
    ] },
  ];

  if (dataModel.length > 0) {
    milestones.push({ title: 'Modelo de datos & migraciones', tasks: dataModel.map((m) => `Crear modelo/migración "${m.entity}" (${m.fields.length} campos)`) });
  }

  milestones.push({ title: 'Pantallas & funcionalidades', tasks: pages.map((p) => `Construir pantalla "${p.name}" — ${p.purpose}`) });

  if (brief.integrations.length > 0) {
    milestones.push({ title: 'Integraciones', tasks: brief.integrations.map((i) => `Integrar ${i}`) });
  }

  milestones.push({ title: 'Estilo & pulido', tasks: [
    `Aplicar tema visual "${brief.style.theme || 'por definir'}"`,
    'Responsive y accesibilidad',
    ...(brief.style.refs.length ? [`Inspirarse en referencias: ${brief.style.refs.join(', ')}`] : []),
  ] });

  milestones.push({ title: 'QA & despliegue', tasks: [
    'Pruebas de los flujos principales',
    `Desplegar en ${STACK_BY_PLATFORM[brief.platform].hosting}`,
  ] });

  return milestones;
}

function estimate(pages, dataModel) {
  const screens = pages.length;
  const entities = dataModel.length;
  const weight = screens + entities * 1.5;
  const complexity = weight <= 4 ? 'low' : weight <= 9 ? 'medium' : 'high';
  return { screens, entities, complexity };
}

/**
 * Build a deterministic blueprint from a ProjectBrief.
 * @param {object} rawBrief — must satisfy ProjectBriefSchema.
 * @returns {import('zod').infer<typeof BlueprintSchema>}
 */
function planFromBrief(rawBrief) {
  const parsedBrief = ProjectBriefSchema.safeParse(rawBrief);
  if (!parsedBrief.success) {
    throw new Error(`blueprint: invalid ProjectBrief: ${parsedBrief.error.message}`);
  }
  const brief = parsedBrief.data;

  const stack = STACK_BY_PLATFORM[brief.platform];
  const pages = pagesFromBrief(brief);
  const dataModel = dataModelFromBrief(brief);
  const milestones = milestonesFromBrief(brief, pages, dataModel);

  const blueprint = {
    stack,
    pages,
    dataModel,
    integrations: [...brief.integrations],
    milestones,
    estimate: estimate(pages, dataModel),
  };

  const parsed = BlueprintSchema.safeParse(blueprint);
  if (!parsed.success) {
    throw new Error(`blueprint: assembled plan failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

module.exports = {
  BlueprintSchema,
  planFromBrief,
  // exported for reuse / inspection
  inferFieldType,
  STACK_BY_PLATFORM,
};
