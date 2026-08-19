'use strict';

/**
 * scientific-databases-catalog — the curated, honest map of the scientific
 * databases SiraGPT's research search reaches.
 *
 * "access" tells the truth about HOW each source is reached:
 *   - 'direct'    → SiraGPT queries its API directly (a real, separate live call
 *                   in the search fan-out; see scientific-search.js PROVIDERS).
 *   - 'federated' → SiraGPT reaches it THROUGH a mega-aggregator that indexes it
 *                   (OpenAlex ~250k sources, Crossref ~150M works, CORE ~10k+
 *                   repositories, OpenAIRE). We do not call the source's own API,
 *                   but its records surface in results via `via`.
 *
 * This is deliberately NOT a list of fake integrations: the federated entries
 * are genuinely searchable because the aggregators we already call catalog them.
 */

// Keep in sync with scientific-search.js PROVIDERS (the 16 directly-queried).
const DIRECT = [
  { id: 'arxiv', name: 'arXiv', discipline: 'physics/CS/math (preprints)' },
  { id: 'openalex', name: 'OpenAlex', discipline: 'all (index of ~250k sources)' },
  { id: 'semanticscholar', name: 'Semantic Scholar', discipline: 'all' },
  { id: 'crossref', name: 'Crossref', discipline: 'all (~150M works, DOIs)' },
  { id: 'pubmed', name: 'PubMed', discipline: 'biomedicine' },
  { id: 'europepmc', name: 'Europe PMC', discipline: 'life sciences' },
  { id: 'core', name: 'CORE', discipline: 'open access (~10k+ repositories)' },
  { id: 'doaj', name: 'DOAJ', discipline: 'open-access journals (~20k)' },
  { id: 'dblp', name: 'DBLP', discipline: 'computer science' },
  { id: 'datacite', name: 'DataCite', discipline: 'datasets/software/theses' },
  { id: 'scielo', name: 'SciELO', discipline: 'Latin America/Iberia' },
  { id: 'redalyc', name: 'Redalyc', discipline: 'Latin America/Iberia' },
  { id: 'scopus', name: 'Scopus', discipline: 'all (Elsevier)' },
  { id: 'wos', name: 'Web of Science', discipline: 'all (Clarivate)' },
  { id: 'biorxiv', name: 'bioRxiv', discipline: 'biology (preprints)' },
  { id: 'medrxiv', name: 'medRxiv', discipline: 'medicine (preprints)' },
];

