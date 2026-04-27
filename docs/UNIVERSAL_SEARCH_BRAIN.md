# UniversalSearchBrain

UniversalSearchBrain is siraGPT's server-side retrieval layer for academic search, web search and vertical searches such as jobs, prices, news, finance, weather, government data, health, food, media, legal and China-oriented sources.

## Architecture

- **siraGPT as body**: Express provides routing, provider orchestration, user settings, cache, rate limiting, circuit breakers and UI.
- **LLM as brain**: the connected model can decompose the query, rerank candidates and synthesize answers with numbered citations.
- **Local vs cloud IP**: in local/self-hosted mode, outbound HTTP requests leave from the user's machine or server network. In cloud mode, requests leave from the deployment server IP.
- **Provider contract**: every source implements `SearchProvider { id, name, region, category, license, rateLimit, requiresKey, search(), fetchDetail? }` and returns `UnifiedResult`.

## API

```bash
curl -X POST http://localhost:5000/api/search-brain/universal \
  -H 'Content-Type: application/json' \
  -d '{"query":"RAG evaluation metrics","categories":["academic"],"region":"global","maxResults":10}'
```

```bash
curl -X POST http://localhost:5000/api/search-brain/shopping \
  -H 'Content-Type: application/json' \
  -d '{"query":"laptop i7","region":"latam","raw":{"siteId":"MPE"}}'
```

```bash
curl -X POST http://localhost:5000/api/search-brain/weather \
  -H 'Content-Type: application/json' \
  -d '{"query":"Lima Peru","language":"es"}'
```

```bash
curl http://localhost:5000/api/search-brain/universal/providers
curl http://localhost:5000/api/search-brain/intents
```

Settings endpoints:

```bash
curl http://localhost:5000/api/search-brain/settings

curl -X POST http://localhost:5000/api/search-brain/settings/region \
  -H 'Content-Type: application/json' -d '{"region":"latam"}'

curl -X POST http://localhost:5000/api/search-brain/settings/mode \
  -H 'Content-Type: application/json' -d '{"mode":"local"}'

curl -X POST http://localhost:5000/api/search-brain/settings/keys \
  -H 'Content-Type: application/json' -d '{"keys":{"core":"FREE_CORE_KEY","newsapi":"FREE_NEWSAPI_KEY"},"userEmail":"research@example.com"}'
```

## Provider Coverage

Active no-key or public providers include:

| Category | Active providers |
| --- | --- |
| Academic | OpenAlex, SciELO, CrossRef, Semantic Scholar, arXiv, PubMed, DOAJ, Europe PMC, DataCite, OpenCitations, ORCID, Unpaywall |
| Jobs | RemoteOK, Remotive, Arbeitnow, WeWorkRemotely RSS |
| Shopping | MercadoLibre, DummyJSON Products, Fake Store API |
| Web | DuckDuckGo Instant Answer, DuckDuckGo HTML, Wikipedia OpenSearch |
| News | GDELT, Google News RSS, HackerNews |
| Finance | CoinGecko, Frankfurter, Stooq |
| Weather | Open-Meteo |
| Geo | Nominatim, REST Countries |
| Food | TheMealDB, Open Food Facts |
| Health | ClinicalTrials.gov, RxNorm |
| Media | TVMaze, Gutendex, Google Books, Jikan |
| Government/legal/social | World Bank, SEC EDGAR, CourtListener, Reddit JSON, 4chan boards |

Cataloged but disabled by default: Scopus, Web of Science, Redalyc, Dialnet, LinkedIn, Indeed, Amazon, eBay, Walmart, Booking, Airbnb, Idealista, Zillow, Baidu, Weibo, Bilibili, Zhihu and many other regional sources. These are marked as `requires-key` or `scraping-opt-in` in `/providers`.

## Optional Free Keys

Users can paste optional keys for: CORE, Adzuna, Brave, NewsAPI, TMDB, YouTube, Amadeus, OpenWeatherMap, WeatherAPI, Yelp, Edamam, Spoonacular, Alpha Vantage, FRED, NASA, Guardian, NYT, Mediastack, Currents, eBay, Best Buy, OpenTripMap, GeoNames, Foursquare, Spotify, Last.fm, Giphy, Tenor, Twitch, LegiScan.

## Cache and TTL

Prisma model `UniversalSearchCache` stores normalized result JSON by query hash, categories, region and provider. TTL policy:

- academic: 30 days
- jobs: 6 hours
- shopping: 2 hours
- news: 30 minutes
- weather: 15 minutes
- government/legal/health/education: 7 days
- finance: 5 minutes
- social/china: 1 hour
- web/media/geo/food: 24 hours

`SearchBrainSettings` stores per-user mode, preferred region, polite-pool email and optional keys. Optional key values are encrypted with `backend/src/utils/encryption.js` when `ENCRYPTION_KEY` is configured. Public settings responses only expose `keysConfigured`, never raw key values.

Provider metadata separates:

- `active`: provider can be queried now.
- `configured`: provider has no key requirement or a usable key is present.
- `requiresKey`: provider needs an optional/free key.
- `scrapingOptIn`: provider is blocked unless explicitly enabled in a future legal/robots-aware flow.
- `disabledReason`: why a provider is cataloged but not active.

Search responses include `failedProviders`, `totalCandidates` and `dedupedCandidates` so the UI can show degraded-but-successful searches without hiding source failures.

## Legal and Operational Notes

Scopus and Web of Science do not provide a real free public API. They require institutional or developer entitlements. Scraping-sensitive sources are disabled by default and must respect robots.txt, rate limits and the user's responsibility in self-hosted mode.

For 1,000,000 users, run providers through queues/workers and central observability before enabling high-volume scraping. The current module is designed as a safe server-side foundation, not a license bypass.
