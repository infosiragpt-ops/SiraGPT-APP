---
name: dependency-upgrade-guard
description: "Safely evaluate and land dependency, package, Docker, and build-tool upgrades in SiraGPT with rollback-aware validation."
---

# Dependency Upgrade Guard

Use this skill for package upgrades, lockfile refreshes, Docker image changes, runtime version changes, and build tool migrations.

## Contract

- Do not upgrade broad dependency sets without a reason.
- Separate dependency changes from feature code when practical.
- Read changelogs for major/runtime-sensitive packages.
- Run install, type-check, focused tests, and build before push.
- Watch bundle size and server startup behavior.

## Checklist

```bash
npm install
npm --prefix backend install
npm run type-check
npm run build
node scripts/bundle-size-check.js
```

For backend dependency changes, also run tests around the touched subsystem.

## Risk Areas

- Next.js, React, TypeScript, Prisma, OpenAI SDKs, auth libraries, streaming libraries.
- Native/image/video packages.
- Dockerfile and compose changes.
- GitHub Actions versions and Node versions.

## Rollback Notes

- Keep lockfile diffs reviewable.
- Record previous version in commit body for high-risk upgrades.
- If production deploy fails after dependency change, inspect rollback result and pin back quickly.