// Databases reached via the aggregators we already query. `via` names the route.
const FEDERATED = [
  // Major publishers / journal platforms (indexed by Crossref + OpenAlex)
  { id: 'plos', name: 'PLOS', discipline: 'multidisciplinary (OA)', via: 'crossref' },
  { id: 'nature', name: 'Nature Portfolio', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'springer', name: 'Springer', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'sciencedirect', name: 'ScienceDirect (Elsevier)', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'wiley', name: 'Wiley Online Library', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'ieee', name: 'IEEE Xplore', discipline: 'engineering/CS', via: 'crossref' },
  { id: 'acm', name: 'ACM Digital Library', discipline: 'computer science', via: 'crossref' },
  { id: 'tandf', name: 'Taylor & Francis', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'sage', name: 'SAGE Journals', discipline: 'social sciences', via: 'crossref' },
  { id: 'mdpi', name: 'MDPI', discipline: 'multidisciplinary (OA)', via: 'crossref' },
  { id: 'frontiers', name: 'Frontiers', discipline: 'multidisciplinary (OA)', via: 'crossref' },
  { id: 'hindawi', name: 'Hindawi', discipline: 'multidisciplinary (OA)', via: 'crossref' },
  { id: 'cambridge', name: 'Cambridge Core', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'oxford', name: 'Oxford Academic', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'jstor', name: 'JSTOR', discipline: 'humanities/social sciences', via: 'openalex' },
  { id: 'bmj', name: 'BMJ', discipline: 'medicine', via: 'crossref' },
  { id: 'cell', name: 'Cell Press', discipline: 'life sciences', via: 'crossref' },
  { id: 'pnas', name: 'PNAS', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'aaas', name: 'Science (AAAS)', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'lancet', name: 'The Lancet', discipline: 'medicine', via: 'crossref' },
  { id: 'acs', name: 'ACS Publications', discipline: 'chemistry', via: 'crossref' },
  { id: 'rsc', name: 'Royal Society of Chemistry', discipline: 'chemistry', via: 'crossref' },
  { id: 'aps', name: 'APS (Physical Review)', discipline: 'physics', via: 'crossref' },
  { id: 'iop', name: 'IOP Publishing', discipline: 'physics', via: 'crossref' },
  { id: 'emerald', name: 'Emerald Insight', discipline: 'business/management', via: 'crossref' },
  // Repositories / preprint servers (indexed by OpenAlex/CORE)
  { id: 'pmc', name: 'PubMed Central', discipline: 'biomedicine (OA)', via: 'openalex' },
  { id: 'zenodo', name: 'Zenodo', discipline: 'datasets/software/all', via: 'openalex' },
  { id: 'figshare', name: 'Figshare', discipline: 'datasets/figures', via: 'datacite' },
  { id: 'dryad', name: 'Dryad', discipline: 'research data', via: 'datacite' },
  { id: 'hal', name: 'HAL (France)', discipline: 'multidisciplinary', via: 'openalex' },
  { id: 'ssrn', name: 'SSRN', discipline: 'social sciences (preprints)', via: 'crossref' },
  { id: 'repec', name: 'RePEc / EconPapers', discipline: 'economics', via: 'openalex' },
  { id: 'inspirehep', name: 'INSPIRE-HEP', discipline: 'high-energy physics', via: 'crossref' },
  { id: 'ads', name: 'NASA ADS', discipline: 'astrophysics', via: 'openalex' },
  { id: 'chemrxiv', name: 'ChemRxiv', discipline: 'chemistry (preprints)', via: 'crossref' },
  { id: 'psyarxiv', name: 'PsyArXiv', discipline: 'psychology (preprints)', via: 'openalex' },
  { id: 'socarxiv', name: 'SocArXiv', discipline: 'social sciences (preprints)', via: 'openalex' },
  { id: 'eartharxiv', name: 'EarthArXiv', discipline: 'geosciences (preprints)', via: 'openalex' },
  { id: 'engrxiv', name: 'engrXiv', discipline: 'engineering (preprints)', via: 'openalex' },
  { id: 'researchsquare', name: 'Research Square', discipline: 'multidisciplinary (preprints)', via: 'crossref' },
  { id: 'preprintsorg', name: 'Preprints.org', discipline: 'multidisciplinary (preprints)', via: 'crossref' },
  { id: 'osf', name: 'OSF Preprints', discipline: 'multidisciplinary (preprints)', via: 'openalex' },
  { id: 'authorea', name: 'Authorea', discipline: 'multidisciplinary (preprints)', via: 'crossref' },
  { id: 'techrxiv', name: 'TechRxiv', discipline: 'engineering (preprints)', via: 'crossref' },
  { id: 'citeseerx', name: 'CiteSeerX', discipline: 'computer science', via: 'openalex' },
  // Aggregators / national & regional indexes
  { id: 'openaire', name: 'OpenAIRE', discipline: 'European OA (aggregator)', via: 'openalex' },
  { id: 'base', name: 'BASE (Bielefeld)', discipline: 'OA aggregator (~300M docs)', via: 'core' },
  { id: 'fatcat', name: 'Internet Archive Scholar', discipline: 'preservation (aggregator)', via: 'openalex' },
  { id: 'paperity', name: 'Paperity', discipline: 'OA aggregator', via: 'openalex' },
  { id: 'jstage', name: 'J-STAGE (Japan)', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'cinii', name: 'CiNii (Japan)', discipline: 'multidisciplinary', via: 'openalex' },
  { id: 'koreascience', name: 'KoreaScience', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'cnki', name: 'CNKI (China)', discipline: 'multidisciplinary', via: 'crossref' },
  { id: 'lareferencia', name: 'LA Referencia', discipline: 'Latin America (aggregator)', via: 'openalex' },
  { id: 'rcaap', name: 'RCAAP (Portugal)', discipline: 'Portugal (aggregator)', via: 'openalex' },
  { id: 'dialnet', name: 'Dialnet', discipline: 'Spanish-language', via: 'crossref' },
  { id: 'latindex', name: 'Latindex', discipline: 'Latin America/Iberia', via: 'openalex' },
  { id: 'amelica', name: 'AmeliCA', discipline: 'Latin America (OA)', via: 'openalex' },
  // Discipline-specific databases & data banks
  { id: 'zbmath', name: 'zbMATH Open', discipline: 'mathematics', via: 'crossref' },
  { id: 'mathscinet', name: 'MathSciNet', discipline: 'mathematics', via: 'crossref' },
  { id: 'eric', name: 'ERIC', discipline: 'education', via: 'openalex' },
  { id: 'agris', name: 'AGRIS (FAO)', discipline: 'agriculture', via: 'openalex' },
  { id: 'cochrane', name: 'Cochrane Library', discipline: 'evidence-based medicine', via: 'crossref' },
  { id: 'clinicaltrials', name: 'ClinicalTrials.gov', discipline: 'clinical trials', via: 'datacite' },
  { id: 'pdb', name: 'Protein Data Bank (PDB)', discipline: 'structural biology', via: 'datacite' },
  { id: 'genbank', name: 'GenBank (NCBI)', discipline: 'genomics', via: 'pubmed' },
];

const DATABASE_CATALOG = [
  ...DIRECT.map((d) => ({ ...d, access: 'direct', via: 'direct' })),
  ...FEDERATED.map((d) => ({ ...d, access: 'federated' })),
];

function catalogSummary() {
  const direct = DATABASE_CATALOG.filter((d) => d.access === 'direct').length;
  const federated = DATABASE_CATALOG.length - direct;
  return { total: DATABASE_CATALOG.length, direct, federated };
}

module.exports = { DATABASE_CATALOG, DIRECT, FEDERATED, catalogSummary };
