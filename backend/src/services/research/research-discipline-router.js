'use strict';

/**
 * Deterministic discipline routing for scientific retrieval.
 *
 * The router deliberately changes priority, never coverage: specialist
 * indexes are queried first while every configured general index remains in
 * the plan. Controlled terms are only added when a matching concept appears
 * in the user's request, which avoids turning a broad career label into an
 * unrelated query expansion.
 */

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DISCIPLINES = Object.freeze([
  {
    id: 'health_sciences',
    label: 'Ciencias de la salud',
    aliases: ['health', 'medicine', 'medical', 'medicina', 'salud', 'nursing', 'enfermeria', 'odontologia'],
    keywords: [
      ['clinical', 3], ['clinico', 3], ['patient', 3], ['paciente', 3], ['hospital', 3],
      ['hypertension', 4], ['hipertension', 4], ['diabetes', 4], ['cancer', 4],
      ['epidemiology', 4], ['epidemiologia', 4], ['public health', 4], ['salud publica', 4],
      ['randomized controlled trial', 4], ['ensayo clinico', 4], ['preeclampsia', 4],
    ],
    providers: ['pubmed', 'europepmc', 'openalex', 'crossref', 'semantic', 'doaj', 'scielo', 'core', 'medrxiv', 'biorxiv', 'wos', 'scopus', 'redalyc', 'datacite', 'arxiv', 'dblp'],
    vocabulary: [
      { triggers: ['hypertension', 'hipertension'], terms: ['arterial hypertension', 'high blood pressure'] },
      { triggers: ['blood pressure monitoring', 'monitoreo de presion arterial'], terms: ['self-measured blood pressure', 'home blood pressure monitoring', 'blood pressure telemonitoring'] },
      { triggers: ['diabetes'], terms: ['diabetes mellitus', 'glycemic control'] },
      { triggers: ['cancer'], terms: ['neoplasms', 'oncology'] },
      { triggers: ['preeclampsia'], terms: ['pre-eclampsia', 'hypertensive disorders of pregnancy'] },
    ],
  },
  {
    id: 'computer_science',
    label: 'Computacion e informatica',
    aliases: ['computer science', 'computacion', 'informatica', 'software engineering', 'ingenieria de software'],
    keywords: [
      ['software', 3], ['algorithm', 3], ['algoritmo', 3], ['programming', 3], ['programacion', 3],
      ['artificial intelligence', 4], ['inteligencia artificial', 4], ['machine learning', 4],
      ['cybersecurity', 4], ['ciberseguridad', 4], ['database', 3], ['base de datos', 3],
      ['computer vision', 4], ['natural language processing', 4],
    ],
    providers: ['dblp', 'semantic', 'arxiv', 'openalex', 'crossref', 'core', 'doaj', 'datacite', 'wos', 'scopus', 'scielo', 'redalyc', 'biorxiv', 'medrxiv', 'pubmed', 'europepmc'],
    vocabulary: [
      { triggers: ['artificial intelligence', 'inteligencia artificial'], terms: ['machine learning', 'deep learning'] },
      { triggers: ['cybersecurity', 'ciberseguridad'], terms: ['computer security', 'information security'] },
      { triggers: ['natural language processing', 'procesamiento de lenguaje natural'], terms: ['computational linguistics', 'language models'] },
      { triggers: ['software engineering', 'ingenieria de software'], terms: ['software development', 'software quality'] },
    ],
  },
  {
    id: 'engineering',
    label: 'Ingenieria',
    aliases: ['engineering', 'ingenieria', 'civil engineering', 'mechanical engineering', 'electrical engineering'],
    keywords: [
      ['engineering', 4], ['ingenieria', 4], ['concrete', 3], ['concreto', 3], ['structural', 3],
      ['mechanical', 3], ['mecanica', 3], ['electrical', 3], ['electrica', 3],
      ['construction', 3], ['construccion', 3], ['manufacturing', 3], ['manufactura', 3],
    ],
    providers: ['arxiv', 'semantic', 'openalex', 'crossref', 'core', 'doaj', 'datacite', 'wos', 'scopus', 'dblp', 'scielo', 'redalyc', 'biorxiv', 'medrxiv', 'pubmed', 'europepmc'],
    vocabulary: [
      { triggers: ['concrete', 'concreto'], terms: ['reinforced concrete', 'concrete durability'] },
      { triggers: ['construction', 'construccion'], terms: ['construction engineering', 'built environment'] },
      { triggers: ['renewable energy', 'energia renovable'], terms: ['clean energy', 'sustainable energy systems'] },
    ],
  },
  {
    id: 'education',
    label: 'Educacion',
    aliases: ['education', 'educacion', 'pedagogy', 'pedagogia', 'teaching', 'docencia'],
    keywords: [
      ['education', 4], ['educacion', 4], ['student', 3], ['estudiante', 3], ['teacher', 3],
      ['docente', 3], ['learning', 3], ['aprendizaje', 3], ['school', 3], ['escuela', 3],
      ['university', 3], ['universidad', 3], ['curriculum', 3],
    ],
    providers: ['openalex', 'scielo', 'redalyc', 'crossref', 'doaj', 'semantic', 'core', 'wos', 'scopus', 'datacite', 'arxiv', 'dblp', 'pubmed', 'europepmc', 'biorxiv', 'medrxiv'],
    vocabulary: [
      { triggers: ['higher education', 'educacion superior', 'university', 'universidad'], terms: ['tertiary education', 'college students'] },
      { triggers: ['learning', 'aprendizaje'], terms: ['student learning', 'learning outcomes'] },
      { triggers: ['teacher', 'docente'], terms: ['teachers', 'teacher education'] },
    ],
  },
  {
    id: 'psychology',
    label: 'Psicologia',
    aliases: ['psychology', 'psicologia', 'behavioral science', 'ciencias del comportamiento'],
    keywords: [
      ['psychology', 4], ['psicologia', 4], ['mental health', 4], ['salud mental', 4],
      ['behavior', 3], ['behaviour', 3], ['conducta', 3], ['cognition', 3], ['cognicion', 3],
      ['anxiety', 4], ['ansiedad', 4], ['depression', 4], ['depresion', 4],
    ],
    providers: ['semantic', 'openalex', 'pubmed', 'europepmc', 'crossref', 'scielo', 'redalyc', 'doaj', 'core', 'wos', 'scopus', 'datacite', 'arxiv', 'medrxiv', 'biorxiv', 'dblp'],
    vocabulary: [
      { triggers: ['mental health', 'salud mental'], terms: ['psychological well-being', 'mental disorders'] },
      { triggers: ['anxiety', 'ansiedad'], terms: ['anxiety disorders', 'anxiety symptoms'] },
      { triggers: ['depression', 'depresion'], terms: ['depressive disorder', 'depressive symptoms'] },
    ],
  },
  {
    id: 'business_economics',
    label: 'Negocios y economia',
    aliases: ['business', 'management', 'economics', 'economia', 'administracion', 'gestion empresarial', 'finance', 'finanzas'],
    keywords: [
      ['business', 3], ['empresa', 3], ['management', 3], ['gestion', 3], ['administracion', 3],
      ['economics', 4], ['economia', 4], ['finance', 4], ['finanzas', 4], ['marketing', 3],
      ['productivity', 3], ['productividad', 3], ['entrepreneurship', 4], ['emprendimiento', 4],
    ],
    providers: ['openalex', 'crossref', 'scielo', 'redalyc', 'doaj', 'semantic', 'core', 'wos', 'scopus', 'datacite', 'arxiv', 'dblp', 'pubmed', 'europepmc', 'biorxiv', 'medrxiv'],
    vocabulary: [
      { triggers: ['management', 'gestion', 'administracion'], terms: ['organizational management', 'management practices'] },
      { triggers: ['productivity', 'productividad'], terms: ['firm performance', 'organizational performance'] },
      { triggers: ['entrepreneurship', 'emprendimiento'], terms: ['entrepreneurial activity', 'new ventures'] },
    ],
  },
  {
    id: 'law_public_policy',
    label: 'Derecho y politicas publicas',
    aliases: ['law', 'legal', 'derecho', 'juridico', 'politica publica', 'public policy'],
    keywords: [
      ['law', 4], ['legal', 4], ['derecho', 4], ['juridico', 4], ['legislation', 4],
      ['legislacion', 4], ['public policy', 4], ['politica publica', 4], ['regulation', 3],
      ['regulacion', 3], ['constitutional', 3], ['constitucional', 3],
    ],
    providers: ['scielo', 'redalyc', 'openalex', 'crossref', 'doaj', 'core', 'semantic', 'wos', 'scopus', 'datacite', 'arxiv', 'dblp', 'pubmed', 'europepmc', 'biorxiv', 'medrxiv'],
    vocabulary: [
      { triggers: ['public policy', 'politica publica'], terms: ['policy analysis', 'government policy'] },
      { triggers: ['regulation', 'regulacion'], terms: ['regulatory policy', 'legal regulation'] },
      { triggers: ['constitutional', 'constitucional'], terms: ['constitutional law', 'constitutional rights'] },
    ],
  },
  {
    id: 'environment_agriculture',
    label: 'Ambiente y ciencias agrarias',
    aliases: ['environment', 'environmental science', 'ambiente', 'agriculture', 'agricultura', 'agronomia'],
    keywords: [
      ['climate change', 4], ['cambio climatico', 4], ['environment', 3], ['ambiente', 3],
      ['agriculture', 4], ['agricultura', 4], ['crop', 3], ['cultivo', 3], ['water', 3], ['agua', 3],
      ['biodiversity', 4], ['biodiversidad', 4], ['sustainability', 3], ['sostenibilidad', 3],
    ],
    providers: ['openalex', 'scielo', 'redalyc', 'crossref', 'doaj', 'core', 'semantic', 'datacite', 'wos', 'scopus', 'arxiv', 'biorxiv', 'pubmed', 'europepmc', 'medrxiv', 'dblp'],
    vocabulary: [
      { triggers: ['climate change', 'cambio climatico'], terms: ['global warming', 'climate variability'] },
      { triggers: ['agriculture', 'agricultura'], terms: ['agricultural systems', 'crop production'] },
      { triggers: ['water', 'agua'], terms: ['water resources', 'water quality'] },
    ],
  },
  {
    id: 'humanities_social_sciences',
    label: 'Humanidades y ciencias sociales',
    aliases: ['social sciences', 'ciencias sociales', 'humanities', 'humanidades', 'sociology', 'sociologia', 'history', 'historia'],
    keywords: [
      ['social', 2], ['society', 3], ['sociedad', 3], ['sociology', 4], ['sociologia', 4],
      ['culture', 3], ['cultura', 3], ['history', 4], ['historia', 4], ['anthropology', 4],
      ['antropologia', 4], ['gender', 3], ['genero', 3], ['poverty', 3], ['pobreza', 3],
    ],
    providers: ['scielo', 'redalyc', 'openalex', 'crossref', 'doaj', 'core', 'semantic', 'wos', 'scopus', 'datacite', 'arxiv', 'dblp', 'pubmed', 'europepmc', 'biorxiv', 'medrxiv'],
    vocabulary: [
      { triggers: ['gender', 'genero'], terms: ['gender relations', 'gender equity'] },
      { triggers: ['poverty', 'pobreza'], terms: ['socioeconomic inequality', 'social vulnerability'] },
      { triggers: ['culture', 'cultura'], terms: ['cultural studies', 'cultural identity'] },
    ],
  },
]);

