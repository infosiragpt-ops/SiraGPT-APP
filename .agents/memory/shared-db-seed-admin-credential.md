---
name: Shared dev+prod DB makes the seeded admin a live credential
description: Why you must never put the seed admin user id in a shared/production allowlist for privileged actions on this project.
---

# The seed admin is a LIVE credential in production

This project uses **ONE shared Prisma/Accelerate DB for dev AND prod**, and a boot
seeder **resets the seed admin account's password to a fixed, well-known value on
every backend restart**. Because the DB is shared, that account also works on
**production (siragpt.com)** — anyone who knows the static seed password can log in
as admin there.

Implication for any owner/allowlist gate (e.g. an env var that authorizes
server-side code execution):
- **Never** put the seed admin id in a `shared` or `production`-scoped allowlist for
  a privileged/dangerous action — it would hand that capability to the public seed
  backdoor on the live site.
- Use the real owner's account id (not the seed admin) for production gates.
- **But** in the dev preview the session is logged in AS the seed admin (the stable
  local login). So a feature gated to "owner only" appears broken in the preview
  unless the seed admin id is allowed *in development*.

**Fix pattern (applied):** scope the allowlist env var per environment instead of
`shared`:
- `production`: the owner's real id only.
- `development`: the owner's real id + the seed admin id (so the preview works).
Delete the `shared` copy first (a `shared` var can't be overridden per-env).

**Why:** balances "owner can test in the preview" against "don't expose a
server-side capability to the public seed backdoor on the shared prod DB".

**How to apply:** any time you add a per-user gate for a sensitive action, decide
dev vs prod scoping deliberately; assume the preview session is the seed admin, and
assume that same account is reachable by anyone on production.

Separate pre-existing risk worth flagging to the owner: the seed admin's static
password being valid on the live site is itself a security hole (out of scope of the
code-runner work, but real).
