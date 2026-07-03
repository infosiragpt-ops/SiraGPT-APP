'use strict';

/**
 * pptx-deck-designer — planner LLM de presentaciones nivel "Cowork".
 *
 * El planner heurístico (pptx-content-planner) produce slides correctas pero
 * planas: un solo layout, bullets largos heredados del documento y métricas
 * decorativas. Este módulo le pide a un modelo barato (gpt-4o-mini por
 * defecto, DOC_CONTENT_MODEL para override) un GUION DE DECK real:
 *
 *   - 8–10 láminas con layouts variados (section / bullets / two_column /
 *     stat / quote / chart) y UNA idea por lámina.
 *   - Títulos ≤ 8 palabras, bullets ≤ 12 palabras, notas de orador siempre.
 *   - Prohibido inventar cifras: los números solo pueden venir del material
 *     adjunto o ser conocimiento general atribuible; si no hay datos, la
 *     lámina usa un layout sin números.
 *
 * Fail-open por diseño: cualquier error (sin key, timeout, JSON inválido)
 * devuelve null y el caller usa el planner heurístico. En NODE_ENV=test no
 * se toca la red salvo opt-in explícito.
 *
 * Cada slide del resultado se normaliza para que TAMBIÉN exponga la forma
 * legada { title, kicker, summary, bullets, notes } — así la vista previa
 * HTML y cualquier consumidor existente siguen funcionando sin cambios.
 */

const { resolveContentClient } = require('./content/llm-client');

const MAX_SLIDES = 10;
const VALID_LAYOUTS = new Set(['section', 'bullets', 'two_column', 'stat', 'quote', 'chart']);

function clean(value, max = 200) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function cleanBullet(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') {
    const text = clean(raw.text || raw.value || '', 110);
    if (!text) return null;
    return { label: clean(raw.label || '', 28), text };
  }
  const text = clean(raw, 120);
  if (!text) return null;
  const match = text.match(/^([^:.;]{3,28})[:：]\s+(.+)$/);
  if (!match) return { label: '', text };
  return { label: clean(match[1], 28), text: clean(match[2], 110) };
}

function sanitizeChart(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const labels = (Array.isArray(raw.labels) ? raw.labels : []).map((l) => clean(l, 22)).filter(Boolean).slice(0, 6);
  const values = (Array.isArray(raw.values) ? raw.values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .slice(0, labels.length);
  if (labels.length < 2 || values.length !== labels.length) return null;
  return {
    title: clean(raw.title || 'Datos clave', 60),
    labels,
    values,
    unit: clean(raw.unit || '', 16),
    source: clean(raw.source || '', 90),
  };
}

function legacyShape(slide) {
  // Forma legada para la vista previa HTML y consumidores existentes.
  const bullets = [];
  if (Array.isArray(slide.bullets)) bullets.push(...slide.bullets);
  if (Array.isArray(slide.support)) bullets.push(...slide.support.map((text) => ({ label: '', text })));
  if (Array.isArray(slide.columns)) {
    for (const column of slide.columns) {
      for (const item of column.items || []) bullets.push({ label: column.heading || '', text: item });
    }
  }
  let summary = slide.summary || '';
  if (!summary && slide.stat) summary = `${slide.stat.value} — ${slide.stat.caption}`;
  if (!summary && slide.quote) summary = `“${slide.quote}” — ${slide.attribution || ''}`;
  if (!summary && slide.insight) summary = slide.insight;
  return { ...slide, summary: clean(summary, 280), bullets: bullets.slice(0, 5) };
}

function sanitizeDeck(raw, { title }) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.slides)) return null;
  const slides = [];
  for (const rawSlide of raw.slides.slice(0, MAX_SLIDES)) {
    if (!rawSlide || typeof rawSlide !== 'object') continue;
    const layout = VALID_LAYOUTS.has(String(rawSlide.layout)) ? String(rawSlide.layout) : 'bullets';
    const slide = {
      layout,
      title: clean(rawSlide.title || '', 64),
      kicker: clean(rawSlide.kicker || '', 40),
      notes: clean(rawSlide.notes || '', 400),
      takeaway: clean(rawSlide.takeaway || rawSlide.insight || '', 120),
    };
    if (layout === 'bullets' || layout === 'section') {
      slide.summary = clean(rawSlide.summary || '', 220);
      slide.bullets = (Array.isArray(rawSlide.bullets) ? rawSlide.bullets : []).map(cleanBullet).filter(Boolean).slice(0, 4);
      if (layout === 'bullets' && slide.bullets.length === 0 && !slide.summary) continue;
    } else if (layout === 'two_column') {
      const columns = (Array.isArray(rawSlide.columns) ? rawSlide.columns : []).slice(0, 2).map((column) => ({
        heading: clean(column?.heading || '', 36),
        items: (Array.isArray(column?.items) ? column.items : []).map((item) => clean(item, 90)).filter(Boolean).slice(0, 4),
      })).filter((column) => column.items.length > 0);
      if (columns.length < 2) continue;
      slide.columns = columns;
    } else if (layout === 'stat') {
      const value = clean(rawSlide.stat?.value || '', 18);
      const caption = clean(rawSlide.stat?.caption || '', 140);
      if (!value || !caption) continue;
      slide.stat = { value, caption };
      slide.support = (Array.isArray(rawSlide.support) ? rawSlide.support : []).map((item) => clean(item, 100)).filter(Boolean).slice(0, 3);
    } else if (layout === 'quote') {
      const quote = clean(rawSlide.quote || '', 220);
      if (!quote) continue;
      slide.quote = quote;
      slide.attribution = clean(rawSlide.attribution || '', 80);
    } else if (layout === 'chart') {
      const chart = sanitizeChart(rawSlide.chart);
      if (!chart) continue;
      slide.chart = chart;
      slide.insight = clean(rawSlide.insight || '', 160);
    }
    if (!slide.title && layout !== 'quote') continue;
    slides.push(legacyShape(slide));
  }
  if (slides.length < 5) return null;
  const deckTitle = clean(raw.deckTitle || title || 'Presentación', 80);
  return {
    topic: deckTitle,
    source: 'llm:deck-designer',
    thesis: clean(raw.thesis || '', 200) || `${deckTitle}: decisiones y acciones clave.`,
    agenda: slides.filter((slide) => slide.layout !== 'section' && slide.layout !== 'quote').map((slide) => slide.title).filter(Boolean).slice(0, 7),
    slides,
    references: [],
  };
}

