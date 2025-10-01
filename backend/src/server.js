// // search_services.js
// const axios = require("axios");
// const xml2js = require("xml2js");

// const SCOPUS_API_KEY = process.env.SCOPUS_API_KEY || null;
// const CROSSREF_AGENT = process.env.CROSSREF_AGENT || "MyApp/1.0 (mailto:you@example.com)";

// /**
//  * Normalized result format:
//  * {
//  *   source: "pubmed" | "crossref" | "arxiv" | "openalex" | "semantic_scholar" | "scopus",
//  *   id: string, // PMID / DOI / arXiv id / OpenAlex id / Scopus id
//  *   title: string,
//  *   authors: string[], // optional
//  *   abstract: string, // optional
//  *   link: string
//  * }
//  */

// /* ---------------- PUBMED (Entrez) ---------------- */
// async function searchPubMed(query, retmax = 3) {
//     try {
//         // ESearch to get PMIDs
//         const esearch = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", {
//             params: { db: "pubmed", term: query, retmode: "json", retmax }
//         });
//         const ids = (esearch.data.esearchresult && esearch.data.esearchresult.idlist) || [];
//         if (!ids.length) return [];

//         // EFetch to get details (XML)
//         const efetch = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi", {
//             params: { db: "pubmed", id: ids.join(","), retmode: "xml", rettype: "abstract" }
//         });
//         const parsed = await new xml2js.Parser({ explicitArray: false }).parseStringPromise(efetch.data);
//         let articles = parsed.PubmedArticleSet && parsed.PubmedArticleSet.PubmedArticle;
//         if (!articles) return [];
//         if (!Array.isArray(articles)) articles = [articles];

//         const out = [];
//         for (const art of articles.slice(0, retmax)) {
//             try {
//                 const med = art.MedlineCitation;
//                 const article = med.Article;
//                 const pmid = med.PMID && (med.PMID._ || med.PMID);
//                 const title = (article.ArticleTitle || "").toString();
//                 let abstractText = "";
//                 if (article.Abstract && article.Abstract.AbstractText) {
//                     const at = article.Abstract.AbstractText;
//                     if (typeof at === "string") abstractText = at;
//                     else if (Array.isArray(at)) abstractText = at.join(" ");
//                     else if (typeof at === "object" && at._) abstractText = at._;
//                 }
//                 // authors
//                 let authors = [];
//                 if (article.AuthorList && article.AuthorList.Author) {
//                     const al = Array.isArray(article.AuthorList.Author) ? article.AuthorList.Author : [article.AuthorList.Author];
//                     authors = al.map(a => {
//                         const last = a.LastName || "";
//                         const fore = a.ForeName || a.Initials || "";
//                         return `${fore} ${last}`.trim();
//                     }).filter(Boolean);
//                 }
//                 out.push({
//                     source: "pubmed",
//                     id: String(pmid),
//                     title,
//                     authors,
//                     abstract: abstractText,
//                     link: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
//                 });
//             } catch (e) { /* skip bad record */ }
//         }
//         return out;
//     } catch (err) {
//         return [];
//     }
// }

// /* ---------------- CROSSREF ---------------- */
// async function searchCrossref(query, rows = 3) {
//     try {
//         const resp = await axios.get("https://api.crossref.org/works", {
//             params: { query, rows },
//             headers: { "User-Agent": CROSSREF_AGENT }
//         });
//         const items = resp.data && resp.data.message && resp.data.message.items ? resp.data.message.items : [];
//         return items.map(it => {
//             const title = Array.isArray(it.title) ? it.title[0] : (it.title || "");
//             const doi = it.DOI || "";
//             const authors = (it.author || []).map(a => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean);
//             let abstract = "";
//             if (it.abstract) abstract = it.abstract.replace(/<[^>]+>/g, "");
//             return {
//                 source: "crossref",
//                 id: doi,
//                 title,
//                 authors,
//                 abstract,
//                 link: it.URL || (doi ? `https://doi.org/${doi}` : "")
//             };
//         });
//     } catch (err) {
//         return [];
//     }
// }

