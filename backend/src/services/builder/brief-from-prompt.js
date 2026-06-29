'use strict';

/**
 * siraGPT Builder · brief-from-prompt.
 *
 * One-shot, deterministic bridge from a single free-text app description to a
 * validated ProjectBrief — no interview, no LLM, no API keys. It exists so the
 * /code workspace can offer a "Construir app" button that generates a runnable
 * app even when the LLM chat (Opus/keys) is unavailable.
 *
 * The heuristics are intentionally simple and pure: the same prompt always
 * yields byte-identical output. Entity extraction looks for the common Spanish/
 * English "con X, Y, Z" / "para gestionar X" patterns and assigns each entity a
 * small set of sensible default fields (so the live app has real form inputs),
 * with a domain dictionary for the usual suspects (cliente, producto, turno…).
 */

const { ProjectBriefSchema } = require('./contracts');
const { normalisePlatform } = require('./intake-engine');

// Domain → default fields. Keys are lowercased singular forms; the first key
// that the (singularised) entity name contains wins. Gives the generated live
// app meaningful inputs instead of an empty form.
const ENTITY_FIELD_DICTIONARY = [
  { match: ['cliente', 'client', 'customer', 'contacto', 'lead'], fields: ['nombre', 'email', 'telefono'] },
  { match: ['usuario', 'user', 'miembro', 'member'], fields: ['nombre', 'email'] },
  { match: ['turno', 'cita', 'appointment', 'reserva', 'booking', 'evento', 'agenda'], fields: ['fecha', 'hora', 'cliente'] },
  { match: ['producto', 'product', 'articulo', 'item', 'plato', 'menu'], fields: ['nombre', 'precio', 'stock'] },
  { match: ['servicio', 'service', 'corte', 'tratamiento'], fields: ['nombre', 'precio', 'duracion'] },
  { match: ['pedido', 'orden', 'order', 'venta', 'sale', 'compra'], fields: ['cliente', 'fecha', 'total'] },
  { match: ['empleado', 'employee', 'barbero', 'staff', 'trabajador', 'doctor', 'profesor'], fields: ['nombre', 'rol'] },
  { match: ['factura', 'invoice', 'recibo', 'pago', 'payment'], fields: ['numero', 'fecha', 'total'] },
  { match: ['tarea', 'task', 'ticket', 'incidencia'], fields: ['titulo', 'estado'] },
  { match: ['proyecto', 'project', 'curso', 'course'], fields: ['nombre', 'descripcion'] },
  { match: ['post', 'articulo', 'nota', 'noticia', 'blog'], fields: ['titulo', 'contenido'] },
];

const DEFAULT_FIELDS = ['nombre', 'descripcion'];

// Deterministic domain presets. These only fire as a *fallback* — when the
// free-text prompt carries no explicit "con X y Y" entity list — so common
// business asks ("punto de venta", "restaurante", "reservas") yield a real,
// multi-entity data model instead of a single generic "Registro". Order
// matters: the first preset whose `match` hits wins.
const DOMAIN_PRESETS = [
  {
    name: 'comercio',
    // Point-of-sale / retail / commerce. NB: bare "negocio" is intentionally
    // excluded so "una app para mi negocio" still falls through to "Registro".
    match: /\b(punto de venta|caja registradora|tienda|boutique|comercio|e-?commerce|retail|minimarket|abarrotes|bazar|almac[eé]n|inventario|ferreter[ií]a|farmacia|kiosco|librer[ií]a|venta de|ventas de|vender|carrito de compra)\b/i,
    entities() {
      return [
        { name: 'Producto', fields: ['nombre', 'precio', 'stock', 'categoria'] },
        { name: 'Venta', fields: ['cliente', 'fecha', 'total'] },
        { name: 'Cliente', fields: ['nombre', 'telefono', 'email'] },
      ];
    },
    refine(text, entities) {
      // Clothing/fashion stores need size + colour on the product.
      if (/\b(ropa|moda|prenda|prendas|vestimenta|clothing|apparel|fashion|textil|boutique|calzado|zapat)\b/i.test(text)) {
        entities[0].fields = ['nombre', 'precio', 'stock', 'talla', 'color'];
      }
      return entities;
    },
  },
  {
    name: 'restaurante',
    match: /\b(restaurante|restaurant|cafeter[ií]a|cafe|comida|men[uú]|cocina|food truck|pizzer[ií]a|panader[ií]a)\b/i,
    entities() {
      return [
        { name: 'Plato', fields: ['nombre', 'precio', 'categoria'] },
        { name: 'Pedido', fields: ['cliente', 'fecha', 'total'] },
        { name: 'Mesa', fields: ['numero', 'capacidad', 'estado'] },
      ];
    },
  },
  {
    name: 'reservas',
    match: /\b(reservas?|citas?|agenda|appointment|booking|peluquer[ií]a|barber[ií]a|sal[oó]n|cl[ií]nica|consultorio|spa|gimnasio|\bgym\b)\b/i,
    entities() {
      return [
        { name: 'Cliente', fields: ['nombre', 'telefono', 'email'] },
        { name: 'Cita', fields: ['cliente', 'fecha', 'hora', 'servicio'] },
        { name: 'Servicio', fields: ['nombre', 'precio', 'duracion'] },
      ];
    },
  },
];

