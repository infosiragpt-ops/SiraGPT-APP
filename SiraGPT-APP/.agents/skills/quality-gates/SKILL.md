---
name: quality-gates
description: "Quality gate orchestration: linting, type checking, security scanning, test coverage thresholds, and bundle-size validation."
---

# Quality Gates

Automated enforcement of code quality standards across SiraGPT.

## Contract

- All quality gates must pass before push to main.
- Code coverage minimum: backend 70%, frontend 60% (per file: min 40%).
- ESLint max-warnings: 45 (ratchet style: do not regress).
- TypeScript strict mode with no `any` escapes unless documented.
- Bundle size regression: abort if main bundle > 150KB gzipped.
- Test suite must complete within 5 minutes; skip flaky tests until stabilized.

## Gates

### Linting

```bash
npm run lint                          # Full ESLint pass
npm run lint:changed                  # Changed files only
npm run lint:fix                      # Auto-fix violations
```

Max warnings = 45. Ratchet rule: never add new warnings.

### Type Checking

```bash
npm run type-check                    # Full TypeScript pass
npx tsc --noEmit --skipLibCheck       # Quick pass (no emit)
```

### Testing

```bash
npm test                              # Full suite (~2900 tests)
npm run test:changed                  # Changed files only
npm run test:coverage                 # Coverage report
```

Abort if coverage < 70% backend, < 60% frontend (per-file min 40%).

### Security Scanning

```bash
npm run security:check                # Dependency vulns + crypto patterns
npm run audit                         # npm audit (production only)
```

### Bundle Analysis

```bash
npm run build                         # Production build
npm run analyze:bundle                # Size & composition
```

Abort if main bundle gzipped > 150KB or +5% regression from baseline.

## Workflow

1. Format code: `npm run lint:fix`
2. Check types: `npm run type-check`
3. Run tests: `npm run test:changed`
4. Coverage report: `npm run test:coverage`
5. Full lint: `npm run lint`
6. Build & analyze: `npm run build && npm run analyze:bundle`
7. Security audit: `npm run security:check`
8. Review: `npm run review -- --mode branch`

Exit early if any gate fails. Fix, rerun that gate, and skip to next.

## Passing Status

All gates green = safe to push. Verify:

```bash
npm run check:all                     # Single command runs all gates
```

## Team Rules

- Never merge with ESLint warnings > 45.
- Never merge with test coverage below per-file minimums.
- Never merge without running type-check.
- Flaky tests = fix or skip; do not ignore.
- Security findings = fix immediately or document exception.
