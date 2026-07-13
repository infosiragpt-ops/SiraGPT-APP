'use strict';

const { buildPptxDeckManifest } = require('./pptx-prompt-contract');

function clean(value, max = 260) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max).trimEnd();
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > 80 ? boundary : clipped.length).trimEnd()}…`;
}

function normalize(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function sourceLabel(source = {}, index = 0) {
  const explicit = clean(source.label, 20).toUpperCase();
  return /^S\d{1,2}$/.test(explicit) ? `[${explicit}]` : `[S${index + 1}]`;
}

function sourceIdentity(source = {}, label = '') {
  const details = [];
  if (source.year) details.push(`Año: ${source.year}.`);
  if (source.journal) details.push(`Revista: ${clean(source.journal, 90)}.`);
  if (source.studyType) details.push(`Diseño reportado: ${clean(source.studyType, 70)}.`);
  if (source.sampleSize) details.push(`Muestra reportada: ${clean(source.sampleSize, 80)}.`);
  return `${label} ${clean(source.title, 120)}. ${details.join(' ')}`.trim();
}

function reportedFinding(source = {}, label = '') {
  const finding = clean(source.keyFinding, 210);
  if (finding) return `${label} Hallazgo reportado: ${finding}`;
  return `${label} El hallazgo principal no está disponible en los metadatos recuperados; se requiere consultar el texto completo.`;
}

function sectionKind(title = '') {
  const value = normalize(title);
  if (/metod|busqueda|fuente|seleccion|obtuv|alcance/.test(value)) return 'method';
  if (/hallazgo|resultado|evidencia|sintesis/.test(value)) return 'finding';
  if (/limit|sesgo|calidad|certeza/.test(value)) return 'limitations';
  if (/implic|aplica|practic|recomend/.test(value)) return 'implications';
  if (/conclu|cierre|proximo|decision/.test(value)) return 'conclusion';
  return 'context';
}

function sectionSummary(kind) {
  if (kind === 'method') return 'La trazabilidad se limita a las fuentes seleccionadas y a sus metadatos recuperados. Este archivo no se presenta como una revisión sistemática.';
  if (kind === 'finding') return 'Los puntos siguientes reproducen hallazgos reportados por las fuentes. Los datos ausentes se declaran sin completarlos por inferencia.';
  if (kind === 'limitations') return 'La interpretación distingue lo reportado de lo no disponible y exige revisar el texto completo antes de tomar decisiones.';
  if (kind === 'implications') return 'La aplicabilidad depende de población, diseño y contexto. No se atribuyen efectos que las fuentes seleccionadas no reportan.';
  if (kind === 'conclusion') return 'La conclusión se restringe a los hallazgos explícitos y mantiene visibles las limitaciones de la evidencia disponible.';
  return 'El contexto se construye únicamente con las fuentes seleccionadas y sus metadatos verificables.';
}

function evidenceForSection(sources, sectionIndex) {
  if (!sources.length) return [];
  const limit = Math.min(4, sources.length);
  const start = (sectionIndex * limit) % sources.length;
  return Array.from({ length: limit }, (_, offset) => sources[(start + offset) % sources.length]);
}

function bulletFor(source, kind, index) {
  const label = sourceLabel(source, index);
  if (kind === 'finding' || kind === 'implications' || kind === 'conclusion') {
    return { label: `${label} ${clean(source.title, 55)}`, text: reportedFinding(source, label) };
  }
  if (kind === 'limitations') {
    const availability = [
      source.studyType ? `diseño ${clean(source.studyType, 55)}` : 'diseño no reportado',
      source.sampleSize ? `muestra ${clean(source.sampleSize, 55)}` : 'muestra no reportada',
      source.keyFinding ? 'hallazgo disponible' : 'hallazgo no disponible',
    ].join('; ');
    return { label: `${label} Campos disponibles`, text: `${label} ${availability}.` };
  }
  return { label: `${label} ${clean(source.title, 55)}`, text: sourceIdentity(source, label) };
}

function buildGroundedResearchPptxPlan({
  title,
  sections = [],
  slideTarget,
  researchSources = [],
  referenceBriefs = [],
} = {}) {
  const sources = (Array.isArray(researchSources) ? researchSources : [])
    .filter((source) => source && source.title)
    .slice(0, 12);
  const references = (Array.isArray(referenceBriefs) ? referenceBriefs : [])
    .map((reference) => ({ name: clean(reference?.name, 100), excerpt: clean(reference?.excerpt, 300) }))
    .filter((reference) => reference.name);
  const manifest = buildPptxDeckManifest({ slideTarget, references });
  const requestedSections = (Array.isArray(sections) ? sections : []).map((section) => clean(section, 70)).filter(Boolean);
  const slideTitles = requestedSections.slice(0, manifest.contentSlides);
  while (slideTitles.length < manifest.contentSlides) {
    slideTitles.push(`Evidencia complementaria ${slideTitles.length + 1}`);
  }

  const slides = slideTitles.map((slideTitle, sectionIndex) => {
    const kind = sectionKind(slideTitle);
    const selected = evidenceForSection(sources, sectionIndex);
    const bullets = selected.map((source, sourceIndex) => bulletFor(source, kind, sourceIndex));
    const citations = selected.map((source, sourceIndex) => sourceLabel(source, sourceIndex));
    const summary = sectionSummary(kind);
    const useColumns = sectionIndex % 2 === 1 && bullets.length >= 1;
    const midpoint = Math.max(1, Math.ceil(bullets.length / 2));
    return {
      layout: useColumns ? 'two_column' : 'bullets',
      title: slideTitle,
      kicker: kind === 'finding' ? 'Evidencia reportada' : kind === 'method' ? 'Trazabilidad' : 'Síntesis verificable',
      summary,
      bullets,
      columns: useColumns ? [
        { heading: 'Fuentes', items: bullets.slice(0, midpoint).map((bullet) => bullet.text) },
        {
          heading: 'Evidencia y límites',
          items: bullets.slice(midpoint).map((bullet) => bullet.text).length
            ? bullets.slice(midpoint).map((bullet) => bullet.text)
            : ['Revisar el texto completo antes de ampliar la interpretación o tomar decisiones.'],
        },
      ] : undefined,
      takeaway: summary,
      notes: `Presentar solo la información atribuida a ${citations.join(', ')} y distinguir cualquier campo no disponible.`,
      sourceCitations: citations,
    };
  });

  return {
    topic: clean(title, 160) || 'Síntesis científica',
    source: 'research:evidence-grounded',
    thesis: 'Síntesis limitada a la evidencia seleccionada, con trazabilidad y ausencia explícita de datos no reportados.',
    agenda: slides.map((slide) => slide.title).slice(0, 10),
    slides,
    references,
    manifest,
  };
}

module.exports = {
  buildGroundedResearchPptxPlan,
  INTERNAL: {
    bulletFor,
    clean,
    reportedFinding,
    sectionKind,
    sectionSummary,
    sourceIdentity,
    sourceLabel,
  },
};
