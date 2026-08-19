---
name: Untrusted child-process env scrub
description: Spawning repo/generated code must use an env allowlist, never ...process.env.
---

The /code host-runner (`backend/src/services/code/host-runner.js`, `envFor`) and the
GitHub workspace-runner (`backend/src/services/github/workspace-runner.service.js`)
spawn UNTRUSTED code (a user repo's dev/build command via shell). They MUST build the
child env with `buildUntrustedChildEnv()` (`backend/src/utils/untrusted-child-env.js`),
which forwards only an OS/toolchain allowlist (PATH, HOME, Nix/SSL, npm dirs, …) plus
explicit non-secret overrides (PORT, NODE_ENV, …).

**Why:** SiraGPT's backend and the spawned dev server share the SAME process env,
which holds every secret (DATABASE_URL, SESSION_SECRET, Stripe/R2/AI keys). Spreading
`...process.env` into repo code lets arbitrary scripts read `process.env` and exfiltrate
all of them. This regressed once via a merge and was caught in code review.

**How to apply:** Never write `env: { ...process.env, ... }` for any spawn of repo,
generated, or otherwise untrusted code — use `buildUntrustedChildEnv(extra)`. If a dev
server legitimately needs a new non-secret host var, add it to `ALLOWED_ENV_KEYS`;
never add a secret/credential there. `git.service.js` intentionally keeps
`...process.env` because it runs our own git, not repo scripts.
