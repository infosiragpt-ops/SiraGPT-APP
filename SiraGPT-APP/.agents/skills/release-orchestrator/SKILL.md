---
name: release-orchestrator
description: "Release automation: versioning, changelog generation, GitHub release creation, deployment coordination, and rollback procedures."
---

# Release Orchestrator

Coordinate SiraGPT releases with precision and safety.

## Contract

- Releases are tagged with semver: `v{MAJOR}.{MINOR}.{PATCH}`
- Changelog is auto-generated from commit messages
- GitHub release includes curated notes, assets, and installer links
- Main branch is always releasable (CI green, tests passing)
- Hotfixes to production use dedicated `release/*` branches

## Release Process

### Pre-Release: Validate Everything

```bash
# 1. Ensure main is clean
git status                          # Must be clean

# 2. Pull latest
git pull --rebase origin main

# 3. Run full validation
npm run check:all                   # Lint, type, test, coverage, security
npm run build                       # Production build
npm run test:e2e                    # E2E tests
npm run security:audit              # Security audit

# 4. Generate changelog
npm run release:changelog:generate

# 5. Preview release
npm run release:preview -- v1.2.3
```

### Create Release

```bash
# 1. Bump version (auto by semver type)
npm run release:bump -- [major|minor|patch]

# 2. Tag & commit
npm run release:tag

# 3. Generate GitHub release
npm run release:create -- --release-notes

# 4. Upload assets (if any)
npm run release:upload-assets -- --version v1.2.3

# 5. Publish
npm run release:publish
```

### Post-Release: Monitor Rollout

```bash
# 1. Verify GitHub release published
gh release view --repo SiraGPT-ORg/siraGPT

# 2. Monitor deployment (if auto-deploy)
npm run deploy:status

# 3. Check metrics (errors, latency, availability)
npm run metrics:health -- --since "5 minutes ago"

# 4. If issues found, initiate rollback
npm run deploy:rollback -- v1.2.2
```

## Versioning Strategy

- **MAJOR** (v2.0.0): Breaking API changes, major features
- **MINOR** (v1.2.0): New features, backward compatible
- **PATCH** (v1.2.3): Bug fixes, security patches

Use `npm run release:bump -- [major|minor|patch]`.

## Changelog Generation

```bash
# Auto-generate from commits
npm run release:changelog:generate

# Format:
# v1.2.3 (2026-05-26)
#
# ✨ Features
# - Agent system validation (agent-validation)
# - Performance profiler (performance-profiler)
#
# 🐛 Bug Fixes
# - Fix sandbox timeout handling
# - Fix tool registry lookup race condition
#
# 🔒 Security
# - Update crypto dependencies
# - Add secret scanning to CI
#
# 📊 Performance
# - Reduce bundle size by 8%
# - Optimize agent task startup by 20%
#
# 🎯 Internal
# - Refactor agent core
# - Add performance benchmarks
```

Commits are categorized by prefix:
- `feat:` → ✨ Features
- `fix:` → 🐛 Bug Fixes
- `security:` → 🔒 Security
- `perf:` → 📊 Performance
- `refactor:`, `chore:`, `test:` → 🎯 Internal

## GitHub Release

```bash
# Create release with notes
npm run release:create -- --version v1.2.3 --notes "
## New Features
- Agent validation system
- Performance profiler skill

## Breaking Changes
None

## Migration Guide
No changes required.

## Thank You
Thanks to all contributors!
"

# Attach binary artifacts (if any)
npm run release:upload -- --file releases/siraGPT-v1.2.3.tar.gz

# Mark as latest
npm run release:mark-latest -- v1.2.3
```

## Hotfix Process

For critical fixes to production:

```bash
# 1. Branch from last release tag
git checkout -b release/v1.2.4 v1.2.3

# 2. Apply fix
# ... make changes ...

# 3. Test thoroughly
npm run test
npm run test:e2e

# 4. Bump patch version
npm run release:bump -- patch

# 5. Push & create PR
git push origin release/v1.2.4
gh pr create --base main --fill

# 6. After merge, tag release
npm run release:tag -- v1.2.4
npm run release:create -- --version v1.2.4

# 7. Update production deployment
npm run deploy -- v1.2.4
```

## Rollback

If critical issue found after release:

```bash
# 1. Identify issue
npm run metrics:health -- --since "10 minutes ago" | grep error

# 2. Verify previous version is stable
npm run test -- --version v1.2.2

# 3. Initiate rollback
npm run deploy:rollback -- v1.2.2

# 4. Verify rollback
npm run deploy:status

# 5. File incident report
npm run incident:report -- "v1.2.3 rolled back due to [reason]"

# 6. Fix issue locally
# ... fix code ...
npm run test

# 7. Create v1.2.4 hotfix
npm run release:bump -- patch
npm run release:tag
npm run release:create
npm run deploy -- v1.2.4
```

## Deployment Targets

- **Staging:** Auto-deploy on PR merge
- **Production:** Manual approval on tag push
- **Canary:** Optional 10% traffic to new version (24h before full rollout)

## Release Checklist

- [ ] All tests passing (`npm test`)
- [ ] Type checking clean (`npm run type-check`)
- [ ] Linting clean (`npm run lint`)
- [ ] Security audit clean (`npm audit`)
- [ ] Performance baseline stable (`npm run perf:compare`)
- [ ] E2E tests passing (`npm run test:e2e`)
- [ ] Changelog generated (`npm run release:changelog:generate`)
- [ ] Version bumped (`npm run release:bump`)
- [ ] Tag created (`npm run release:tag`)
- [ ] GitHub release created (`npm run release:create`)
- [ ] Deployment verified (`npm run deploy:status`)
- [ ] Metrics healthy for 1 hour post-deploy

## Team Rules

- Never release with failing tests
- Never skip security audit
- Main branch must always be releasable
- Hotfixes branch from release tag, not main
- Rollback if error rate > 1% or latency P95 > 2x baseline
- Update CHANGELOG.md with every release
