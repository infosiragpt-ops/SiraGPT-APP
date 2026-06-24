---
name: postbuild-slim is destructive — never run full build locally
description: `npm run build` runs scripts/postbuild-slim.js which DELETES node_modules/.next/artifacts/attached_assets etc from the live workspace
---

The package.json `build` script ends with `npm run postbuild:slim`
(`scripts/postbuild-slim.js`). When run with `REPLIT_DEPLOYMENT=1` it PRUNES the
workspace to fit the 8 GiB deploy image — it DELETES `node_modules`, `.next`,
`artifacts/`, `attached_assets/`, and other large/untracked dirs from the live
working tree. On deploy that's fine (fresh image). In the dev workspace it is
DESTRUCTIVE and wiped tracked + untracked files.

**Rule:** never run a full `npm run build` in the dev workspace to test a build.
To validate a build, run `next build` ONLY (without `REPLIT_DEPLOYMENT=1` and
without the postbuild step), or run it in a throwaway probe and be ready to
restore.

**Recovery if it happens:**
- Tracked dirs: `git archive HEAD -- <dir1> <dir2> | tar -x` (read-only git;
  `git checkout`/`restore`/`reset` are policy-blocked from direct bash).
- `node_modules` (root): re-run `npm ci` — too long for the 120s bash cap, so
  run it via a temporary workflow (configureWorkflow / restart_workflow) and poll
  with refresh_all_logs; workflows survive between tool calls, bash/code_execution
  background procs do not.
- Untracked/gitignored dirs (e.g. `artifacts/`) are NOT recoverable via git —
  recreate them if needed.
