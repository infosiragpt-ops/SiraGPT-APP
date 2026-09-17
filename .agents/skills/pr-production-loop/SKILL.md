---
name: pr-production-loop
description: Ship a change to SiraGPT production the safe way — branch from production-main, conventional commits, PR, green CI, squash-merge, then publish on the Lenovo origin with SHA-pinned verification.
version: 0.1.0
metadata:
  inspired_by:
    - github-pr-workflow
  upstream:
    repository: https://github.com/NousResearch/hermes-agent
    commit: 8b69ec03af50de892ae0bca1f7e2384a8f6eb5a8
    license: MIT
    path: skills/github/github-pr-workflow/SKILL.md
---

# PR Production Loop

Use this when a code or docs change must reach `https://siragpt.com`
(production = Lenovo oficina + túnel Cloudflare). One change = one PR.
Native SiraGPT rewrite of the generic branch → commit → PR → CI → merge
lifecycle: every step below is pinned to this repo's gates
(`production-main`, required checks, SHA-pinned publish, no secrets in chat).

## Contract

- Base is ALWAYS `production-main`. NEVER push to `main`. NEVER `--admin`
  merge while CI is red.
- One PR = one change. Docs-only PRs never publish (§20).
- Conventional commits (`feat|fix|docs|test|ci|chore|refactor|perf(scope): …`).
- Mergea Luis (§21). The agent prepares the PR and leaves CI green.
- Secrets (`.env`, keys, tokens, cookies, SSH keys, passphrases) NEVER go
  in chat, PR bodies, logs or transcripts. Only secret NAMES may be named.
- Prod network is untouchable: no DNS edits, no new VPS, no new `.env`,
  no `git reset --hard`, no `compose down -v` on the origin.

## Loop

### 1. Branch from the tip

```bash
git fetch origin production-main
git checkout -B <type>/<short-slug> origin/production-main
```

If the remote moved mid-work: `git pull --rebase` before any push.

### 2. Change + validate locally

Stage only intended files, then prove the gates that CI will run:

```bash
npm test
npm run lint
npx tsc --noEmit --skipLibCheck
```

UI files (`app/`, `components/`, `hooks/`, `lib/` UI, `styles/`) additionally
need `npm run ui-lock:verify` — or `ui-lock:update` when the visual change
is intentional — plus the source-contract tests under `tests/`.

### 3. Commit + push the branch

```bash
git commit -m "type(scope): concise change"
git push -u origin <type>/<short-slug>
```

The pre-commit hooks run the secret scan, lint and type-check. If hooks
reject, fix and commit again — never `--no-verify` to dodge them.

### 4. Open the PR against `production-main`

```bash
gh pr create --base production-main --head <type>/<short-slug> \
  --title "type(scope): concise change" \
  --body "Qué cambia / por qué / cómo se verificó (comandos + resultado)"
```

The body states what changed, why, and the local verification evidence.
Never paste secrets, tokens or `.env` content in the body.

### 5. CI must go green — wait for it

```bash
gh pr checks <N>   # repeat until no "pending"
```

The gate that matters is **CI · required checks passed**. On failure:
read the failed job log (`gh run view <id> --log-failed`), fix the code,
push again, and re-wait. Never force-merge red. Never weaken or skip a
test to land.

### 6. Hand off the merge

Squash-merge happens only with CI green, and Luis merges (§21):

```bash
gh pr merge <N> --squash --delete-branch --subject "type(scope): concise change (#N)"
```

If the base moved while CI ran and the PR shows BEHIND/CONFLICTING:
rebase onto the new tip, re-verify, force-push with lease, and re-wait
for CI. Then hand off again.

### 7. Publish on the Lenovo origin (SHA-pinned)

Only for non-docs changes, from a shell with the deploy SSH route:

```bash
# en /home/user/SiraGPT-APP (Lenovo, usuario deploy):
git fetch origin
git checkout -B deploy-from-github origin/production-main   # nunca reset --hard
/home/user/deployments/iliagpt/publish.sh <TARGET_SHA> <PREVIOUS_SHA>
```

Both SHAs are full 40-char lowercase. TARGET ≠ PREVIOUS, and PREVIOUS
must be the live release (verified via `/api/version`) and an ancestor
of TARGET — `publish.sh` enforces this and refuses otherwise. If a
`publish.sh` for that SHA is already running, wait for the lock; never
launch a second one.

### 8. Verify production

```bash
curl -sI https://siragpt.com            # → 200
curl -s https://siragpt.com/api/health  # críticos healthy (db, redis, migrations); resto puede ser degraded
```

Confirm the live commit matches TARGET:

```bash
curl -s -H 'Cache-Control: no-cache' https://siragpt.com/api/version
```

If the deploy changed `.env`, recreate only the backend afterwards
(`docker compose up -d --no-deps --force-recreate backend` from the
`iliagpt/` dir). Never `down -v`.

## Failure triage (in order)

1. CI red → failed job log → fix code → push → re-wait (§5).
2. PR BEHIND/CONFLICTING → rebase → re-verify → push with lease → re-wait.
3. `publish.sh` refuses (SHA/ancestor/baseline mismatch) → re-read its
   error, realign TARGET/PREVIOUS with the live release, retry once.
4. Prod health not healthy after publish → read backend logs on the
   origin, fix forward with a new PR. Rollback only via the approved
   rollback path — never improvise destructive commands on the origin.

## Validation

```bash
npm run skill:validate:agents
npm run agent:hermes:map -- --json
```