const DOMAIN_CONTAINER_ENTITIES = new Set([
  'tienda',
  'boutique',
  'comercio',
  'ecommerce',
  'retail',
  'minimarket',
  'abarrote',
  'bazar',
  'almacen',
  'almacén',
  'ferreteria',
  'ferretería',
  'farmacia',
  'kiosco',
  'libreria',
  'librería',
  'restaurante',
  'restaurant',
  'cafeteria',
  'cafetería',
  'cafe',
  'comida',
  'cocina',
  'pizzeria',
  'pizzería',
  'panaderia',
  'panadería',
  'peluqueria',
  'peluquería',
  'barberia',
  'barbería',
  'salon',
  'salón',
  'clinica',
  'clínica',
  'consultorio',
  'spa',
  'gimnasio',
  'gym',
]);

/**
 * Match the prompt against the deterministic domain presets. Returns a curated
 * entity list for the first matching domain, or [] when none match.
 * @returns {Array<{ name: string, fields: string[] }>}
 */
function presetEntities(prompt) {
  const text = clean(prompt);
  for (const preset of DOMAIN_PRESETS) {
    if (preset.match.test(text)) {
      const ents = preset.entities();
      return preset.refine ? preset.refine(text, ents) : ents;
    }
  }
  return [];
}

// coreFeature keyword → human label. Mirrors blueprint's FEATURE_PAGES so the
// derived features actually drive the plan (auth → Login/Registro, etc.).
const FEATURE_RULES = [
  { match: /\b(auth|login|registr|sesi[oó]n|cuenta|usuarios?)\b/i, label: 'Autenticación de usuarios' },
  { match: /\b(pagos?|payments?|checkout|cobr|suscrip|precios?|pricing)\b/i, label: 'Pagos' },
  { match: /\b(panel|dashboard|m[eé]tricas|admin|reporte|estad[ií]stic)\b/i, label: 'Dashboard / panel' },
  { match: /\b(b[uú]squeda|search|filtr|buscar)\b/i, label: 'Búsqueda y filtros' },
  { match: /\b(notif|aviso|alerta|recordatorio)\b/i, label: 'Notificaciones' },
  { match: /\b(chat|mensaj|messaging|soporte)\b/i, label: 'Chat / mensajería' },
];

const STYLE_RULES = [
  { match: /\b(oscuro|dark|editorial|negro)\b/i, theme: 'oscuro' },
  { match: /\b(minimalista|minimal|limpio|sobrio)\b/i, theme: 'minimalista' },
  { match: /\b(corporativo|corporate|empresarial|formal|profesional)\b/i, theme: 'corporativo' },
  { match: /\b(colorido|colorful|vibrante|vivo|alegre)\b/i, theme: 'colorido' },
  { match: /\b(moderno|modern)\b/i, theme: 'moderno' },
];

// Words that look like entities in the grammar but never are.
const ENTITY_STOPWORDS = new Set([
  'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'y', 'e', 'o',
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'su', 'sus', 'mi', 'mis', 'que', 'con',
  'sistema', 'app', 'aplicacion', 'aplicación', 'web', 'pagina', 'página', 'sitio',
  'plataforma', 'gestion', 'gestión', 'administracion', 'administración',
  'base', 'datos', 'backend', 'frontend', 'formato', 'responsive', 'responsivo',
  'adaptable', 'celular', 'movil', 'móvil', 'mobile', 'fullstack', 'stack',
]);