async function planPptxDeckWithLLM({ title = '', prompt = '', blocks = [], referenceBriefs = [], signal } = {}) {
  if (String(process.env.NODE_ENV) === 'test' && process.env.SIRAGPT_PPTX_DESIGNER_NETWORK !== '1') return null;
  if (String(process.env.SIRAGPT_PPTX_DECK_DESIGNER || '').trim() === '0') return null;
  const _resolved = resolveContentClient();
  if (!_resolved) return null;
  try {
    const client = _resolved.client;
    const material = [
      ...(Array.isArray(blocks) ? blocks : []).slice(0, 8).map((block) => `## ${block.section || 'Sección'}\n${clean(block.paragraph || '', 500)}\n${(block.bullets || []).slice(0, 5).map((b) => `- ${clean(typeof b === 'string' ? b : b?.text || '', 160)}`).join('\n')}`),
      ...(Array.isArray(referenceBriefs) ? referenceBriefs : []).slice(0, 4).map((ref) => `## Referencia: ${ref.name}\n${clean(ref.excerpt || '', 400)}`),
    ].join('\n\n').slice(0, 9000);

    const completion = await client.chat.completions.create({
      model: _resolved.model,
      response_format: { type: 'json_object' },
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: [
            'Eres un diseñador senior de presentaciones ejecutivas (nivel consultora top).',
            'Devuelve SOLO JSON válido con el guion de un deck profesional en español.',
            'Reglas de oro:',
            '- 8 a 10 láminas. UNA idea por lámina. Títulos de máximo 8 palabras.',
            '- Bullets de máximo 12 palabras, concretos y accionables. Nada de párrafos.',
            '- Varía los layouts: "section" (divisor), "bullets", "two_column", "stat" (una cifra protagonista), "quote", "chart".',
            '- PROHIBIDO inventar estadísticas. Usa cifras SOLO si están en el material o son conocimiento general atribuible; si no hay datos, usa layouts sin números.',
            '- Incluye EXACTAMENTE una lámina "chart". Si no hay datos reales, su gráfico debe describir la estructura del propio plan (p.ej. peso relativo de los ejes propuestos) con source:"estructura de la presentación".',
            '- Cada lámina lleva "notes": 2-3 frases de guion para el orador.',
            '- La última lámina es un cierre accionable (layout bullets, próximos pasos con dueño/criterio).',
            'Esquema: {"deckTitle":string,"thesis":string,"slides":[{"layout":"section|bullets|two_column|stat|quote|chart","title":string,"kicker":string,"summary":string?,"bullets":[{"label":string?,"text":string}]?,"columns":[{"heading":string,"items":[string]}]?,"stat":{"value":string,"caption":string}?,"support":[string]?,"quote":string?,"attribution":string?,"chart":{"title":string,"labels":[string],"values":[number],"unit":string?,"source":string}?,"insight":string?,"takeaway":string?,"notes":string}]}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Petición del usuario: ${clean(prompt || title, 400)}`,
            `Título de trabajo: ${clean(title, 120)}`,
            material ? `Material disponible:\n${material}` : 'Sin material adjunto: usa conocimiento general sólido del tema, sin cifras inventadas.',
          ].join('\n\n'),
        },
      ],
    }, signal ? { signal } : undefined);

    const rawText = completion?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(rawText);
    return sanitizeDeck(parsed, { title });
  } catch (err) {
    console.warn('[pptx-deck-designer] fail-open al planner heurístico:', err?.message || err);
    return null;
  }
}

module.exports = {
  planPptxDeckWithLLM,
  sanitizeDeck,
  _internals: { cleanBullet, sanitizeChart, legacyShape },
};
