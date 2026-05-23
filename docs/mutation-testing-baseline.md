# Mutation Testing Baseline — backend/src/utils/

> Status: tooling landed. Initial run is reproducible from a clean checkout — see `## How to run` below.

This doc describes the mutation-testing baseline for the reliability utilities under `backend/src/utils/`. We provide **two interchangeable runners**:

1. **Lightweight built-in runner** — `backend/scripts/mutation-baseline.js`, dependency-free, runs today.
2. **Stryker** — `backend/stryker.conf.json`, opt-in once `@stryker-mutator/core` is installed.

Both target the same files and the same per-file test suites, so scores are comparable.

## Why mutation testing here

`backend/src/utils/` houses guard rails the rest of the system relies on (timeouts, circuit breakers, retries, async error wrapping, header sanitization, BigInt serialization, etc.). Line/branch coverage is already high (~2900 tests in `npm test`), but coverage only tells us the lines executed — not whether assertions would catch a regression. Mutation score is the explicit signal: if we silently flip `===` to `!==` or `&&` to `||` and tests still pass, the test is missing a meaningful assertion.

## Targets

Files under `backend/src/utils/` that ship with a matching `tests/<basename>.test.js`:

| Source | Test file |
|---|---|
| `async-guard.js` | `async-guard.test.js` |
| `async-handler.js` | `async-handler.test.js` |
| `bigint-serializer.js` | `bigint-serializer.test.js` |
| `circuit-breaker.js` | `circuit-breaker.test.js` |
| `error-telemetry.js` | `error-telemetry.test.js` |
| `fetch-instrument.js` | `fetch-instrument.test.js` |
| `retry-with-backoff.js` | `retry-with-backoff.test.js` |
| `secret-redactor.js` | `secret-redactor.test.js` |
| `sse-heartbeat.js` | `sse-heartbeat.test.js` |
| `sse-writer.js` | `sse-writer.test.js` |

Other utilities (`db-retry-middleware.js`, `encryption.js`, `provider-http-agent.js`, `startup-validator.js`, `stripe-setup.js`) currently have no dedicated `*.test.js` file and are therefore skipped by the runner. Adding focused tests for them is the next step before we expand the mutation surface.

## Mutation operators

The built-in runner applies the following point mutations (one at a time), with a string/template/comment skip mask so literals are never touched:

| ID | Mutation |
|---|---|
| `EQ_TO_NEQ` / `NEQ_TO_EQ` | `===` ↔ `!==` |
| `LOOSE_EQ_TO_NEQ` / `LOOSE_NEQ_TO_EQ` | `==` ↔ `!=` |
| `GT_TO_LTE` / `LTE_TO_GT` | `>` ↔ `<=` |
| `LT_TO_GTE` / `GTE_TO_LT` | `<` ↔ `>=` |
| `AND_TO_OR` / `OR_TO_AND` | `&&` ↔ `\|\|` |
| `TRUE_TO_FALSE` / `FALSE_TO_TRUE` | `true` ↔ `false` |
| `PLUS_TO_MINUS` / `MINUS_TO_PLUS` | `+` ↔ `-` (binary only — `++`, `--`, `+=`, `-=` are excluded) |

These cover the high-signal mutations Stryker categorises under *EqualityOperator*, *LogicalOperator*, *BooleanLiteral*, *RelationalOperator*, and *ArithmeticOperator*. The Stryker config will additionally exercise *ConditionalExpression*, *BlockStatement*, and *StringLiteral* mutators.

## How to run

### Built-in runner (default)

```bash
cd backend
node scripts/mutation-baseline.js
```

Environment knobs:

| Variable | Default | Effect |
|---|---|---|
| `MUTATION_FILES` | _(all)_ | comma-separated basenames, e.g. `async-guard,circuit-breaker` |
| `MUTATION_LIMIT` | `25` | max mutants generated per file |
| `MUTATION_TIMEOUT_MS` | `30000` | per-mutant test timeout |
| `MUTATION_REPORT` | `docs/mutation-testing-baseline.md` | overwrite this file |
| `MUTATION_VERBOSE` | `1` | set to `0` to silence per-mutant lines |

The runner overwrites `docs/mutation-testing-baseline.md` with a report containing the summary table, per-file scores, and the list of surviving mutants. It restores the original source file even on failure (the write/restore is in a `try/finally`).

### Stryker (opt-in)

```bash
cd backend
npm i -D @stryker-mutator/core
npx stryker run stryker.conf.json
```

Stryker reads the same target list and runs the same per-file test commands declared in `stryker.conf.json`. The HTML report is written to `docs/mutation-testing-baseline.html` and the JSON report to `backend/reports/mutation/mutation.json`.

## Mutation score

`score = (KILLED + TIMEOUT) / (KILLED + SURVIVED + TIMEOUT)`

- **KILLED** — the mutant caused at least one test to fail. Good.
- **SURVIVED** — all tests passed against the mutated code. A test gap (or an equivalent mutant — review needed).
- **TIMEOUT** — the mutated code looped or hung; counted as killed because behaviour clearly diverged.

Initial thresholds (baseline only — these will tighten as we close gaps):

| Tier | Threshold | Action |
|---|---|---|
| `high` | ≥ 80 % | green, no action |
| `low` | 60–80 % | acceptable, track survivors |
| `break` | < 60 % | open issue and add tests |

The `0` break value in the Stryker config means the initial baseline run **never fails CI** — switch it to `60` once the score is established and survivors are triaged.

## Initial measurement

Running the full baseline takes a few minutes (each mutant spawns `node --test`). The first measurement is captured by re-running the runner; the report regenerates this file in place. The recommended workflow:

1. Run on a clean working tree.
2. Commit the regenerated `docs/mutation-testing-baseline.md`.
3. Triage `Surviving mutants` table — each survivor either:
   - exposes a missing assertion (add a test), or
   - is an equivalent mutant (annotate in a follow-up note).

A row will appear here per file once the runner completes, e.g.

```
| async-guard | 25 | 24 | 1 | 0 | 96.0% |
```

## Roadmap

1. Land tests for the currently-skipped utilities (`encryption.js`, `provider-http-agent.js`, `startup-validator.js`).
2. Promote the runner to CI as a non-blocking job, gate on the `low` threshold.
3. Expand mutation surface to `backend/src/cache/` and `backend/src/middleware/` once the utils baseline is green.
