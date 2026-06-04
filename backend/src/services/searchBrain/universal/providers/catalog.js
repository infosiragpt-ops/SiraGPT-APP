const cheerio = require("cheerio");
const {
  asArray,
  cleanText,
  disabledProvider,
  fetchJson,
  fetchText,
  guardedSearch,
  hashId,
  parseRss,
  parseXml,
  pickFirst,
} = require("./providerUtils");

function result(id, category, sourceProvider, title, extra = {}) {
  return {
    id: id || hashId(sourceProvider, `${title}:${extra.url || ""}`),
    sourceProvider,
    category,
    title: cleanText(title || "Untitled", 220),
    snippet: cleanText(extra.snippet || "", 700),
    url: extra.url || "",
    imageUrl: extra.imageUrl,
    price: extra.price,
    currency: extra.currency,
    location: extra.location,
    datePublished: extra.datePublished,
    author: extra.author,
    metadata: extra.metadata || {},
  };
}

function noKeyJsonProvider(meta, buildUrl, pickItems, mapItem) {
  return {
    ...meta,
    requiresKey: false,
    async search(query, opts = {}) {
      if (!query || typeof query !== "string") return [];
      return guardedSearch(meta.id, async () => {
        const json = await fetchJson(buildUrl(query, opts), {
          timeoutMs: opts.timeoutMs,
          headers: meta.headers ? meta.headers(opts) : undefined,
        });
        return asArray(pickItems(json)).slice(0, opts.maxResults || 20).map((item, index) => mapItem(item, query, opts, index)).filter(Boolean);
      });
    },
  };
}

function optionalKeyJsonProvider(meta, keyName, buildUrl, pickItems, mapItem) {
  return {
    ...meta,
    metadata: { ...(meta.metadata || {}), keyName },
    requiresKey: true,
    async search(query, opts = {}) {
      const key = opts.keys?.[keyName] || opts.keys?.[meta.id] || process.env[`SEARCH_BRAIN_${keyName.toUpperCase()}_KEY`];
      if (!key) return [];
      return guardedSearch(meta.id, async () => {
        const json = await fetchJson(buildUrl(query, opts, key), { timeoutMs: opts.timeoutMs });
        return asArray(pickItems(json)).slice(0, opts.maxResults || 20).map((item, index) => mapItem(item, query, opts, index)).filter(Boolean);
      });
    },
  };
}

function disabled(meta, note) {
  return disabledProvider(meta, note);
}

function doiId(provider, doi, fallback) {
  return doi ? `${provider}:${String(doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")}` : hashId(provider, fallback);
}

function openAccessPdf(item) {
  return item?.openAccessPdf?.url || item?.open_access?.oa_url || item?.best_oa_location?.url_for_pdf || null;
}

