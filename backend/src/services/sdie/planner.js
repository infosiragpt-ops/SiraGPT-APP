'use strict';

/**
 * Planner — RequestSpec → execution plan.
 *
 * summarize_full ⇒ no top-k. Walk every section, build hierarchical
 * section notes, then one draft. RAG retrieval is never part of this plan.
 */

const { extractDocuments } = require('./extract');

const HEADING_LIKE_RE = /^(?:#{1,6}\s+|\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+)[A-ZÁÉÍÓÚÑ]/;

function sentenceSplit(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !HEADING_LIKE_RE.test(s) && s.length > 24);
}

function compressSection(section, maxSentences = 2) {
  const sentences = sentenceSplit(section.text);
  if (sentences.length === 0) return '';
  return sentences.slice(0, maxSentences).join(' ');
}

function walkSections(docs) {
  const notes = [];
  for (const doc of docs) {
    const sections = Array.isArray(doc.sections) && doc.sections.length
      ? doc.sections
      : [{ heading: doc.name || 'Documento', text: doc.evidenceText || doc.raw || '' }];
    for (const section of sections) {
      const note = compressSection(section, 2);
      if (!note) continue;
      notes.push({
        document: doc.name,
        heading: section.heading,
        note,
        chars: (section.text || '').length,
      });
    }
  }
  return notes;
}

function deterministicDraft(notes, spec) {
  const paragraphsWanted = Number(spec?.output?.paragraphs) > 0
    ? Number(spec.output.paragraphs)
    : 1;
  const pieces = notes.map((n) => n.note).filter(Boolean);
  if (pieces.length === 0) return '';

  if (paragraphsWanted <= 1) {
    return pieces.join(' ').replace(/\s+/g, ' ').trim();
  }

  const per = Math.max(1, Math.ceil(pieces.length / paragraphsWanted));
  const blocks = [];
  for (let i = 0; i < pieces.length && blocks.length < paragraphsWanted; i += per) {
    blocks.push(pieces.slice(i, i + per).join(' ').replace(/\s+/g, ' ').trim());
  }
  return blocks.join('\n\n');
}

function buildPlan(spec, files, opts = {}) {
  const docs = opts.docs || extractDocuments(files, {
    excludeEditorial: spec?.scope?.excludeEditorial !== false,
  });
  const coverage = spec?.scope?.coverage === 'full' || spec?.strategy === 'summarize_full'
    ? 'full'
    : 'targeted';
  const notes = walkSections(docs);
  const editorial = docs.flatMap((d) => d.editorial || []);

  return {
    strategy: spec?.strategy || 'passthrough',
    coverage,
    useTopK: false,
    documents: docs.map((d) => ({
      name: d.name,
      chars: d.chars,
      sections: d.sections.length,
      editorialCount: (d.editorial || []).length,
    })),
    sectionNotes: notes,
    editorial,
    draft: deterministicDraft(notes, spec),
    docs,
  };
}

module.exports = {
  sentenceSplit,
  compressSection,
  walkSections,
  deterministicDraft,
  buildPlan,
};
