# CLAUDE.md — SiraGPT Agent Workspace

## Project Overview
SiraGPT es una plataforma AI full-stack (Next.js 14 + Express.js) con sistema multi-agente, generación de contenido visual, documentos, y orquestación tipo OpenClaw.

## Arquitectura
- **Frontend:** Next.js 14 (React), app/ directory, shadcn/ui, TailwindCSS, Zustand stores
- **Backend:** Express.js en `backend/`, Prisma ORM, PostgreSQL, Redis
- **Agentes:** Sistema multi-agente en `backend/src/services/agents/`
  - `agent-core.js` — núcleo del agente
  - `agent-task-runner.js` — ejecutor de tareas (runner/worker)
  - `agent-tools.js` — registro de herramientas
  - `visual-media-tools.js` — herramientas de generación visual (7 tools)
  - `agentic-langgraph.js` — orquestación LangGraph
  - `task-tools.js` — herramientas de tareas + sistema de artefactos
- **CI:** `.github/workflows/ci.yml` (frontend + backend + security + docker)

## Comandos importantes
```bash
npm run dev            # Next.js dev server (puerto 3000)
npm run build          # Next.js build
npm test               # Tests backend (Node --test)
npm run lint           # ESLint (ratchet: max-warnings 97)
npx tsc --noEmit --skipLibCheck   # TypeScript check
npm run type-check     # TSC completo
```

## Reglas para Claude
1. **No modificar la UI/componentes visuales** — solo funcionalidad interna
2. **Trabajar en:** agentes, herramientas de generación, pipelines, sistema de archivos, backend
3. **Push directo a main** en `https://github.com/SiraGPT-ORg/siraGPT`
4. **Cada cambio debe mantener CI verde** — correr `npm test` y `npm run lint` antes de push
5. **Priorizar:** estabilidad, rendimiento, cobertura de errores, calidad de código
6. **Pull siempre antes de push** para evitar conflictos

## Áreas de mejora prioritaria
- Sistema de herramientas visuales (visual-media-tools.js)
- Pipeline de documentos (document-pipeline)
- Sistema de artefactos (task-tools.js)
- Motor de agentes (agent-core.js, agentic-langgraph.js)
- Registro de herramientas y contratos

## Conexiones externas
- Repo: https://github.com/SiraGPT-ORg/siraGPT
- Remoto: `sira-org`
- Branch: main (push directo)
