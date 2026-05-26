# SiraGPT

[![CI](https://github.com/SiraGPT-ORg/siraGPT/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SiraGPT-ORg/siraGPT/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)

Full-stack AI platform (Next.js 14 + Express.js) with multi-agent orchestration,
visual content generation, deep-document pipelines, scientific-search, and
Manus-like research agents.

## Features

- **Multi-LLM**: OpenAI, Anthropic Claude, xAI Grok, DeepSeek, Google Gemini
- **Multi-agent core**: agent runner, dynamic tool manifest, error classifier,
  static security checks, circuit breakers, async-guards, OTel-traced fetch
- **34+ visual tools**: charts (8 types + funnel/gauge/waterfall/heatmap/treemap),
  org charts, mermaid diagrams, infographics, dashboards, SWOT/Eisenhower/RACI/
  BMC/Porter/Pyramid/Risk/Funnel/VPC/PESTEL/Radar/Journey/OKR/Empathy/Lean/BSC/
  Ansoff/BCG/MoSCoW/Decision-Tree/Concept-Map/Mindmap/Swimlane
- **Document pipeline**: 20+ parsers/generators, 50-file batches, memory-safe
  PDF sampling, RAG indexing, cross-document intent analysis
- **Cowork system**: auto-file bridge, deep-document analyzer (domain/PII/risk),
  active memory (two-tier auto-promote), session manager, 14 built-in skills
- **Research agents**: 7 scientific-paper APIs (arXiv/OpenAlex/CrossRef/EuropePMC/
  Semantic Scholar/PubMed/CORE), autonomous research loop with Playwright +
  vision-model browsing, SSE-streamed progress
- **Reliability**: AsyncGuard, FetchInstrument, CircuitBreaker, retry-with-backoff,
  progress-stream SSE, error-telemetry, prompt caching
- **Observability**: OpenTelemetry tracing, structured logs, analyzer health
  endpoint, CI cascade with cancel-in-progress, auto-rollback deploys

## Tech Stack

- Frontend: Next.js 14 (app router), React 18, shadcn/ui, TailwindCSS, Zustand
- Backend: Express.js, Prisma ORM, PostgreSQL, Redis
- Tests: `node --test` (~2900 tests), Vitest, Playwright
- Infra: Docker Compose, PM2, GitHub Actions, OTel

## Quick start

```bash
git clone https://github.com/SiraGPT-ORg/siraGPT && cd siraGPT
npm install && cd backend && npm install && cd ..
cp .env.example .env.local   # edit API keys
./scripts/dev-up.sh          # boots Postgres + Redis + frontend + backend
# open http://localhost:3000
```

## Documentation

- [Architecture](docs/architecture.md)
- [Master execution prompt](docs/SIRAGPT_MASTER_PROMPT.md)
- [Observability](docs/observability.md)
- [Prompt caching](docs/prompt-caching.md)
- [OpenAPI spec](docs/openapi.json)
- [Backend README](README-BACKEND.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Contributors](CONTRIBUTORS.md) — auto-generated from `git shortlog`

## Community & policies

- [Security policy](SECURITY.md) — how to report vulnerabilities + SLA
- [Code of conduct](CODE_OF_CONDUCT.md) — Contributor Covenant v2.1 (español)
- [Issue templates](.github/ISSUE_TEMPLATE/) — bug report, feature request, security redirect
- [Pull request template](.github/PULL_REQUEST_TEMPLATE.md)

## License

MIT — see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