const academicProviders = [
  noKeyJsonProvider(
    { id: "crossref", name: "CrossRef", region: "global", category: "academic", license: "open", rateLimit: "Polite pool with mailto" },
    (q, opts) => {
      const u = new URL("https://api.crossref.org/works");
      u.searchParams.set("query", q);
      u.searchParams.set("rows", String(Math.min(opts.maxResults || 20, 50)));
      if (opts.userEmail) u.searchParams.set("mailto", opts.userEmail);
      return u.toString();
    },
    (json) => json?.message?.items,
    (it) => {
      const title = pickFirst(it.title, it.subtitle) || "Untitled";
      const doi = it.DOI;
      const year = it.issued?.["date-parts"]?.[0]?.[0];
      const authors = asArray(it.author).map(a => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean).slice(0, 6).join(", ");
      return result(doiId("crossref", doi, title), "academic", "crossref", title, {
        url: doi ? `https://doi.org/${doi}` : it.URL,
        snippet: cleanText(it.abstract || `${year || ""} ${pickFirst(it["container-title"]) || ""}`),
        datePublished: year ? `${year}-01-01` : undefined,
        author: authors,
        metadata: { doi, year, venue: pickFirst(it["container-title"]), type: it.type, citationCount: it["is-referenced-by-count"] },
      });
    },
  ),
  noKeyJsonProvider(
    { id: "semantic-scholar", name: "Semantic Scholar Graph", region: "global", category: "academic", license: "open", rateLimit: "100 req/5min/IP public tier" },
    (q, opts) => `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${Math.min(opts.maxResults || 20, 20)}&fields=title,abstract,authors,year,citationCount,openAccessPdf,externalIds,url,venue`,
    (json) => json?.data,
    (it) => result(doiId("semantic-scholar", it.externalIds?.DOI, it.paperId || it.title), "academic", "semantic-scholar", it.title, {
      url: it.url || (it.externalIds?.DOI ? `https://doi.org/${it.externalIds.DOI}` : ""),
      snippet: it.abstract || `${it.year || ""} ${it.venue || ""}`,
      datePublished: it.year ? `${it.year}-01-01` : undefined,
      author: asArray(it.authors).map(a => a.name).filter(Boolean).slice(0, 6).join(", "),
      metadata: { doi: it.externalIds?.DOI || null, citationCount: it.citationCount, pdfUrl: openAccessPdf(it), venue: it.venue, year: it.year },
    }),
  ),
  {
    id: "arxiv",
    name: "arXiv",
    region: "global",
    category: "academic",
    license: "open",
    rateLimit: "Courtesy delay recommended",
    requiresKey: false,
    async search(query, opts = {}) {
      return guardedSearch("arxiv", async () => {
        const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${Math.min(opts.maxResults || 20, 30)}`;
        const xml = await fetchText(url, { timeoutMs: opts.timeoutMs, headers: { Accept: "application/atom+xml" } });
        const parsed = parseXml(xml);
        return asArray(parsed?.feed?.entry).map((it) => result(`arxiv:${it.id}`, "academic", "arxiv", it.title, {
          url: it.id,
          snippet: it.summary,
          datePublished: it.published,
          author: asArray(it.author).map(a => a.name).join(", "),
          metadata: { updated: it.updated, categories: asArray(it.category).map(c => c.term).filter(Boolean) },
        }));
      }, { minTime: 1000 });
    },
  },
  noKeyJsonProvider(
    { id: "pubmed", name: "PubMed E-utilities", region: "global", category: "academic", license: "open", rateLimit: "3 req/sec anonymous" },
    (q, opts) => `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmode=json&retmax=${Math.min(opts.maxResults || 20, 50)}`,
    (json) => json?.esearchresult?.idlist,
    (pmid) => result(`pubmed:${pmid}`, "academic", "pubmed", `PubMed record ${pmid}`, {
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      snippet: "PubMed result. Open the record for full abstract and MeSH metadata.",
      metadata: { pmid },
    }),
  ),
  noKeyJsonProvider(
    { id: "doaj", name: "DOAJ", region: "global", category: "academic", license: "open", rateLimit: "Public search API" },
    (q, opts) => `https://doaj.org/api/search/articles/${encodeURIComponent(q)}?pageSize=${Math.min(opts.maxResults || 20, 50)}`,
    (json) => json?.results,
    (row) => {
      const b = row?.bibjson || {};
      const doi = asArray(b.identifier).find(x => x.type === "doi")?.id;
      return result(doiId("doaj", doi, b.title), "academic", "doaj", b.title, {
        url: doi ? `https://doi.org/${doi}` : pickFirst(asArray(b.link).map(l => l.url)),
        snippet: asArray(b.abstract).join(" ") || b.journal?.title,
        author: asArray(b.author).map(a => a.name).join(", "),
        datePublished: b.year ? `${b.year}-01-01` : undefined,
        metadata: { doi, journal: b.journal?.title, year: b.year, openAccess: true },
      });
    },
  ),
  noKeyJsonProvider(
    { id: "europepmc", name: "Europe PMC", region: "global", category: "academic", license: "open", rateLimit: "Public REST API" },
    (q, opts) => `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&pageSize=${Math.min(opts.maxResults || 20, 25)}`,
    (json) => json?.resultList?.result,
    (it) => result(doiId("europepmc", it.doi, it.id), "academic", "europepmc", it.title, {
      url: it.doi ? `https://doi.org/${it.doi}` : `https://europepmc.org/article/${it.source}/${it.id}`,
      snippet: it.abstractText || it.journalTitle,
      author: it.authorString,
      datePublished: it.firstPublicationDate,
      metadata: { doi: it.doi, pmid: it.pmid, pmcid: it.pmcid, citationCount: Number(it.citedByCount || 0), journal: it.journalTitle },
    }),
  ),
  noKeyJsonProvider(
    { id: "datacite", name: "DataCite", region: "global", category: "academic", license: "open", rateLimit: "Public REST API" },
    (q, opts) => `https://api.datacite.org/dois?query=${encodeURIComponent(q)}&page[size]=${Math.min(opts.maxResults || 20, 25)}`,
    (json) => json?.data,
    (it) => {
      const a = it.attributes || {};
      const title = pickFirst(asArray(a.titles).map(t => t.title)) || it.id;
      return result(doiId("datacite", it.id, title), "academic", "datacite", title, {
        url: a.url || `https://doi.org/${it.id}`,
        snippet: pickFirst(asArray(a.descriptions).map(d => d.description)) || a.publisher,
        datePublished: a.publicationYear ? `${a.publicationYear}-01-01` : undefined,
        author: asArray(a.creators).map(c => c.name).join(", "),
        metadata: { doi: it.id, publisher: a.publisher, resourceType: a.types?.resourceTypeGeneral },
      });
    },
  ),
  noKeyJsonProvider(
    { id: "opencitations", name: "OpenCitations COCI", region: "global", category: "academic", license: "open", rateLimit: "Public API" },
    (q) => `https://opencitations.net/index/api/v2/metadata/${encodeURIComponent(q.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ""))}`,
    (json) => json,
    (it) => result(doiId("opencitations", it.doi, it.title), "academic", "opencitations", it.title || it.doi, {
      url: it.doi ? `https://doi.org/${it.doi}` : "",
      snippet: it.source_title,
      author: it.author,
      datePublished: it.year ? `${it.year}-01-01` : undefined,
      metadata: { doi: it.doi, citationCount: Number(it.citation_count || 0), referenceCount: Number(it.reference_count || 0) },
    }),
  ),
  noKeyJsonProvider(
    { id: "orcid", name: "ORCID Public API", region: "global", category: "academic", license: "open", rateLimit: "Public API" },
    (q, opts) => `https://pub.orcid.org/v3.0/search/?q=${encodeURIComponent(q)}&rows=${Math.min(opts.maxResults || 20, 50)}`,
    (json) => json?.result,
    (it) => {
      const orcid = it?.["orcid-identifier"]?.path;
      return result(`orcid:${orcid}`, "academic", "orcid", `ORCID ${orcid}`, {
        url: `https://orcid.org/${orcid}`,
        snippet: "Author identity match from ORCID public registry.",
        metadata: { orcid },
      });
    },
  ),
  optionalKeyJsonProvider(
    { id: "core", name: "CORE", region: "global", category: "academic", license: "requires-key", rateLimit: "Free registration key" },
    "core",
    (q, opts, key) => `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(q)}&limit=${Math.min(opts.maxResults || 20, 50)}&apiKey=${encodeURIComponent(key)}`,
    (json) => json?.results,
    (it) => result(doiId("core", it.doi, it.id || it.title), "academic", "core", it.title, {
      url: it.downloadUrl || it.fullTextLink || it.oai || "",
      snippet: it.abstract,
      author: asArray(it.authors).map(a => a.name || a).join(", "),
      datePublished: it.yearPublished ? `${it.yearPublished}-01-01` : undefined,
      metadata: { doi: it.doi, year: it.yearPublished, publisher: it.publisher },
    }),
  ),
  noKeyJsonProvider(
    { id: "unpaywall", name: "Unpaywall", region: "global", category: "academic", license: "open", rateLimit: "Requires mailto; DOI lookup" },
    (q, opts) => `https://api.unpaywall.org/v2/${encodeURIComponent(q.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ""))}?email=${encodeURIComponent(opts.userEmail || "support@siragpt.com")}`,
    (json) => json ? [json] : [],
    (it) => result(doiId("unpaywall", it.doi, it.title), "academic", "unpaywall", it.title || it.doi, {
      url: it.best_oa_location?.url || `https://doi.org/${it.doi}`,
      snippet: it.journal_name,
      datePublished: it.year ? `${it.year}-01-01` : undefined,
      metadata: { doi: it.doi, isOa: it.is_oa, pdfUrl: it.best_oa_location?.url_for_pdf, license: it.best_oa_location?.license },
    }),
  ),
  disabled({ id: "redalyc", name: "Redalyc", region: "latam", category: "academic", license: "scraping-opt-in", rateLimit: "Robots-aware scraping only", requiresKey: false }, "Redalyc does not expose a stable official JSON API; enable ethical scraping per user."),
  disabled({ id: "dialnet", name: "Dialnet", region: "spain", category: "academic", license: "scraping-opt-in", rateLimit: "Robots-aware scraping only", requiresKey: false }, "Dialnet scraping requires explicit user opt-in."),
  disabled({ id: "web-of-science", name: "Web of Science", region: "global", category: "academic", license: "requires-key", rateLimit: "Institutional Clarivate entitlement", requiresKey: true }, "WoS has no real free API; institutional key required."),
];

const jobsProviders = [
  noKeyJsonProvider({ id: "remoteok", name: "RemoteOK", region: "global", category: "jobs", license: "open", rateLimit: "Public API" }, () => "https://remoteok.com/api", (json) => asArray(json).filter(x => x && !x.legal), (it) => result(`remoteok:${it.id}`, "jobs", "remoteok", it.position, { url: it.url, snippet: it.description || it.company, location: it.location || "Remote", datePublished: it.date, metadata: { company: it.company, salary: it.salary, tags: it.tags } })),
  noKeyJsonProvider({ id: "remotive", name: "Remotive", region: "global", category: "jobs", license: "open", rateLimit: "Public API" }, (q) => `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`, (json) => json?.jobs, (it) => result(`remotive:${it.id}`, "jobs", "remotive", it.title, { url: it.url, snippet: it.description, location: it.candidate_required_location, datePublished: it.publication_date, metadata: { company: it.company_name, salary: it.salary, category: it.category } })),
  noKeyJsonProvider({ id: "arbeitnow", name: "Arbeitnow", region: "global", category: "jobs", license: "open", rateLimit: "Public API" }, (q) => `https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(q)}`, (json) => json?.data, (it) => result(`arbeitnow:${it.slug}`, "jobs", "arbeitnow", it.title, { url: it.url, snippet: it.description, location: it.location, datePublished: it.created_at, metadata: { company: it.company_name, remote: it.remote } })),
  {
    id: "weworkremotely",
    name: "WeWorkRemotely RSS",
    region: "global",
    category: "jobs",
    license: "open",
    rateLimit: "RSS feed",
    requiresKey: false,
    async search(query, opts = {}) {
      return guardedSearch("weworkremotely", async () => {
        const feed = await parseRss("https://weworkremotely.com/remote-jobs.rss", { timeoutMs: opts.timeoutMs });
        const q = query.toLowerCase();
        return asArray(feed.items).filter(i => `${i.title} ${i.contentSnippet}`.toLowerCase().includes(q)).slice(0, opts.maxResults || 20).map(i => result(hashId("weworkremotely", i.link), "jobs", "weworkremotely", i.title, { url: i.link, snippet: i.contentSnippet, datePublished: i.pubDate }));
      });
    },
  },
  optionalKeyJsonProvider({ id: "adzuna", name: "Adzuna", region: "global", category: "jobs", license: "requires-key", rateLimit: "Free registered tier" }, "adzuna", (q, opts, key) => {
    const appId = opts.keys?.adzunaAppId || process.env.SEARCH_BRAIN_ADZUNA_APP_ID || "";
    return `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${encodeURIComponent(appId)}&app_key=${encodeURIComponent(key)}&results_per_page=${Math.min(opts.maxResults || 20, 50)}&what=${encodeURIComponent(q)}`;
  }, (json) => json?.results, (it) => result(`adzuna:${it.id}`, "jobs", "adzuna", it.title, { url: it.redirect_url, snippet: it.description, location: it.location?.display_name, datePublished: it.created, metadata: { company: it.company?.display_name, salaryMin: it.salary_min, salaryMax: it.salary_max } })),
  disabled({ id: "linkedin-jobs", name: "LinkedIn Jobs", region: "global", category: "jobs", license: "scraping-opt-in", rateLimit: "Robots-aware browser scraping", requiresKey: false }, "No free official jobs API; scraping requires explicit user authorization."),
  disabled({ id: "indeed", name: "Indeed", region: "global", category: "jobs", license: "scraping-opt-in", rateLimit: "Robots-aware browser scraping", requiresKey: false }, "Disabled by default."),
  disabled({ id: "infojobs", name: "InfoJobs España", region: "spain", category: "jobs", license: "requires-key", rateLimit: "Free OAuth/app tier", requiresKey: true }, "Requires user developer credentials."),
  disabled({ id: "usajobs", name: "USAJOBS", region: "usa", category: "jobs", license: "requires-key", rateLimit: "Free registered key", requiresKey: true }, "Requires USAJOBS user agent/email key setup."),
];

const shoppingProviders = [
  noKeyJsonProvider({ id: "mercadolibre", name: "MercadoLibre", region: "latam", category: "shopping", license: "open", rateLimit: "Public search API" }, (q, opts) => `https://api.mercadolibre.com/sites/${opts.raw?.siteId || "MPE"}/search?q=${encodeURIComponent(q)}&limit=${Math.min(opts.maxResults || 20, 50)}`, (json) => json?.results, (it) => result(`mercadolibre:${it.id}`, "shopping", "mercadolibre", it.title, { url: it.permalink, imageUrl: it.thumbnail, price: it.price, currency: it.currency_id, location: it.seller_address?.state?.name, metadata: { condition: it.condition, availableQuantity: it.available_quantity, seller: it.seller?.nickname } })),
  noKeyJsonProvider({ id: "dummyjson-products", name: "DummyJSON Products", region: "global", category: "shopping", license: "open", rateLimit: "Testing API" }, (q, opts) => `https://dummyjson.com/products/search?q=${encodeURIComponent(q)}&limit=${Math.min(opts.maxResults || 20, 30)}`, (json) => json?.products, (it) => result(`dummyjson:${it.id}`, "shopping", "dummyjson-products", it.title, { url: `https://dummyjson.com/products/${it.id}`, imageUrl: it.thumbnail, price: it.price, currency: "USD", snippet: it.description, metadata: { rating: it.rating, brand: it.brand, category: it.category } })),
  noKeyJsonProvider({ id: "fakestore", name: "Fake Store API", region: "global", category: "shopping", license: "open", rateLimit: "Testing API" }, () => "https://fakestoreapi.com/products", (json) => json, (it, query) => `${it.title} ${it.description}`.toLowerCase().includes(query.toLowerCase()) ? result(`fakestore:${it.id}`, "shopping", "fakestore", it.title, { url: `https://fakestoreapi.com/products/${it.id}`, imageUrl: it.image, price: it.price, currency: "USD", snippet: it.description, metadata: { rating: it.rating, category: it.category } }) : null),
  disabled({ id: "amazon", name: "Amazon", region: "global", category: "shopping", license: "scraping-opt-in", rateLimit: "Robots-aware ASIN lookup", requiresKey: false }, "Use official Product Advertising API or explicit opt-in scraping."),
  disabled({ id: "ebay", name: "eBay Finding/Buy", region: "global", category: "shopping", license: "requires-key", rateLimit: "Free developer tier", requiresKey: true }, "Requires user eBay developer credentials."),
  disabled({ id: "walmart", name: "Walmart", region: "usa", category: "shopping", license: "requires-key", rateLimit: "Developer tier", requiresKey: true }, "Requires user developer key."),
  disabled({ id: "aliexpress", name: "AliExpress", region: "china", category: "shopping", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "Disabled by default."),
];

const webProviders = [
  noKeyJsonProvider({ id: "duckduckgo-instant", name: "DuckDuckGo Instant Answer", region: "global", category: "web", license: "open", rateLimit: "Public instant answers" }, (q) => `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, (json) => [json, ...asArray(json?.RelatedTopics)], (it, q) => result(hashId("duckduckgo", it.FirstURL || it.AbstractURL || q), "web", "duckduckgo-instant", it.Heading || it.Text || q, { url: it.FirstURL || it.AbstractURL || "", snippet: it.Abstract || it.Text, metadata: { source: it.AbstractSource } })),
  {
    id: "duckduckgo-html",
    name: "DuckDuckGo HTML",
    region: "global",
    category: "web",
    license: "open",
    rateLimit: "HTML endpoint; respectful rate limit",
    requiresKey: false,
    async search(query, opts = {}) {
      return guardedSearch("duckduckgo-html", async () => {
        const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeoutMs: opts.timeoutMs });
        const $ = cheerio.load(html);
        return $(".result").toArray().slice(0, opts.maxResults || 10).map((el) => {
          const title = cleanText($(el).find(".result__title").text(), 220);
          const url = $(el).find(".result__a").attr("href") || "";
          return result(hashId("duckduckgo-html", url || title), "web", "duckduckgo-html", title, { url, snippet: $(el).find(".result__snippet").text() });
        }).filter(r => r.title);
      });
    },
  },
  noKeyJsonProvider({ id: "wikipedia-opensearch", name: "Wikipedia OpenSearch", region: "global", category: "web", license: "open", rateLimit: "Public API" }, (q, opts) => `https://${opts.language === "zh" ? "zh" : opts.language === "es" ? "es" : "en"}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=${Math.min(opts.maxResults || 10, 20)}&namespace=0&format=json`, (json) => asArray(json?.[1]).map((title, i) => ({ title, snippet: json[2]?.[i], url: json[3]?.[i] })), (it) => result(hashId("wikipedia", it.url || it.title), "web", "wikipedia-opensearch", it.title, { url: it.url, snippet: it.snippet })),
  disabled({ id: "searxng-public", name: "SearXNG JSON", region: "global", category: "web", license: "open", rateLimit: "Self-host recommended", requiresKey: false }, "Use local SearXNG for stable production; public instances vary."),
  disabled({ id: "brave-search", name: "Brave Search", region: "global", category: "web", license: "requires-key", rateLimit: "Free registered tier", requiresKey: true }, "Requires free Brave Search API key."),
  disabled({ id: "mojeek", name: "Mojeek", region: "global", category: "web", license: "requires-key", rateLimit: "Free registered tier", requiresKey: true }, "Requires key."),
  disabled({ id: "marginalia", name: "Marginalia", region: "global", category: "web", license: "open", rateLimit: "Public API availability varies", requiresKey: false }, "Endpoint availability changes; keep disabled until configured."),
];

const newsProviders = [
  noKeyJsonProvider({ id: "gdelt", name: "GDELT Project", region: "global", category: "news", license: "open", rateLimit: "Public API" }, (q, opts) => `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&format=json&maxrecords=${Math.min(opts.maxResults || 20, 50)}`, (json) => json?.articles, (it) => result(hashId("gdelt", it.url), "news", "gdelt", it.title, { url: it.url, imageUrl: it.socialimage, snippet: it.seendate || it.sourcecountry, datePublished: it.seendate, author: it.sourceCollectionIdentifier, metadata: { domain: it.domain, language: it.language, country: it.sourcecountry } })),
  {
    id: "google-news-rss",
    name: "Google News RSS",
    region: "global",
    category: "news",
    license: "open",
    rateLimit: "RSS feed",
    requiresKey: false,
    async search(query, opts = {}) {
      return guardedSearch("google-news-rss", async () => {
        const feed = await parseRss(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${opts.language || "es"}`, { timeoutMs: opts.timeoutMs });
        return asArray(feed.items).slice(0, opts.maxResults || 20).map(i => result(hashId("google-news", i.link), "news", "google-news-rss", i.title, { url: i.link, snippet: i.contentSnippet, datePublished: i.pubDate, author: i.creator }));
      });
    },
  },
  noKeyJsonProvider({ id: "hackernews", name: "HackerNews Algolia", region: "global", category: "news", license: "open", rateLimit: "Public API" }, (q, opts) => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=${Math.min(opts.maxResults || 20, 50)}`, (json) => json?.hits, (it) => result(`hn:${it.objectID}`, "news", "hackernews", it.title || it.story_title, { url: it.url || `https://news.ycombinator.com/item?id=${it.objectID}`, snippet: it.comment_text || it.story_text, datePublished: it.created_at, author: it.author, metadata: { points: it.points, comments: it.num_comments } })),
  optionalKeyJsonProvider({ id: "newsapi", name: "NewsAPI.org", region: "global", category: "news", license: "requires-key", rateLimit: "Free developer tier", requiresKey: true }, "newsapi", (q, opts, key) => `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&pageSize=${Math.min(opts.maxResults || 20, 50)}&apiKey=${encodeURIComponent(key)}`, (json) => json?.articles, (it) => result(hashId("newsapi", it.url), "news", "newsapi", it.title, { url: it.url, imageUrl: it.urlToImage, snippet: it.description, datePublished: it.publishedAt, author: it.author, metadata: { source: it.source?.name } })),
];

const financeProviders = [
  noKeyJsonProvider({ id: "coingecko", name: "CoinGecko", region: "global", category: "finance", license: "open", rateLimit: "Public tier" }, (q) => `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, (json) => json?.coins, (it) => result(`coingecko:${it.id}`, "finance", "coingecko", `${it.name} (${it.symbol})`, { url: `https://www.coingecko.com/en/coins/${it.id}`, imageUrl: it.large, snippet: `Market rank ${it.market_cap_rank || "n/a"}`, metadata: { marketCapRank: it.market_cap_rank } })),
  noKeyJsonProvider({ id: "frankfurter", name: "Frankfurter ECB FX", region: "global", category: "finance", license: "open", rateLimit: "Public API" }, () => "https://api.frankfurter.app/latest?from=USD", (json) => Object.entries(json?.rates || {}).map(([currency, rate]) => ({ currency, rate, date: json.date })), (it) => result(`frankfurter:USD-${it.currency}`, "finance", "frankfurter", `USD/${it.currency}`, { snippet: `1 USD = ${it.rate} ${it.currency}`, datePublished: it.date, metadata: { rate: it.rate, base: "USD", currency: it.currency } })),
  {
    id: "stooq",
    name: "Stooq CSV",
    region: "global",
    category: "finance",
    license: "open",
    rateLimit: "Public CSV",
    requiresKey: false,
    async search(query, opts = {}) {
      return guardedSearch("stooq", async () => {
        const symbol = query.trim().split(/\s+/)[0].toLowerCase();
        const csv = await fetchText(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`, { timeoutMs: opts.timeoutMs });
        const [header, row] = csv.trim().split(/\r?\n/);
        if (!row || /N\/D/i.test(row)) return [];
        const keys = header.split(",");
        const vals = row.split(",");
        const data = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
        return [result(`stooq:${data.Symbol}`, "finance", "stooq", data.Symbol, { snippet: `Close ${data.Close} · Volume ${data.Volume}`, datePublished: data.Date, metadata: data })];
      });
    },
  },
  optionalKeyJsonProvider(
    { id: "fred", name: "FRED (St. Louis Fed)", region: "usa", category: "finance", license: "requires-key", rateLimit: "Free registered key" },
    "fred",
    (q, opts, key) => `https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}&file_type=json&limit=${Math.min(opts.maxResults || 20, 50)}&order_by=popularity&sort_order=desc`,
    (json) => json?.seriess,
    (it) => result(`fred:${it.id}`, "finance", "fred", it.title, {
      url: `https://fred.stlouisfed.org/series/${it.id}`,
      snippet: `${it.units || ""} · ${it.frequency || ""} · ${it.observation_start || "?"}→${it.observation_end || "?"}`.trim(),
      datePublished: it.last_updated,
      metadata: {
        seriesId: it.id,
        units: it.units,
        frequency: it.frequency,
        seasonalAdjustment: it.seasonal_adjustment_short,
        popularity: it.popularity,
        notes: cleanText(it.notes || "", 400),
      },
    }),
  ),
  {
    id: "worldbank-indicators",
    name: "World Bank Indicators",
    region: "global",
    category: "finance",
    license: "open",
    rateLimit: "Public API",
    requiresKey: false,
    async search(query, opts = {}) {
      return guardedSearch("worldbank-indicators", async () => {
        const q = String(query || "").toLowerCase();
        const WB_INDICATORS = [
          { code: "NY.GDP.MKTP.CD", label: "GDP (current US$)", keywords: ["gdp", "pib", "producto interno bruto", "gross domestic"] },
          { code: "NY.GDP.MKTP.KD.ZG", label: "GDP growth (annual %)", keywords: ["gdp growth", "crecimiento economico", "economic growth", "crecimiento del pib"] },
          { code: "NY.GDP.PCAP.CD", label: "GDP per capita (current US$)", keywords: ["gdp per capita", "pib per capita", "income per capita", "ingreso per capita"] },
          { code: "FP.CPI.TOTL.ZG", label: "Inflation, consumer prices (annual %)", keywords: ["inflation", "inflacion", "cpi", "consumer price", "precios al consumidor"] },
          { code: "SL.UEM.TOTL.ZS", label: "Unemployment, total (% of labor force)", keywords: ["unemployment", "desempleo", "paro", "tasa de desempleo"] },
          { code: "SP.POP.TOTL", label: "Population, total", keywords: ["population", "poblacion", "habitantes"] },
          { code: "NE.EXP.GNFS.CD", label: "Exports of goods and services (current US$)", keywords: ["exports", "exportaciones"] },
          { code: "NE.IMP.GNFS.CD", label: "Imports of goods and services (current US$)", keywords: ["imports", "importaciones"] },
          { code: "BX.KLT.DINV.CD.WD", label: "Foreign direct investment, net inflows (current US$)", keywords: ["foreign direct investment", "fdi", "inversion extranjera"] },
        ];
        let matches = WB_INDICATORS.filter((ind) => ind.keywords.some((k) => q.includes(k)));
        if (matches.length === 0) matches = [WB_INDICATORS[0]];
        const country = String(opts.raw?.countryCode || opts.raw?.country || "WLD").toUpperCase();
        const out = [];
        for (const ind of matches.slice(0, 3)) {
          let json;
          try {
            json = await fetchJson(`https://api.worldbank.org/v2/country/${encodeURIComponent(country)}/indicator/${ind.code}?format=json&per_page=5&mrv=5`, { timeoutMs: opts.timeoutMs });
          } catch {
            continue;
          }
          const rows = asArray(json?.[1]).filter((r) => r && r.value !== null && r.value !== undefined);
          if (rows.length === 0) continue;
          const latest = rows[0];
          const countryName = latest.country?.value || country;
          out.push(result(`worldbank-indicators:${ind.code}:${country}`, "finance", "worldbank-indicators", `${ind.label} — ${countryName}`, {
            url: `https://data.worldbank.org/indicator/${ind.code}?locations=${country}`,
            snippet: `${countryName} ${latest.date}: ${latest.value} (${ind.label})`,
            datePublished: latest.date,
            location: countryName,
            metadata: {
              indicatorCode: ind.code,
              country: countryName,
              countryCode: latest.countryiso3code || country,
              latest: { date: latest.date, value: latest.value },
              series: rows.map((r) => ({ date: r.date, value: r.value })),
            },
          }));
        }
        return out;
      });
    },
  },
];

const geoWeatherHealthMediaFoodProviders = [
  noKeyJsonProvider({ id: "nominatim", name: "Nominatim OSM", region: "global", category: "geo", license: "open", rateLimit: "1 req/sec policy" }, (q, opts) => `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=${Math.min(opts.maxResults || 10, 20)}`, (json) => json, (it) => result(`nominatim:${it.place_id}`, "geo", "nominatim", it.display_name, { url: `https://www.openstreetmap.org/${it.osm_type}/${it.osm_id}`, snippet: it.type, location: it.display_name, metadata: { lat: it.lat, lon: it.lon, class: it.class } })),
  noKeyJsonProvider({ id: "restcountries", name: "REST Countries", region: "global", category: "geo", license: "open", rateLimit: "Public API" }, (q) => `https://restcountries.com/v3.1/name/${encodeURIComponent(q)}`, (json) => json, (it) => result(`restcountries:${it.cca3}`, "geo", "restcountries", it.name?.common, { url: it.maps?.openStreetMaps, imageUrl: it.flags?.png, snippet: `${it.region} · capital ${asArray(it.capital).join(", ")}`, location: it.name?.common, metadata: { population: it.population, currencies: it.currencies, languages: it.languages } })),
  noKeyJsonProvider({ id: "themealdb", name: "TheMealDB", region: "global", category: "food", license: "open", rateLimit: "Public API" }, (q) => `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`, (json) => json?.meals, (it) => result(`themealdb:${it.idMeal}`, "food", "themealdb", it.strMeal, { url: it.strYoutube || `https://www.themealdb.com/meal/${it.idMeal}`, imageUrl: it.strMealThumb, snippet: it.strInstructions, metadata: { category: it.strCategory, area: it.strArea } })),
  noKeyJsonProvider({ id: "openfoodfacts", name: "Open Food Facts", region: "global", category: "food", license: "open", rateLimit: "Public API" }, (q, opts) => `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=${Math.min(opts.maxResults || 20, 50)}`, (json) => json?.products, (it) => result(`openfoodfacts:${it.code}`, "food", "openfoodfacts", it.product_name || it.generic_name, { url: `https://world.openfoodfacts.org/product/${it.code}`, imageUrl: it.image_front_small_url, snippet: it.ingredients_text || it.brands, metadata: { nutriscore: it.nutriscore_grade, brands: it.brands, categories: it.categories } })),
  noKeyJsonProvider({ id: "clinicaltrials", name: "ClinicalTrials.gov", region: "global", category: "health", license: "open", rateLimit: "Public API" }, (q, opts) => `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(q)}&pageSize=${Math.min(opts.maxResults || 20, 50)}`, (json) => json?.studies, (it) => result(`clinicaltrials:${it.protocolSection?.identificationModule?.nctId}`, "health", "clinicaltrials", it.protocolSection?.identificationModule?.briefTitle, { url: `https://clinicaltrials.gov/study/${it.protocolSection?.identificationModule?.nctId}`, snippet: it.protocolSection?.descriptionModule?.briefSummary, metadata: { status: it.protocolSection?.statusModule?.overallStatus, conditions: it.protocolSection?.conditionsModule?.conditions } })),
  noKeyJsonProvider({ id: "rxnorm", name: "RxNorm", region: "usa", category: "health", license: "open", rateLimit: "NLM public API" }, (q) => `https://rxnav.nlm.nih.gov/REST/drugs.json?name=${encodeURIComponent(q)}`, (json) => json?.drugGroup?.conceptGroup?.flatMap(g => g.conceptProperties || []), (it) => result(`rxnorm:${it.rxcui}`, "health", "rxnorm", it.name, { url: `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${it.rxcui}`, snippet: it.synonym, metadata: { rxcui: it.rxcui, tty: it.tty } })),
  noKeyJsonProvider({ id: "tvmaze", name: "TVMaze", region: "global", category: "media", license: "open", rateLimit: "Public API" }, (q) => `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`, (json) => json, (it) => result(`tvmaze:${it.show?.id}`, "media", "tvmaze", it.show?.name, { url: it.show?.url, imageUrl: it.show?.image?.medium, snippet: it.show?.summary, metadata: { genres: it.show?.genres, rating: it.show?.rating?.average, premiered: it.show?.premiered } })),
  noKeyJsonProvider({ id: "gutendex", name: "Gutendex Project Gutenberg", region: "global", category: "media", license: "open", rateLimit: "Public API" }, (q) => `https://gutendex.com/books/?search=${encodeURIComponent(q)}`, (json) => json?.results, (it) => result(`gutendex:${it.id}`, "media", "gutendex", it.title, { url: it.formats?.["text/html"] || it.formats?.["application/pdf"], imageUrl: it.formats?.["image/jpeg"], snippet: asArray(it.subjects).slice(0, 3).join(" · "), author: asArray(it.authors).map(a => a.name).join(", "), metadata: { languages: it.languages, downloads: it.download_count } })),
  noKeyJsonProvider({ id: "googlebooks", name: "Google Books", region: "global", category: "media", license: "open", rateLimit: "Public API" }, (q, opts) => `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${Math.min(opts.maxResults || 20, 40)}`, (json) => json?.items, (it) => result(`googlebooks:${it.id}`, "media", "googlebooks", it.volumeInfo?.title, { url: it.volumeInfo?.infoLink, imageUrl: it.volumeInfo?.imageLinks?.thumbnail, snippet: it.volumeInfo?.description, author: asArray(it.volumeInfo?.authors).join(", "), datePublished: it.volumeInfo?.publishedDate, metadata: { publisher: it.volumeInfo?.publisher, categories: it.volumeInfo?.categories } })),
  noKeyJsonProvider({ id: "jikan", name: "Jikan MyAnimeList", region: "global", category: "media", license: "open", rateLimit: "Public API" }, (q, opts) => `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=${Math.min(opts.maxResults || 20, 25)}`, (json) => json?.data, (it) => result(`jikan:${it.mal_id}`, "media", "jikan", it.title, { url: it.url, imageUrl: it.images?.jpg?.image_url, snippet: it.synopsis, metadata: { score: it.score, episodes: it.episodes, year: it.year } })),
];

const governmentEducationLegalSocialProviders = [
  noKeyJsonProvider({ id: "worldbank", name: "World Bank API", region: "global", category: "government", license: "open", rateLimit: "Public API" }, (q) => `https://api.worldbank.org/v2/country?format=json&per_page=50`, (json) => json?.[1], (it, query) => `${it.name} ${it.region?.value}`.toLowerCase().includes(query.toLowerCase()) ? result(`worldbank:${it.id}`, "government", "worldbank", it.name, { url: `https://data.worldbank.org/country/${it.id}`, snippet: `${it.region?.value} · ${it.incomeLevel?.value}`, metadata: { iso2Code: it.iso2Code, capitalCity: it.capitalCity } }) : null),
  noKeyJsonProvider({ id: "sec-edgar-company", name: "SEC EDGAR", region: "usa", category: "government", license: "open", rateLimit: "SEC fair access" }, (q) => `https://www.sec.gov/files/company_tickers.json`, (json) => Object.values(json || {}), (it, query) => `${it.title} ${it.ticker}`.toLowerCase().includes(query.toLowerCase()) ? result(`sec:${it.cik_str}`, "government", "sec-edgar-company", `${it.title} (${it.ticker})`, { url: `https://www.sec.gov/edgar/browse/?CIK=${it.cik_str}`, snippet: `CIK ${it.cik_str}`, metadata: it }) : null),
  noKeyJsonProvider({ id: "hipolabs-universities", name: "Hipolabs Universities", region: "global", category: "education", license: "open", rateLimit: "Public API" }, (q) => `http://universities.hipolabs.com/search?name=${encodeURIComponent(q)}`, (json) => json, (it) => result(hashId("hipolabs", it.name + it.country), "education", "hipolabs-universities", it.name, { url: pickFirst(it.web_pages), location: it.country, snippet: asArray(it.domains).join(", "), metadata: { country: it.country, alphaTwoCode: it.alpha_two_code } })),
  noKeyJsonProvider({ id: "courtlistener", name: "CourtListener", region: "usa", category: "legal", license: "open", rateLimit: "Public API" }, (q, opts) => `https://www.courtlistener.com/api/rest/v4/search/?q=${encodeURIComponent(q)}&page_size=${Math.min(opts.maxResults || 20, 20)}`, (json) => json?.results, (it) => result(`courtlistener:${it.id}`, "legal", "courtlistener", it.caseName || it.caseNameFull || it.caption, { url: it.absolute_url ? `https://www.courtlistener.com${it.absolute_url}` : "", snippet: it.snippet, datePublished: it.dateFiled, metadata: { court: it.court, citation: it.citation } })),
  {
    id: "reddit-json",
    name: "Reddit JSON",
    region: "global",
    category: "social",
    license: "open",
    rateLimit: "Public JSON with User-Agent",
    requiresKey: false,
    async search(query, opts = {}) {
      return guardedSearch("reddit-json", async () => {
        const json = await fetchJson(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${Math.min(opts.maxResults || 20, 25)}`, { timeoutMs: opts.timeoutMs, headers: { "User-Agent": "siraGPT-search-brain/1.0" } });
        return asArray(json?.data?.children).map(c => c.data).map(it => result(`reddit:${it.id}`, "social", "reddit-json", it.title, { url: `https://www.reddit.com${it.permalink}`, snippet: it.selftext, datePublished: it.created_utc ? new Date(it.created_utc * 1000).toISOString() : undefined, author: it.author, metadata: { subreddit: it.subreddit, score: it.score, comments: it.num_comments } }));
      });
    },
  },
  noKeyJsonProvider({ id: "fourchan", name: "4chan API", region: "global", category: "social", license: "open", rateLimit: "Public API" }, () => "https://a.4cdn.org/boards.json", (json) => json?.boards, (it, query) => `${it.title} ${it.meta_description}`.toLowerCase().includes(query.toLowerCase()) ? result(`4chan:${it.board}`, "social", "fourchan", `/${it.board}/ ${it.title}`, { url: `https://boards.4chan.org/${it.board}/`, snippet: it.meta_description, metadata: { worksafe: it.ws_board === 1 } }) : null),
  disabled({ id: "eurlex", name: "EUR-Lex", region: "spain", category: "legal", license: "open", rateLimit: "Public APIs/OAI vary", requiresKey: false }, "Cataloged; endpoint-specific integration pending."),
  disabled({ id: "boe", name: "BOE OpenData", region: "spain", category: "government", license: "open", rateLimit: "Public API", requiresKey: false }, "Cataloged; endpoint-specific integration pending."),
  disabled({ id: "mastodon", name: "Mastodon", region: "global", category: "social", license: "open", rateLimit: "Instance-specific", requiresKey: false }, "Requires instance selection."),
  disabled({ id: "bluesky", name: "Bluesky AT Protocol", region: "global", category: "social", license: "open", rateLimit: "Public appview", requiresKey: false }, "Cataloged; endpoint-specific integration pending."),
];

const chinaTravelRealEstateProviders = [
  disabled({ id: "baidu", name: "Baidu Search", region: "china", category: "china", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "No free official general search API."),
  disabled({ id: "weibo", name: "Weibo", region: "china", category: "china", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "Disabled by default."),
  disabled({ id: "bilibili", name: "Bilibili", region: "china", category: "china", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "Disabled by default."),
  disabled({ id: "zhihu", name: "Zhihu", region: "china", category: "china", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "Disabled by default."),
  disabled({ id: "amadeus", name: "Amadeus Self-Service", region: "global", category: "travel", license: "requires-key", rateLimit: "Free developer tier", requiresKey: true }, "Requires user free Amadeus key."),
  disabled({ id: "opentripmap", name: "OpenTripMap", region: "global", category: "travel", license: "requires-key", rateLimit: "Free tier", requiresKey: true }, "Requires key."),
  disabled({ id: "booking", name: "Booking.com", region: "global", category: "travel", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "No free public API."),
  disabled({ id: "airbnb", name: "Airbnb", region: "global", category: "travel", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "No free public API."),
  disabled({ id: "idealista", name: "Idealista", region: "spain", category: "realestate", license: "requires-key", rateLimit: "API access required", requiresKey: true }, "Requires user credentials."),
  disabled({ id: "zillow", name: "Zillow", region: "usa", category: "realestate", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "No public free API."),
  disabled({ id: "fotocasa", name: "Fotocasa", region: "spain", category: "realestate", license: "scraping-opt-in", rateLimit: "Robots-aware scraping", requiresKey: false }, "Disabled by default."),
];

const extraCatalog = [
  ["jooble", "Jooble", "jobs", "global", true],
  ["glassdoor", "Glassdoor", "jobs", "global", false],
  ["ziprecruiter", "ZipRecruiter", "jobs", "usa", false],
  ["google-jobs", "Google for Jobs", "jobs", "global", false],
  ["bumeran", "Bumeran", "jobs", "latam", false],
  ["computrabajo", "Computrabajo", "jobs", "latam", false],
  ["laborum", "Laborum", "jobs", "latam", false],
  ["zonajobs", "Zonajobs", "jobs", "latam", false],
  ["boss-zhipin", "Boss Zhipin", "jobs", "china", false],
  ["lagou", "Lagou", "jobs", "china", false],
  ["zhaopin", "Zhaopin", "jobs", "china", false],
  ["51job", "51Job", "jobs", "china", false],
  ["bestbuy", "Best Buy", "shopping", "usa", true],
  ["target", "Target", "shopping", "usa", false],
  ["costco", "Costco", "shopping", "usa", false],
  ["newegg", "Newegg", "shopping", "usa", false],
  ["homedepot", "Home Depot", "shopping", "usa", false],
  ["linio", "Linio", "shopping", "latam", false],
  ["falabella", "Falabella", "shopping", "latam", false],
  ["ripley", "Ripley", "shopping", "latam", false],
  ["exito", "Éxito", "shopping", "latam", false],
  ["coppel", "Coppel", "shopping", "latam", false],
  ["pccomponentes", "PcComponentes", "shopping", "spain", false],
  ["elcorteingles", "El Corte Inglés", "shopping", "spain", false],
  ["mediamarkt", "MediaMarkt", "shopping", "spain", false],
  ["wallapop", "Wallapop", "shopping", "spain", false],
  ["idealo", "Idealo", "shopping", "spain", false],
  ["taobao", "Taobao", "shopping", "china", false],
  ["tmall", "Tmall", "shopping", "china", false],
  ["jd", "JD.com", "shopping", "china", false],
  ["pinduoduo", "Pinduoduo", "shopping", "china", false],
  ["temu", "Temu", "shopping", "china", false],
  ["shein", "SHEIN", "shopping", "china", false],
  ["mediastack", "Mediastack", "news", "global", true],
  ["guardian", "Guardian Open Platform", "news", "global", true],
  ["nyt", "New York Times API", "news", "usa", true],
  ["currents", "Currents API", "news", "global", true],
  ["data-gob-es", "datos.gob.es", "government", "spain", false],
  ["ine-es", "INE España", "government", "spain", false],
  ["aemet", "AEMET OpenData", "weather", "spain", true],
  ["catastro", "Catastro España", "government", "spain", false],
  ["data-gov", "Data.gov USA", "government", "usa", false],
  ["usaspending", "USAspending", "government", "usa", false],
  ["census", "US Census API", "government", "usa", false],
  ["bls", "BLS", "government", "usa", true],
  ["nasa", "NASA APIs", "government", "usa", true],
  ["usgs", "USGS", "government", "usa", false],
  ["cdc", "CDC", "health", "usa", false],
  ["eurostat", "Eurostat", "government", "spain", false],
  ["ecb", "ECB SDW", "finance", "spain", false],
  ["alphavantage", "Alpha Vantage", "finance", "global", true],
  ["coincap", "CoinCap", "finance", "global", false],
  ["exchangerate-host", "exchangerate.host", "finance", "global", false],
  ["openweathermap", "OpenWeatherMap", "weather", "global", true],
  ["weatherapi", "WeatherAPI.com", "weather", "global", true],
  ["osrm", "OSRM", "geo", "global", false],
  ["overpass", "Overpass API", "geo", "global", false],
  ["ip-api", "IP-API", "geo", "global", false],
  ["ipapi", "ipapi.co", "geo", "global", false],
  ["tmdb", "TMDB", "media", "global", true],
  ["omdb", "OMDb", "media", "global", true],
  ["spotify", "Spotify", "media", "global", true],
  ["youtube", "YouTube Data API", "media", "global", true],
  ["lastfm", "Last.fm", "media", "global", true],
  ["openlibrary", "Open Library", "media", "global", false],
  ["anilist", "Anilist GraphQL", "media", "global", false],
  ["kitsu", "Kitsu", "media", "global", false],
  ["giphy", "Giphy", "media", "global", true],
  ["tenor", "Tenor", "media", "global", true],
  ["twitch", "Twitch", "media", "global", true],
  ["geonames", "GeoNames", "travel", "global", true],
  ["foursquare", "Foursquare Places", "travel", "global", true],
  ["skyscanner", "Skyscanner", "travel", "global", false],
  ["kayak", "Kayak", "travel", "global", false],
  ["inmuebles24", "Inmuebles24", "realestate", "latam", false],
  ["habitaclia", "Habitaclia", "realestate", "spain", false],
  ["propertydata", "PropertyData UK", "realestate", "global", true],
  ["edamam", "Edamam", "food", "global", true],
  ["spoonacular", "Spoonacular", "food", "global", true],
  ["yelp", "Yelp Fusion", "food", "global", true],
  ["openfda", "openFDA", "health", "usa", false],
  ["who-gho", "WHO GHO", "health", "global", false],
  ["drugbank-open", "DrugBank Open", "health", "global", false],
  ["mit-ocw", "MIT OpenCourseWare", "education", "global", false],
  ["coursera", "Coursera", "education", "global", false],
  ["edx", "edX", "education", "global", false],
  ["khan", "Khan Academy", "education", "global", false],
  ["legiscan", "LegiScan", "legal", "usa", true],
  ["twitter-x", "X/Twitter", "social", "global", false],
  ["instagram", "Instagram", "social", "global", false],
  ["tiktok", "TikTok", "social", "global", false],
  ["xiaohongshu", "Xiaohongshu", "china", "china", false],
  ["douyin", "Douyin", "china", "china", false],
  ["kuaishou", "Kuaishou", "china", "china", false],
  ["toutiao", "Toutiao", "china", "china", false],
  ["dianping", "Dianping", "china", "china", false],
  ["meituan", "Meituan", "china", "china", false],
  ["ctrip", "Ctrip", "china", "china", false],
  ["amap", "Amap", "china", "china", false],
].map(([id, name, category, region, requiresKey]) => disabled({
  id,
  name,
  category,
  region,
  license: requiresKey ? "requires-key" : "scraping-opt-in",
  rateLimit: requiresKey ? "Optional free key/developer tier" : "Opt-in only; robots-aware",
  requiresKey,
}, requiresKey ? "Optional key-gated provider; cataloged for Settings." : "Scraping provider cataloged but disabled by default."));

module.exports = {
  catalogProviders: [
    ...academicProviders,
    ...jobsProviders,
    ...shoppingProviders,
    ...webProviders,
    ...newsProviders,
    ...financeProviders,
    ...geoWeatherHealthMediaFoodProviders,
    ...governmentEducationLegalSocialProviders,
    ...chinaTravelRealEstateProviders,
    ...extraCatalog,
  ],
};
