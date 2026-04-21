/**
 * chatAdapter — projects SearchBrain's NormalisedResult[] into the
 * data shape siraGPT's chat surface needs + builds the LLM prompt
 * injection with strict anti-hallucination rules.
 *
 * Ported from IliaGPT with the lessons already learnt there:
 *   - URLs must appear as raw text (LLM copies them verbatim for the
 *     markdown renderer).
 *   - Anti-hallucination preamble is non-negotiable: the LLM must
 *     NOT invent DOIs / URLs / authors when a field is empty.
 *   - APA 7 built deterministically server-side — never trust the
 *     LLM to compose reference strings.
 */

const PROVIDER_PRETTY = {
  openalex: "OpenAlex",
  semantic: "Semantic Scholar",
  crossref: "CrossRef",
  pubmed: "PubMed",
  doaj: "DOAJ",
};

function prettyProviderName(source) {
  return PROVIDER_PRETTY[source] || source;
}

function safeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return (url || "").split("/")[2]?.replace(/^www\./, "") || "unknown";
  }
}

function clampSnippet(text, max = 200) {
  if (!text) return "";
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatApaAuthors(authors) {
  if (!authors || authors.length === 0) return "";
  const clean = (s) => String(s).trim();
  if (authors.length === 1) return clean(authors[0]);
  if (authors.length === 2) return `${clean(authors[0])}, & ${clean(authors[1])}`;
  if (authors.length <= 20) {
    const first = authors.slice(0, -1).map(clean).join(", ");
    return `${first}, & ${clean(authors[authors.length - 1])}`;
  }
  const first19 = authors.slice(0, 19).map(clean).join(", ");
  return `${first19}, … ${clean(authors[authors.length - 1])}`;
}

function buildApa(r) {
  const authors = formatApaAuthors(r.authors);
  const year = r.year ? `(${r.year}).` : "(n.d.).";
  const title = r.title ? `${r.title}.` : "";
  const journal = r.journal ? `*${r.journal}*.` : "";
  const link = r.doi ? `https://doi.org/${r.doi}` : r.url || "";
  return [authors ? `${authors}.` : "", year, title, journal, link].filter(Boolean).join(" ");
}

/** NormalisedResult → chat "web source" for citation rendering. */
function toCitation(r) {
  if (!r || (!r.url && !r.doi)) return null;
  const url = r.url || (r.doi ? `https://doi.org/${r.doi}` : "");
  const domain = safeDomain(url);
  return {
    url,
    title: r.title || url,
    domain,
    favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
    snippet: clampSnippet(r.abstract || r.title || ""),
    date: r.year ? String(r.year) : undefined,
    siteName: r.journal || domain,
    source: { name: prettyProviderName(r.source), domain },
    metadata: {
      provider: r.source,
      year: r.year,
      journal: r.journal,
      doi: r.doi,
      citationCount: r.citationCount,
      openAccess: r.openAccess ?? false,
      pdfUrl: r.pdfUrl,
      authors: r.authors,
      rerankScore: r.rerankScore,
    },
  };
}

/**
 * Build the LLM context block. The preamble is non-negotiable —
 * academic users need every citation to resolve.
 */
function buildPromptInjection(results, providers) {
  const active = (providers || []).filter((p) => p.ok && p.count > 0).map((p) => prettyProviderName(p.source));
  const header = active.length > 0
    ? `\n\n**Artículos académicos encontrados (${active.length} fuentes: ${active.join(", ")}):**\n`
    : "\n\n**Artículos académicos encontrados:**\n";

  const preamble = [
    "⚠️ REGLAS CRÍTICAS PARA CITAR (no negociables):",
    "- USA SOLAMENTE los artículos listados a continuación. NO inventes títulos, autores, revistas, años, DOIs ni URLs bajo ninguna circunstancia.",
    "- Cuando cites un artículo, copia literalmente la línea URL (o DOI) tal como aparece en la lista. No modifiques subdominios, IDs ni extensiones.",
    "- Si un artículo no tiene URL/DOI disponible en la lista, NO inventes uno — menciona el título y autores pero omite el enlace.",
    "- Referencias numeradas [1], [2]... deben corresponder al índice del artículo en la lista. Nunca crees un [N] para un artículo que no esté listado.",
    "- Si necesitas información que no está en las fuentes, dilo explícitamente (\"no hay evidencia en las fuentes recuperadas\") en lugar de rellenar con suposiciones.",
    "- Muestra los URLs directamente (no envueltos en texto markdown) para que sean clickables tal cual.",
    "",
  ].join("\n");

  const body = (results || []).map((p, i) => {
    const authors = Array.isArray(p.authors) && p.authors.length > 0 ? p.authors.join(", ") : "No disponible";
    const year = p.year ? String(p.year) : "No disponible";
    const journal = p.journal || "No disponible";
    const doi = p.doi || "No disponible";
    const urlLine = p.pdfUrl || p.url || (p.doi ? `https://doi.org/${p.doi}` : "No disponible");
    const abstract = clampSnippet(p.abstract || "No disponible", 300);
    return [
      `[${i + 1}] Autores: ${authors}`,
      `Año: ${year}`,
      `Título: ${p.title}`,
      `Journal: ${journal}`,
      `DOI: ${doi}`,
      `URL: ${urlLine}`,
      `Resumen: ${abstract}`,
      `Cita APA 7: ${buildApa(p)}`,
    ].join("\n");
  }).join("\n\n");

  return header + preamble + body;
}

/**
 * Convenience wrapper: given a SearchBrainResponse, produce the
 * chat-ready payload (citations + prompt injection block).
 */
function projectForChat(response) {
  const results = (response && response.results) || [];
  const providers = (response && response.providers) || [];
  const citations = results.map(toCitation).filter(Boolean);
  const injection = buildPromptInjection(results, providers);
  const providersUsed = providers.filter((p) => p.ok && p.count > 0).map((p) => p.source);
  return { citations, promptInjection: injection, providersUsed };
}

module.exports = {
  toCitation,
  buildPromptInjection,
  projectForChat,
  formatApaAuthors,
  buildApa,
  safeDomain,
  clampSnippet,
  prettyProviderName,
  PROVIDER_PRETTY,
};
