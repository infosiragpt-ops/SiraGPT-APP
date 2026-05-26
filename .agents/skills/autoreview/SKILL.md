---
name: autoreview
description: "Automated code review with structured quality checks. Validates logic, security, performance, and maintainability before merge."
---

# AutoReview

Structured code review automation for SiraGPT backend, frontend, and agent systems.

## Contract

- Review output is advisory. Verify every finding by reading the actual code and adjacent files.
- Treat security findings as high-priority but validate them against the real attack surface.
- Reject speculative risks and over-complicated rewrites; prefer small, targeted fixes.
- Rerun focused tests after any code changes; rerun review to confirm the fix.
- For agent-system changes, validate tool registry and task runner compatibility.
- Do not blindly apply findings; prioritize maintainability and codebase coherence.
- Keep reviews focused on one concern: logic/security/perf/maintainability.

## Pick Target

Branch/PR work:

```bash
npm run review -- --mode branch --base origin/main
```

Local uncommitted changes:

```bash
npm run review -- --mode local
```

Committed work on main:

```bash
npm run review -- --mode commit --commit HEAD
```

## Usage

Review before merge:

```bash
# Backend changes
npm run review -- backend/src/services/**/*.js

# Agent system
npm run review -- backend/src/services/agents/**/*.js

# Frontend components (structure only, not UI)
npm run review -- app/**/page.tsx --focus logic

# Full validation
npm run review -- --comprehensive --output review.json
```

Parallel execution:

```bash
npm run review -- --parallel-tests "npm run test:changed" --mode branch
```

## Checks

- **Logic:** control flow, error handling, edge cases, state management
- **Security:** input validation, SQL injection, CSRF, secrets exposure, crypto usage
- **Performance:** N+1 queries, memory leaks, unneeded recursion, bulk operations
- **Maintainability:** naming, duplication, test coverage, documentation
- **Agent-specific:** tool registry consistency, task manifest validation, sandbox safety

## Final Report

Include:

- Review command and target
- Tests run (focused or full)
- Findings accepted/rejected + reason
- Clean review exit (no actionable findings)

Stop review as soon as the helper exits with no findings. Do not run extra cycles for wording improvement.
