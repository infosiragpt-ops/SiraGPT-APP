# QA Cargas Estrés — Harness de carga (`scripts/load-harness.mjs`)

Harness de carga/estrés **sin dependencias nuevas** (solo `fetch`/`AbortController`
de Node 18+). Mide lo que el VPS aguanta de verdad: concurrencia escalonada,
latencia p50/p95/p99, tasa de error y RPS — con **gates SLO salibles** (exit ≠ 0)
apto para CI.

## Principios

- **Read-only por defecto**: solo hace peticiones GET (o el método que indiques
  con cuerpo explícito vía `--body`). Nunca toca auth ni escribe datos.
- **Rampa a prueba de fallos**: cada etapa termina antes de empezar la siguiente;
  si una etapa viola su gate, la corrida se detiene ahí (no se apila sobre un
  objetivo que ya sufre).
- **Cero dependencias**: no agranda el bundle ni el supply-chain.

## Uso

```bash
# Escalera clásica: 10 → 50 → 100 usuarios concurrentes, 15s por nivel
node scripts/load-harness.mjs --url https://siragpt.com/api/version \
  --stages 10,50,100 --duration 15

# Rampa lineal hasta 100 VUs en 120s (encuentra el punto de quiebre)
node scripts/load-harness.mjs --url https://siragpt.com/api/version \
  --ramp --concurrency 100 --duration 120

# Lazo abierto: 50 req/s constantes (sin acumulación de cola)
node scripts/load-harness.mjs --url https://siragpt.com/api/version \
  --open --rps 50 --duration 60
```

## Gates SLO (exit 1 si fallan)

| Flag | Default | Significado |
|---|---|---|
| `--slo-p95` | `2000` | Latencia p95 máxima en ms por etapa (`0` desactiva) |
| `--slo-error-rate` | `0.01` | Fracción máxima de errores (≥400/timeout/red) |
| `--slo-rps` | `0` | RPS mínimo exigido (`0` desactiva) |

## Flags principales

- `--url` (obligatorio), `--method`, `--body`, `--content-type`
- `-H` / `--header "Name: value"` (repetible — para tokens de prueba)
- `--stages 10,50,100` · `--ramp --concurrency N` · `--open --rps N`
- `--duration <seg>` por etapa (default 10)
- `--timeout-ms 10000` timeout individual de request
- `--warmup 2` segundos de calentamiento antes de medir
- `--json` imprime resumen JSON machine-readable al final
- `--quiet` suprime líneas informativas

## Códigos de salida

- `0` — todas las etapas dentro de SLO
- `1` — violación de gate o error de ejecución
- `2` — error de uso (falta `--url`, flag desconocido)

## Qué medir contra producción (runbook sugerido)

Objetivos seguros (read-only, sin auth): `/api/version`, `/api/health/ready`,
front `https://siragpt.com`. El dominio manda medir **100 chats concurrentes**,
pero eso requiere credenciales de prueba y gasta tokens de modelo — hacerlo
contra producción requiere aprobación expresa de CEO Office/Ops y ventana
acordada. Este harness cubre hoy la capa HTTP pública; la extensión autenticada
(chat sintético) queda documentada como siguiente paso.

Ejemplo de corrida de referencia (sin tocar negocio):

```bash
node scripts/load-harness.mjs --url https://siragpt.com/api/health/ready \
  --ramp --concurrency 100 --duration 90 --slo-p95 1500 --json > tmp/carga-baseline.json
```

## Tests

Los tests de contrato del CLI viven en `tests/load-harness.test.ts`
(`npm test`). Cubren: pass en objetivo sano, falla por p95 estricto,
falla por tasa de error (HTTP 500) y validación de uso.
