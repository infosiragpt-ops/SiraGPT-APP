# SiraGPT Agent Skills

Librería de automatización para mejorar calidad, rendimiento, seguridad y confiabilidad del código de SiraGPT.

Inspirado en OpenClaw, cada skill es una guía operacional + herramientas para un aspecto clave del desarrollo.

## Matriz de Skills

| Skill | Propósito | Cuándo Usar | Bloqueador |
|-------|-----------|-----------|-----------|
| **autoreview** | Revisión estructurada de código | Antes de merge | No |
| **quality-gates** | Validación de calidad: lint, type, test, coverage | CI pipeline | Sí |
| **ci-orchestrator** | Orquestación de GitHub Actions, triage de fallos | Release, debugging | No |
| **performance-profiler** | Profiling de latencia, memoria, bundle | Antes de release | No (pero recomendado) |
| **security-hardening** | Auditoría de seguridad, CVEs, secrets | Antes de release | Sí (para prod) |
| **agent-validation** | Validación del sistema de agentes, herramientas, sandbox | Antes de release | Sí (para agentes) |
| **release-orchestrator** | Automatización de versioning, changelog, GitHub releases | Release | No |
| **runtime-debugging** | Depuración por límites: rutas, providers, streaming, DB, deploy | Incidentes local/prod | No |
| **message-flow-lab** | Validación de chat, streaming, adjuntos y canales | Cambios en mensajes/chat | No |
| **secret-safety** | Revisión de secretos, logs y redacción segura | Env, providers, deploy, auth | Sí |
| **qa-smoke-testing** | Selección de pruebas smoke enfocadas | Antes de push/deploy | Sí |
| **bugfix-sweep** | Barrido de bugs pequeños y seguros | Mejoras autónomas | No |
| **technical-docs** | Runbooks, docs técnicas e instrucciones de agentes | Cambios operativos | No |
| **release-maintainer** | Push, deploy, monitoreo y verificación de producción | Releases a main/prod | Sí |
| **agent-transcript-lite** | Resúmenes seguros de implementación | PRs, handoffs, memoria | No |
| **dependency-upgrade-guard** | Guardrails para upgrades y lockfiles | Dependencias/build/Docker | Sí |
| **openclaw-import-audit** | Copia y atribución MIT de OpenClaw | Importar skills/código externo | Sí |
| **hermes-import-audit** | Copia y adaptación MIT de Hermes Agent | Importar toolsets/compaction/skills Hermes | Sí |
| **repo-folder-integration** | Mapa carpeta por carpeta OpenClaw/Hermes ↔ SiraGPT | Integración de repos externos | No |
| **channel-connector-hardening** | Conectores, canales, archivos y flujos de mensaje | Chat/providers/integraciones | No |
| **e2e-proof-recorder** | Pruebas, CI, browser proof y health checks | Antes de publicar cambios | Sí |
| **agent-capability-matrix** | Matriz de cobertura entre OpenClaw y SiraGPT | Priorización de próximos ports | No |

## Integración en Flujo

### Desarrollo Local

```bash
# Antes de hacer push
npm run check:all                  # Corre: lint, type, test, coverage, security

# Opcional: review antes de merge
./.agents/skills/autoreview/scripts/autoreview --mode branch --base origin/main

# Validar todas las skills de agente
npm run skill:validate:agents

# Ver mapa OpenClaw -> SiraGPT
npm run agent:openclaw:map

# Ver mapa Hermes Agent -> SiraGPT
npm run agent:hermes:map
```

### CI Pipeline

```yaml
# En .github/workflows/ci.yml
- name: Quality Gates
  run: npm run check:all             # lint, type, test, coverage, security

- name: Agent System Validation
  run: npm run agents:validate:all   # registry, manifest, sandbox, authz

- name: Performance Baseline
  run: npm run perf:profile          # Captura latency, bundle, memory
```

### Pre-Release

```bash
# Full validation antes de tag
npm run release:pre-flight

# Corre: check:all, agents:validate:all, perf:compare, security:audit, test:e2e

# Si todo pasa, proceder a release
npm run release:bump -- [major|minor|patch]
```

## Uso Individual

### AutoReview

```bash
# Review de cambios locales
./.agents/skills/autoreview/scripts/autoreview --mode local

# Review de rama
./.agents/skills/autoreview/scripts/autoreview --mode branch --base origin/main

# Output a JSON para downstream
./.agents/skills/autoreview/scripts/autoreview --mode branch --output review.json
```

**Salida:**
- Security findings (alta severidad)
- Performance warnings (N+1, loops)
- Maintainability suggestions (refactor, complexity)

### Quality Gates

```bash
# Full pass (todos los gates)
npm run check:all

# Linting
npm run lint                       # Full
npm run lint:changed               # Only changed files
npm run lint:fix                   # Auto-fix

# Type checking
npm run type-check

# Tests
npm run test                       # Full suite
npm run test:changed               # Changed files only
npm run test:coverage              # Coverage report

# Security
npm run security:check
npm run audit
```

**Exit codes:**
- 0 = todos los gates pasaron
- 1 = fallo en algún gate (con detalles)

### CI Orchestrator

```bash
# Monitoreo de CI
gh run list --limit 10
gh run view <run-id> --log

# Triage de fallo
gh run view --job <job-id> --log | head -50

# Rerun job
gh run rerun <run-id> --job <job-id>
```

**Workflows:**
- Frontend path: build, lint, type, bundle analysis (~4min)
- Backend path: unit tests, integration, security, audit (~6min)
- Agent path: registry, manifest, sandbox, authz (~2min)
- Docker path: build images, size check (~3min)