// /* ---------------- arXiv ---------------- */
// async function searchArxiv(query, max_results = 3) {
//     try {
//         // arXiv API expects query like all:term
//         const q = encodeURIComponent(`all:${query}`);
//         const url = `http://export.arxiv.org/api/query?search_query=${q}&start=0&max_results=${max_results}`;
//         const resp = await axios.get(url);
//         const parsed = await new xml2js.Parser({ explicitArray: false }).parseStringPromise(resp.data);
//         const entries = parsed.feed && parsed.feed.entry ? parsed.feed.entry : [];
//         const arr = Array.isArray(entries) ? entries : [entries];
//         return arr.slice(0, max_results).map(en => {
//             const idRaw = en.id || "";
//             const idMatch = idRaw.split("/").pop();
//             const authors = en.author ? (Array.isArray(en.author) ? en.author.map(a => a.name) : [en.author.name]) : [];
//             const summary = (en.summary || "").replace(/\s+/g, " ").trim();
//             return {
//                 source: "arxiv",
//                 id: idMatch,
//                 title: (en.title || "").trim(),
//                 authors,
//                 abstract: summary,
//                 link: idRaw
//             };
//         }).filter(Boolean);
//     } catch (err) {
//         return [];
//     }
// }

// /* ---------------- OpenAlex ---------------- */
// async function searchOpenAlex(query, per_page = 3) {
//     try {
//         // OpenAlex search: https://api.openalex.org/works?search=...
//         const resp = await axios.get("https://api.openalex.org/works", {
//             params: { search: query, per_page }
//         });
//         const items = resp.data && resp.data.results ? resp.data.results : [];
//         return items.map(it => {
//             const title = it.display_name || "";
//             const doi = (it.ids && it.ids.doi) || "";
//             const authors = (it.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean);
//             const abstract = it.abstract_inverted_index ? null : (it.abstract || "");
//             return {
//                 source: "openalex",
//                 id: it.id || doi || "",
//                 title,
//                 authors,
//                 abstract: abstract || "",
//                 link: it.id ? it.id.replace("https://openalex.org/", "https://openalex.org/") : (doi ? `https://doi.org/${doi}` : "")
//             };
//         });
//     } catch (err) {
//         return [];
//     }
// }

// /* ---------------- Semantic Scholar ---------------- */
// async function searchSemanticScholar(query, limit = 3) {
//     try {
//         const resp = await axios.get("https://api.semanticscholar.org/graph/v1/paper/search", {
//             params: { query, limit, fields: "title,authors,abstract,externalIds,url" }
//         });
//         const data = resp.data && resp.data.data ? resp.data.data : [];
//         return data.map(it => {
//             const authors = (it.authors || []).map(a => a.name).filter(Boolean);
//             const id = it.externalIds && (it.externalIds.DOI || it.paperId) || it.paperId;
//             return {
//                 source: "semantic_scholar",
//                 id: id || it.paperId,
//                 title: it.title || "",
//                 authors,
//                 abstract: it.abstract || "",
//                 link: it.url || (id && id.startsWith("10.") ? `https://doi.org/${id}` : "")
//             };
//         });
//     } catch (err) {
//         return [];
//     }
// }

// /* ---------------- Scopus (Elsevier) ---------------- */
// async function searchScopus(query, count = 3) {
//     if (!SCOPUS_API_KEY) return []; // skip if no key
//     try {
//         // Scopus search endpoint
//         // Query must be URL encoded; basic query: TITLE-ABS-KEY(query)
//         const q = encodeURIComponent(`TITLE-ABS-KEY(${query})`);
//         const url = `https://api.elsevier.com/content/search/scopus?query=${q}&count=${count}`;
//         const resp = await axios.get(url, {
//             headers: {
//                 "X-ELS-APIKey": SCOPUS_API_KEY,
//                 "Accept": "application/json"
//             }
//         });
//         const entries = resp.data && resp.data["search-results"] && resp.data["search-results"].entry ? resp.data["search-results"].entry : [];
//         return entries.slice(0, count).map(en => {
//             const title = en["dc:title"] || "";
//             const id = en["dc:identifier"] || en.eid || "";
//             const link = (en["prism:url"]) || "";
//             const authors = (en["dc:creator"] || "").split(";").map(s => s.trim()).filter(Boolean);
//             console.log('entries', entries);

