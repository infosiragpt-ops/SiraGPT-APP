# Academic Search API Integration

This document defines how siraGPT connects server-side academic search providers for high-volume research tasks. API keys must stay in backend environment variables only. Do not expose them through `NEXT_PUBLIC_*`.

## Configured Providers

| Provider | Env vars | Auth method | Notes |
| --- | --- | --- | --- |
| Scopus | `SCOPUS_API_KEY`, optional `SCOPUS_INSTTOKEN`, optional `SCOPUS_AUTHTOKEN` | `X-ELS-APIKey`, `X-ELS-Insttoken`, `X-ELS-Authtoken` headers | Elsevier entitlement required. Scopus Search supports up to 200 records per request, with quotas depending on key tier and contract. |
| OpenAlex | `OPENALEX_API_KEY`, `OPENALEX_MAILTO` | `api_key` and optional `mailto` query params | Required for production-scale API use. For larger local analytics, use the OpenAlex snapshot instead of hammering REST. |
| Semantic Scholar | `SEMANTIC_SCHOLAR_API_KEY` | `x-api-key` header | Public endpoints work without a key, but the key is recommended for support and predictable limits. |
| PubMed / NCBI E-utilities | `NCBI_API_KEY`, `NCBI_TOOL`, `NCBI_EMAIL` | `api_key`, `tool`, `email` query params | Anonymous E-utilities are limited; API key raises default throughput. Always identify tool and contact email. |
| DOAJ | `DOAJ_API_KEY` for publisher/private routes | Public search uses no key; private CRUD/bulk routes use `api_key` | Article search is open and currently needs no key. DOAJ publisher keys are usually for record management. |
| Crossref | `SEARCH_BRAIN_MAILTO` | User-Agent/mailto polite pool | DOI verification and metadata enrichment. |
| SciELO | `SEARCH_BRAIN_MAILTO` | Crossref member 530 route | Searches SciELO-indexed records through Crossref without scraping. |

## How to Connect Keys Locally

Add keys to `backend/.env` or the production backend environment:

```bash
SCOPUS_API_KEY="..."
SCOPUS_INSTTOKEN="..."
OPENALEX_API_KEY="..."
OPENALEX_MAILTO="research@example.com"
SEARCH_BRAIN_MAILTO="research@example.com"
SEMANTIC_SCHOLAR_API_KEY="..."
NCBI_API_KEY="..."
NCBI_TOOL="siraGPT"
NCBI_EMAIL="research@example.com"
DOAJ_API_KEY="..."
```

Restart the backend after changing env values.

## Scopus

Use the Scopus Search API endpoint:

```text
GET https://api.elsevier.com/content/search/scopus
```

Required header:

```text
X-ELS-APIKey: <SCOPUS_API_KEY>
Accept: application/json
```

Optional institutional headers:

```text
X-ELS-Insttoken: <SCOPUS_INSTTOKEN>
X-ELS-Authtoken: <SCOPUS_AUTHTOKEN>
```

Important parameters:

```text
query=<Scopus query>
count=1..200
start=<offset>
view=STANDARD
sort=relevancy
```

For thousands of records, use pagination with `start` until the result limit, then split the query by year, subject, country, source title, or keywords to stay within provider limits and improve relevance.

## High-Volume Strategy

For thousands of documents per day, do not depend on one live API. Use a tiered architecture:

1. Live search tier: Scopus, OpenAlex, Semantic Scholar, Crossref, PubMed, DOAJ, SciELO.
2. Bulk/snapshot tier: OpenAlex snapshot, Semantic Scholar datasets, Crossref public data files, PubMed baseline/update files, DOAJ public data dump, arXiv OAI/Atom, Europe PMC.
3. Local index tier: ingest snapshots into Postgres/pgvector plus Elasticsearch or OpenSearch for full-text metadata search.
4. Verification tier: DOI resolution through Crossref, DOI URL HEAD/GET checks, publisher URL checks, OA URL checks through Unpaywall/OpenAlex/DOAJ.
5. Rate-limit tier: per-provider queues, retries with exponential backoff, daily counters, and request budgets.

## Recommended Additional Databases

| Database | Best use | Access model |
| --- | --- | --- |
| Crossref | DOI authority, metadata validation, references where available | REST API and public metadata files |
| DataCite | Datasets, theses, reports, research outputs with DOI | REST API |
| Europe PMC | Biomedical/life-science open literature and full-text links | REST API and bulk options |
| arXiv | Preprints in physics, math, CS, quantitative fields | Atom API and OAI-PMH |
| PubMed Central | Open full-text biomedical articles | NCBI APIs and bulk/OAI |
| CORE | Open access repositories and full-text metadata | API key |
| OpenAIRE | European research outputs, grants, projects | API/graph |
| Lens.org | Patents plus scholarly works | API key/licensing |
| Unpaywall | Open access status and OA locations by DOI | REST API with email |
| Redalyc/La Referencia | Latin American OA repository coverage | Prefer official repository/OAI routes where available |

## Current Implementation Notes

The agentic search path uses:

```text
backend/src/services/searchBrain/providers.js
backend/src/services/searchBrain/agenticBatch.js
backend/src/routes/search-agentic.js
```

The standard SearchBrain path uses:

```text
backend/src/routes/search-brain.js
backend/src/services/searchBrain/orchestrator.js
```

Both now know about Scopus, OpenAlex, SciELO, Semantic Scholar, Crossref, PubMed and DOAJ. Providers fail soft: if a key is missing or one provider is down, the remaining providers continue.

## Official References

- Scopus Search API: https://dev.elsevier.com/documentation/ScopusSearchAPI.wadl
- Elsevier API authentication: https://dev.elsevier.com/tecdoc_api_authentication.html
- OpenAlex rate limits and authentication: https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication
- OpenAlex snapshot: https://developers.openalex.org/download-all-data/openalex-snapshot
- Semantic Scholar API: https://www.semanticscholar.org/product/api
- Semantic Scholar Graph API docs: https://api.semanticscholar.org/api-docs/graph
- NCBI E-utilities API key guidelines: https://eutilities.github.io/site/API_Key/usageandkey/
- DOAJ API v4 docs: https://doaj.org/api/v4/docs
