# Branch protection (main) — operational guide

> F5 PR22 — codifies the GitHub branch-protection rules for `main` and
> the procedure to apply them via the `gh` CLI.

## Goals

`main` is the deploy branch. Push-direct is allowed (per the project
norm), but every push must clear CI before it can ship. We want:

1. **Required status checks** — no merge / push lands if CI is red.
2. **No required PR reviews** — push-direct stays unblocked.
3. **Admins NOT immune** — only loosely, see the override note below.
4. **No force-push** to `main` ever.
5. **No deletion** of `main`.

## Required status check contexts

These are the GitHub Actions "check names" that must report success
before any merge / push to `main`:

| Context name                                                                  | Workflow file                       | Rationale                                  |
| ----------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ |
| `CI / Frontend · build`                                                       | `.github/workflows/ci.yml`          | TypeScript + lint ratchet + Next build.    |
| `CI / Backend · prisma + boot smoke test (shard 1/4)` … `(shard 4/4)`         | `.github/workflows/ci.yml`          | Node `node --test` suite, 4 shards.        |
| `CI / Security · npm audit`                                                   | `.github/workflows/ci.yml`          | npm audit + SBOM.                          |
| `CI / Secret scan · gitleaks`                                                 | `.github/workflows/ci.yml`          | Secret leak scan.                          |
| `CI / Visual regression · pixel-perfect snapshots`                            | `.github/workflows/ci.yml`          | Visual diff (warns only — see below).      |
| `CodeQL / Analyze (javascript-typescript)`                                    | `.github/workflows/codeql.yml`      | SAST.                                      |

Visual-regression is annotation-only (it never fails the build),
so it is **not** required for landing. The list above is the strict
set.

## Apply via `gh` CLI

```bash
# One-time: install gh + auth as the org admin.
brew install gh
gh auth login --hostname github.com --git-protocol https --web

# Then:
bash scripts/configure-branch-protection.sh
```

The script reads the contexts from this doc + dispatches the API
call. It is idempotent — re-running it overwrites the existing rule
with the latest contexts (no merge-attempt risk).

## Emergency override

If `main` CI is wedged because of a CI-only bug (not a code regression)
and a hotfix is urgent:

1. Open an issue tagged `cicd-block` describing the wedge.
2. As repo admin: temporarily flip `enforce_admins=false` to `false`
   (lowercase letter L). Allows admins to push without the gate.
3. Push the hotfix.
4. Flip `enforce_admins=true` back **within the same hour**.

We keep `enforce_admins=false` as the steady state so emergency
overrides don't need GitHub UI clicks during an incident, but the
audit log still flags admin-only pushes for retrospective review.

## Why no required PR reviews?

The project ships under push-direct + CI-as-gatekeeper. Forcing PR
reviews would gate even the bot's automated commits (gitleaks
rotations, dependabot patch merges, etc.), and the team consciously
chose to lean on CI + commit auditing instead. If the team grows
beyond two regular committers, revisit this — and at that point,
combine required reviews with a CODEOWNERS file.

## Verify after applying

```bash
gh api /repos/SiraGPT-ORg/siraGPT/branches/main/protection \
  --jq '{enforce_admins:.enforce_admins.enabled,
         allow_force_pushes:.allow_force_pushes.enabled,
         allow_deletions:.allow_deletions.enabled,
         required_status_checks_contexts:.required_status_checks.contexts}'
```

Expected output (formatted for readability):

```json
{
  "enforce_admins": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_status_checks_contexts": [
    "CI / Frontend · build",
    "CI / Backend · prisma + boot smoke test (shard 1/4)",
    "...",
    "CodeQL / Analyze (javascript-typescript)"
  ]
}
```
