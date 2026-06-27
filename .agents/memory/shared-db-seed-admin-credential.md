---
name: Shared dev+prod DB makes the seeded admin a live credential
description: Why you must never put the admin@example.com seed user id in a shared/production allowlist for privileged actions on this project.
---

# admin@example.com is a LIVE credential in production

This project uses **ONE shared Prisma/Accelerate DB for dev AND prod**, and a
boot seeder **rewrites admin@example.com's password to `password` on every
backend restart** (documented stable local credential in CLAUDE.md). Because the
DB is shared, that account + password also works on **production (siragpt.com)** —
anyone can log in as admin there.

Implication for any owner/allowlist gate (e.g. CODE_HOST_RUNNER_ALLOWED_USER_IDS
that authorizes server-side code execution):
- **Never** put the seed admin id (`cmpm0ml410000d7iat3t2hvl3`) in a `shared` or
  `production`-scoped allowlist for a privileged/dangerous action — it would hand
  that capability to the public admin/password backdoor on the live site.
- The real owner (Jorge) is `carrerajorge874@gmail.com`
  (`cmprr3bh4jpA2M7TAvTQV30js0mbC`) — that is the only id safe for production.
- **But** in the dev preview the owner is logged in AS admin@example.com (the
  stable local login). So a feature gated to "owner only" appears broken in the
  preview unless the admin id is allowed *in development*.

**Fix pattern (applied):** scope the allowlist env var per environment instead of
`shared`:
- `production`: owner's real id only.
- `development`: owner's real id + the admin seed id (so the preview works).
Delete the `shared` copy first (a `shared` var can't be overridden per-env).

**Why:** balances "owner can test in the preview" against "don't expose a
server-side capability to the public admin backdoor on the shared prod DB".

**How to apply:** any time you add a per-user gate for a sensitive action, decide
dev vs prod scoping deliberately; assume the preview session is admin@example.com,
and assume that same account is reachable by anyone on production.

Separate pre-existing risk worth flagging to the owner: admin@example.com /
`password` being valid on the live site is itself a security hole (out of scope of
the code-runner work, but real).