const DISCIPLINE_BY_ID = new Map(DISCIPLINES.map((entry) => [entry.id, entry]));
const ALIAS_TO_ID = new Map();
for (const entry of DISCIPLINES) {
  ALIAS_TO_ID.set(normalize(entry.id), entry.id);
  ALIAS_TO_ID.set(normalize(entry.label), entry.id);
  for (const alias of entry.aliases) ALIAS_TO_ID.set(normalize(alias), entry.id);
}

function containsTerm(haystack, term) {
  const value = normalize(term);
  if (!value) return false;
  return ` ${haystack} `.includes(` ${value} `);
}

function controlledTerms(entry, haystack) {
  const out = [];
  const seen = new Set();
  for (const rule of entry.vocabulary || []) {
    if (!rule.triggers.some((trigger) => containsTerm(haystack, trigger))) continue;
    for (const term of rule.terms || []) {
      const key = normalize(term);
      if (!key || seen.has(key) || containsTerm(haystack, term)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out.slice(0, 12);
}

function publicDiscipline(entry, details = {}) {
  return {
    id: entry.id,
    label: entry.label,
    confidence: details.confidence || 'medium',
    score: details.score || 0,
    matchedTerms: details.matchedTerms || [],
    controlledVocabulary: details.controlledVocabulary || [],
    providerPriority: [...entry.providers],
    explicit: Boolean(details.explicit),
  };
}

function routeDiscipline(rawQuery, requested) {
  const haystack = normalize(rawQuery);
  const requestedId = ALIAS_TO_ID.get(normalize(requested));
  if (requestedId) {
    const entry = DISCIPLINE_BY_ID.get(requestedId);
    return publicDiscipline(entry, {
      confidence: 'explicit',
      score: 100,
      matchedTerms: [String(requested)],
      controlledVocabulary: controlledTerms(entry, haystack),
      explicit: true,
    });
  }

  const scored = DISCIPLINES.map((entry) => {
    const matchedTerms = [];
    let score = 0;
    for (const [term, weight] of entry.keywords) {
      if (!containsTerm(haystack, term)) continue;
      matchedTerms.push(term);
      score += weight;
    }
    for (const alias of entry.aliases) {
      if (!containsTerm(haystack, alias)) continue;
      if (!matchedTerms.includes(alias)) matchedTerms.push(alias);
      score += 5;
    }
    return { entry, score, matchedTerms };
  }).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 3) {
    return {
      id: 'general',
      label: 'Multidisciplinaria',
      confidence: 'default',
      score: best?.score || 0,
      matchedTerms: [],
      controlledVocabulary: [],
      providerPriority: [],
      explicit: false,
    };
  }
  const margin = best.score - (second?.score || 0);
  const confidence = best.score >= 8 && margin >= 3 ? 'high' : (best.score >= 4 ? 'medium' : 'low');
  return publicDiscipline(best.entry, {
    confidence,
    score: best.score,
    matchedTerms: best.matchedTerms.slice(0, 12),
    controlledVocabulary: controlledTerms(best.entry, haystack),
  });
}

function orderProvidersForDiscipline(providers, discipline) {
  const available = Array.from(new Set(Array.isArray(providers) ? providers.filter(Boolean) : []));
  if (!discipline || discipline.id === 'general' || !Array.isArray(discipline.providerPriority)) return available;
  const priority = new Map(discipline.providerPriority.map((provider, index) => [provider, index]));
  if (priority.has('semantic') && !priority.has('semanticscholar')) {
    priority.set('semanticscholar', priority.get('semantic'));
  }
  return available
    .map((provider, index) => ({ provider, index, priority: priority.has(provider) ? priority.get(provider) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.provider);
}

module.exports = {
  DISCIPLINES,
  DISCIPLINE_IDS: Object.freeze(DISCIPLINES.map((entry) => entry.id)),
  orderProvidersForDiscipline,
  routeDiscipline,
  _internal: { containsTerm, controlledTerms, normalize },
};