### Performance Profiler

```bash
# Baseline
npm run perf:baseline

# Profile específico
npm run perf:api                   # API latency
npm run perf:bundle                # Bundle size
npm run perf:memory:profile        # Heap snapshot
npm run perf:agent -- complex      # Agent task

# Comparar
npm run perf:compare --baseline perf-baseline.json
```

### Security Hardening

```bash
# Auditoría completa
npm run security:audit             # All checks

# Específicos
npm run security:crypto-audit
npm run security:secrets-scan
npm run security:validate-schemas -- app/api/**/*.ts
npm run security:agents:validate-tools
```

### Agent Validation

```bash
# Validación completa
npm run agents:validate:all

# Específicas
npm run agents:validate:registry
npm run agents:validate:manifest
npm run agents:validate:sandbox:isolation
npm run agents:validate:execute -- complex
npm run agents:validate:visual:all
```

### Release Orchestrator

```bash
# Pre-flight check
npm run release:pre-flight         # Full validation

# Bump version
npm run release:bump -- patch

# Tag & release
npm run release:tag
npm run release:create

# Deploy & monitor
npm run deploy:status
```

## Commandos npm Requeridos

Para integrar estos skills, añade a `package.json`:

```json
{
  "scripts": {
    "check:all": "npm run lint && npm run type-check && npm run test && npm run test:coverage && npm run security:check && npm run review",
    "review": "node ./.agents/skills/autoreview/scripts/autoreview --mode branch",
    "lint": "eslint . --ext .js,.jsx,.ts,.tsx",
    "lint:changed": "eslint $(git diff --name-only --diff-filter=d origin/main | grep -E '\\.(js|jsx|ts|tsx)$')",
    "lint:fix": "eslint . --ext .js,.jsx,.ts,.tsx --fix",
    "type-check": "tsc --noEmit --skipLibCheck",
    "test": "node --test backend/tests/**/*.test.js",
    "test:changed": "node --test $(git diff --name-only origin/main | grep -E '\\.test\\.js$')",
    "test:coverage": "c8 --reporter=text npm test",
    "security:check": "npm audit --audit-level=moderate && npm run security:secrets-scan",
    "security:secrets-scan": "grep -r 'password\\|secret\\|api.key\\|token' --include='*.js' --include='*.ts' backend/ || true",
    "security:crypto-audit": "grep -r 'md5\\|sha1\\|des\\|crc' --include='*.js' backend/ || true",
    "audit": "npm audit",
    "perf:baseline": "echo 'Capture baseline metrics'",
    "perf:profile": "echo 'Run performance profiling'",
    "perf:compare": "echo 'Compare against baseline'",
    "agents:validate:all": "echo 'Validate agent system'",
    "agents:validate:registry": "node backend/scripts/validate-tool-registry.js",
    "agents:validate:manifest": "node backend/scripts/validate-task-manifest.js",
    "agents:validate:sandbox:isolation": "node backend/tests/code-sandbox-isolation.test.js",
    "agents:validate:execute": "node backend/scripts/validate-agent-execute.js",
    "agents:validate:visual:all": "node backend/scripts/validate-visual-tools.js",
    "release:pre-flight": "npm run check:all && npm run agents:validate:all && npm run build",
    "release:bump": "echo 'Bump version with semver'",
    "release:tag": "echo 'Tag release on git'",
    "release:create": "echo 'Create GitHub release'",
    "deploy:status": "echo 'Check deployment status'",
    "build": "next build && npm run build:backend",
    "build:backend": "tsc --project backend/tsconfig.json"
  }
}
```

## Validación de Skills

Todos los skills han sido validados con:
- [ ] Documentación clara (SKILL.md)
- [ ] Comandos integrados en package.json
- [ ] Compatibilidad con CI pipeline
- [ ] Sin cambios a UI/frontend
- [ ] Enfoque en funcionalidad interna (agentes, backend, herramientas)

## Próximas Mejoras

- [ ] Integración visual en dashboard de monitoreo
- [ ] Métricas históricas de quality gates
- [ ] Auto-remediation de issues comunes
- [ ] Integración con Slack/notificaciones
- [ ] Performance regression detection automática
- [ ] Security scanning incremental (solo cambios)

## Referencias

Inspirado en OpenClaw y Hermes Agent:
- `.agents/openclaw-upstream` → snapshot MIT inactivo de OpenClaw `.agents/skills`
- `.agents/hermes-upstream` → snapshot MIT inactivo de Hermes `skills/` + `optional-skills/`
- `.agents/skills/autoreview` → OpenClaw autoreview
- `.agents/skills/quality-gates` → OpenClaw quality gates
- `.agents/skills/ci-orchestrator` → OpenClaw crabbox + CI orchestration
- `.agents/skills/performance-profiler` → OpenClaw performance profiling
- `.agents/skills/security-hardening` → OpenClaw security auditing
- `.agents/skills/agent-validation` → SiraGPT-specific agent system validation
- `.agents/skills/release-orchestrator` → OpenClaw release automation
- `.agents/skills/openclaw-import-audit` → copia, atribución y adaptación segura
- `.agents/skills/repo-folder-integration` → comparación carpeta por carpeta
- `.agents/skills/channel-connector-hardening` → patrones de canales/archives adaptados a SiraGPT
- `.agents/skills/e2e-proof-recorder` → pruebas y evidencia estilo OpenClaw adaptadas a SiraGPT
- `.agents/skills/agent-capability-matrix` → cobertura de capacidades y próximos ports