//             return {
//                 source: "scopus",
//                 id,
//                 title,
//                 authors,
//                 abstract: "", // Scopus search response doesn't include abstract here
//                 link
//             };
//         });
//     } catch (err) {
//         return [];
//     }
// }

// /* ---------------- Common aggregator ---------------- */
// function dedupeResults(results) {
//     const seen = new Set();
//     const out = [];
//     for (const r of results) {
//         // key: prefer DOI/PMID/EID/id
//         const key = (r.id || r.link || r.title || "").toString().toLowerCase().trim();
//         if (!key) continue;
//         if (seen.has(key)) continue;
//         seen.add(key);
//         out.push(r);
//     }
//     return out;
// }

// /**
//  * searchArticles(query, limit)
//  * Queries all providers in parallel (skips Scopus if no API key) and returns up to `limit` combined results.
//  */
// async function searchArticles(query, limit = 4) {
//     // Kick off providers in parallel
//     const tasks = [
//         // //  searchCrossref(query, Math.max(1, limit)),   // Crossref often good for multidisciplinary
//         // searchOpenAlex(query, Math.max(1, limit)),
//         // searchArxiv(query, Math.max(1, limit)),
//         // searchPubMed(query, Math.max(1, limit)),
//         // searchSemanticScholar(query, Math.max(1, limit)),
//     ];
//     if (SCOPUS_API_KEY) tasks.push(searchScopus(query, Math.max(1, limit)));

//     const settled = await Promise.allSettled(tasks);
//     let combined = [];
//     for (const s of settled) {
//         if (s.status === "fulfilled" && Array.isArray(s.value)) {
//             combined = combined.concat(s.value);
//         }
//     }

//     // dedupe and trim
//     const deduped = dedupeResults(combined);
//     // simple scoring: prefer Crossref, Scopus, OpenAlex, Semantic Scholar, PubMed, arXiv
//     const order = { crossref: 0, scopus: 1, openalex: 2, semantic_scholar: 3, pubmed: 4, arxiv: 5 };
//     deduped.sort((a, b) => {
//         const oa = order[a.source] ?? 99;
//         const ob = order[b.source] ?? 99;
//         return oa - ob;
//     });

//     return deduped.slice(0, limit);
// }

// // module.exports = {
// //     searchArticles,
// //     // export provider functions if you want to call directly
// //     searchPubMed,
// //     searchCrossref,
// //     searchArxiv,
// //     searchOpenAlex,
// //     searchSemanticScholar,
// //     searchScopus
// // };

// // server.js
// const express = require("express");
// // const { searchArticles } = require("./search_services");

// const app = express();
// app.use(express.json());

// app.post("/search", async (req, res) => {
//     try {
//         const query = (req.body && req.body.query) || req.query.q || "";
//         const limit = parseInt(req.body.limit || req.query.limit || 4, 10);
//         if (!query || !query.trim()) {
//             return res.status(400).json({ error: "Please provide a 'query' in body or ?q=" });
//         }
//         // call common function
//         const results = await searchArticles(query, limit);
//         // attach a small 'source_info' help
//         const source_info = {
//             pubmed: "PubMed (biomedical) - free abstracts (https://pubmed.ncbi.nlm.nih.gov)",
//             crossref: "Crossref metadata & DOIs (https://www.crossref.org)",
//             arxiv: "arXiv preprints (https://arxiv.org)",
//             openalex: "OpenAlex (open scholarly metadata) (https://openalex.org)",
//             semantic_scholar: "Semantic Scholar (https://www.semanticscholar.org)",
//             scopus: "Scopus (Elsevier) - requires subscription/API key (https://www.scopus.com)"
//         };
//         res.json({ query, returned: results.length, results, source_info });
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ error: "Server error", details: err.message });
//     }
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//     console.log(`Server listening on port ${PORT}`);
//     console.log("POST /search with JSON {query: 'illegal mining', limit: 2}");
// });