function clean(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function removeDiacritics(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Naive but deterministic Spanish/English singulariser (drop a trailing s). */
function singularize(word) {
  const w = word.toLowerCase();
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function entityKey(name) {
  return singularize(removeDiacritics(name).toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
}

function isDomainContainerEntityList(entities) {
  if (!Array.isArray(entities) || entities.length !== 1) return false;
  return DOMAIN_CONTAINER_ENTITIES.has(entityKey(entities[0].name));
}

function capitalize(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function fieldsForEntity(name) {
  const key = singularize(name).toLowerCase();
  for (const rule of ENTITY_FIELD_DICTIONARY) {
    if (rule.match.some((m) => key.includes(m))) return [...rule.fields];
  }
  return [...DEFAULT_FIELDS];
}

/**
 * Pull entity names out of a free-text description. Looks for the common
 * "con / para gestionar / administrar / entidades: <list>" markers and splits
 * the trailing noun list on commas / "y" / "e" / slashes.
 * @returns {Array<{ name: string, fields: string[] }>}
 */
function extractEntities(prompt) {
  const text = clean(prompt);
  const markers = [
    /\b(?:con|para gestionar|para administrar|para manejar|que gestione|que maneje|que registre|gestionar|administrar|registrar|entidades?(?:\s*:)?)\b/i,
  ];
  let listPart = '';
  for (const re of markers) {
    const m = text.match(re);
    if (m && typeof m.index === 'number') {
      listPart = text.slice(m.index + m[0].length);
      break;
    }
  }
  if (!listPart) return [];

  // Stop the list at the first clause boundary so we don't swallow the rest of
  // the sentence ("con clientes y turnos para mi barbería" → "clientes y turnos").
  listPart = listPart.split(/[.;\n]|#|\b(?:para|porque|usando|con base|base de datos|con backend|con frontend|backend|frontend|formato|responsive|responsivo|adaptable|web y celular|celular|m[oó]vil|mobile|pwa|full[- ]?stack|con un dise|en estilo|tipo|color|colores)\b/i)[0];

  const raw = listPart
    .split(/,|\/|\by\b|\be\b|\band\b|\bor\b|\+/i)
    .map((s) => clean(s).replace(/[^A-Za-zÀ-ÿ0-9 ]/g, ''))
    .map((s) => s.split(' ').filter((w) => w && !ENTITY_STOPWORDS.has(w.toLowerCase())).slice(0, 2).join(' '))
    .map((s) => clean(s))
    .filter(Boolean)
    .filter((s) => s.length >= 3 && s.length <= 28);

  const seen = new Set();
  const entities = [];
  for (const candidate of raw) {
    const name = capitalize(singularize(candidate));
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    entities.push({ name, fields: fieldsForEntity(name) });
    if (entities.length >= 6) break; // keep the app focused
  }
  return entities;
}

function extractFeatures(prompt) {
  const features = [];
  for (const rule of FEATURE_RULES) {
    if (rule.match.test(prompt)) features.push(rule.label);
  }
  return features.length ? features : ['Gestión de registros'];
}

function extractTheme(prompt) {
  const hex = clean(prompt).match(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/i);
  let theme = 'moderno';
  for (const rule of STYLE_RULES) {
    if (rule.match.test(prompt)) {
      theme = rule.theme;
      break;
    }
  }
  return hex ? `${theme} ${hex[0].toUpperCase()}` : theme;
}

function extractAudience(prompt) {
  const m = clean(prompt).match(/\bpara\s+(?:mi\s+|un\s+|una\s+|el\s+|la\s+)?([a-zA-ZÀ-ÿ ]{3,40}?)(?:[.,;]|\b(?:con|que|usando|en)\b|$)/i);
  if (!m) return '';
  const audience = clean(m[1]);
  // "para gestionar X" is a feature/entity marker, not an audience.
  if (/^(gestionar|administrar|manejar|registrar|crear|construir|hacer)\b/i.test(audience)) return '';
  return audience.length <= 40 ? audience : '';
}

/**
 * Derive a validated ProjectBrief from a single free-text description.
 * Deterministic and side-effect-free. Falls back to a sensible generic CRUD
 * app when the prompt carries no extractable entities.
 *
 * @param {string} prompt
 * @returns {import('zod').infer<typeof ProjectBriefSchema>}
 */
function briefFromPrompt(prompt) {
  const text = clean(prompt);
  if (!text) {
    throw new Error('brief-from-prompt: prompt is empty');
  }

  const platform = normalisePlatform(text) || 'web';
  let dataEntities = extractEntities(text);
  const preset = presetEntities(text);

  // A runnable app needs at least one entity to manage. If explicit extraction
  // found nothing, first try a deterministic domain preset (punto de venta,
  // restaurante, reservas…) so a common business ask gets a real multi-entity
  // model; only then fall back to a single generic record (e.g. "una app para
  // mi negocio") so the live preview still renders a working CRUD.
  if ((dataEntities.length === 0 || isDomainContainerEntityList(dataEntities)) && platform !== 'landing') {
    dataEntities = preset.length ? preset : [{ name: 'Registro', fields: [...DEFAULT_FIELDS] }];
  }

  const brief = {
    purpose: text.length > 280 ? `${text.slice(0, 277)}…` : text,
    platform,
    audience: extractAudience(text),
    coreFeatures: extractFeatures(text),
    dataEntities,
    style: { theme: extractTheme(text), refs: [] },
    integrations: [],
    constraints: '',
    openQuestions: [],
  };

  const parsed = ProjectBriefSchema.safeParse(brief);
  if (!parsed.success) {
    throw new Error(`brief-from-prompt: assembled brief failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

module.exports = {
  briefFromPrompt,
  // exported for unit tests / reuse
  presetEntities,
  extractEntities,
  extractFeatures,
  extractTheme,
  extractAudience,
  singularize,
  fieldsForEntity,
};
