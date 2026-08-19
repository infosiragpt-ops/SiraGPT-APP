/**
 * intentClassifier — maps a free-form query to one or more Categories.
 *
 * Strategy:
 *   1. Regex fast path — multilingual (ES/EN/PT/ZH) keyword patterns
 *      per category. Returns all matches (a query can hit multiple,
 *      e.g. "trabajo data scientist madrid salario" → jobs + geo).
 *   2. If nothing matches, fall back to the default categories passed
 *      by the caller (web + academic by default).
 *   3. Optional LLM enhancement (when `callLLM` is supplied and the
 *      regex is ambiguous) — the LLM returns a ranked list that the
 *      caller can use to weight retrieval.
 *
 * Every pattern is anchored with word boundaries where possible to
 * avoid false positives (e.g. "jobs" shouldn't match inside "jobsite"
 * on purpose — keeping it simple for now and conservative).
 */

const { CATEGORIES } = require("./types");

/** @type {Record<import("./types").Category, RegExp>} */
const PATTERNS = {
  academic: /\b(paper|papers|art[íi]culo|art[íi]culos|estudio|estudios|investigaci[óo]n|journal|cite|citation|doi|pubmed|scholar|arxiv|thesis|tesis|review|systematic|meta[- ]?an[áa]lisis|meta[- ]?analysis)\b/i,
  jobs: /\b(job|jobs|work|empleo|empleos|trabajo|trabajos|vacante|vacantes|hiring|contrataci[óo]n|recruit|puesto|career|carrera|salario|sueldo|cv|curr[íi]culum|resume|linkedin|indeed|glassdoor)\b/i,
  shopping: /\b(buy|comprar|precio|price|cheap|barato|deal|oferta|amazon|mercadolibre|ebay|aliexpress|product|producto|shopping|tienda|store|descuento|discount)\b/i,
  news: /\b(news|noticia|noticias|breaking|latest|announce|anuncio|press release|comunicado|headline|titular|newspaper|peri[óo]dico)\b/i,
  government: /\b(gobierno|government|ministerio|ministry|alcald[íi]a|boe|official gazette|ley|law|decreto|decree|regulation|regulaci[óo]n|c[óo]digo penal|census|censo|agency|agencia|tr[áa]mite)\b/i,
  finance: /\b(stock|acci[óo]n|acciones|bolsa|market|mercado|ticker|crypto|bitcoin|ethereum|currency|divisa|forex|fx|rate|tasa|interest|inter[ée]s|bond|bonos|nasdaq|nyse|ibex|dow jones|s\&p)\b/i,
  weather: /\b(weather|clima|tiempo|forecast|pron[óo]stico|temperature|temperatura|rain|lluvia|snow|nieve|humidity|humedad|wind|viento|hurricane|hurac[áa]n|storm|tormenta)\b/i,
  geo: /\b(map|mapa|address|direcci[óo]n|location|ubicaci[óo]n|coordinates|coordenadas|distance|distancia|nearby|cercano|osm|openstreetmap|latitud|longitud|geocod)\b/i,
  media: /\b(music|m[úu]sica|song|canci[óo]n|album|artist|artista|spotify|youtube|video|videos|podcast|episode|episodio|movie|pel[íi]cula|tv show|serie)\b/i,
  travel: /\b(flight|vuelo|hotel|hoteles|booking|reserva|trip|viaje|airbnb|trivago|skyscanner|kayak|airport|aeropuerto|destination|destino|itinerary|itinerario)\b/i,
  realestate: /\b(house|casa|apartment|apartamento|piso|rent|alquiler|renta|buy[- ]?house|comprar casa|real estate|inmobiliar|idealista|fotocasa|zillow|redfin|property|propiedad)\b/i,
  food: /\b(recipe|receta|recipes|recetas|ingredient|ingrediente|cook|cocinar|cooking|restaurant|restaurante|menu|men[úu]|dish|plato|calories|calor[íi]as|nutrition|nutrici[óo]n)\b/i,
  health: /\b(salud|health|disease|enfermedad|symptom|s[íi]ntoma|treatment|tratamiento|medicine|medicina|drug|f[áa]rmaco|diagnosis|diagn[óo]stico|hospital|doctor|medico|m[ée]dico|cl[íi]nico)\b/i,
  education: /\b(course|curso|tutorial|learn|aprender|mooc|coursera|edx|udemy|khan academy|class|clase|lecture|lecci[óo]n|textbook|libro de texto|syllabus)\b/i,
  legal: /\b(law|ley|legal|court|tribunal|case law|jurisprudencia|statute|estatuto|contract|contrato|attorney|abogado|lawyer|lawsuit|demanda|ruling|sentencia)\b/i,
  social: /\b(twitter|x\.com|mastodon|reddit|r\/|bluesky|bsky|tweet|thread|hilo|post|posts|trending|tendencia|viral)\b/i,
  china: /\b(china|chino|chinese|中国|baidu|weibo|微博|zhihu|知乎|bilibili|douyin|抖音|wechat|微信|xiaohongshu|小红书|taobao|淘宝|jingdong|京东)\b/i,
  web: /.*/, // fallback: always matches — only used when nothing else does
};

/**
 * @param {string} query
 * @param {object} [opts]
 * @param {import("./types").Category[]} [opts.fallback]
 * @returns {import("./types").Category[]}
 */
function classifyIntent(query, opts = {}) {
  if (typeof query !== "string" || query.trim().length === 0) {
    return opts.fallback || ["web"];
  }
  const matches = [];
  for (const cat of CATEGORIES) {
    if (cat === "web") continue; // web is fallback-only
    const pat = PATTERNS[cat];
    if (pat && pat.test(query)) matches.push(cat);
  }
  if (matches.length === 0) {
    return opts.fallback && opts.fallback.length > 0 ? [...opts.fallback] : ["web"];
  }
  return matches;
}

/**
 * LLM-assisted ranking when the regex matches 3+ categories and the
 * caller wants a tie-break. Returns a ranked subset. Silent no-op on
 * parse errors — caller can always use the regex output as-is.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {import("./types").Category[]} args.candidates
 * @param {(req: { messages: Array<{role: string, content: string}>, response_format?: object }) => Promise<{ content: string }>} [args.callLLM]
 * @returns {Promise<import("./types").Category[]>}
 */
async function rankIntentsWithLLM({ query, candidates, callLLM }) {
  if (!callLLM || !Array.isArray(candidates) || candidates.length <= 2) {
    return candidates;
  }
  try {
    const res = await callLLM({
      messages: [
        {
          role: "system",
          content:
            "You rank which category (from the given list) the user's query primarily belongs to. Return JSON like {\"ranked\": [\"cat1\", \"cat2\", ...]} — most relevant first. Only use category names from the list.",
        },
        {
          role: "user",
          content: `Query: ${query}\nCandidates: ${candidates.join(", ")}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(res.content);
    if (Array.isArray(parsed.ranked)) {
      const valid = parsed.ranked.filter((c) => candidates.includes(c));
      return valid.length > 0 ? valid : candidates;
    }
  } catch {
    // silent — caller falls back to regex order
  }
  return candidates;
}

module.exports = {
  classifyIntent,
  rankIntentsWithLLM,
  INTERNAL: { PATTERNS },
};
