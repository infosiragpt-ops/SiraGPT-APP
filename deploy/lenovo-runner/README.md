# Lenovo · GitHub Actions runner (auto-publish)

Since 2026-09-12 every commit that lands on `production-main` is published to
https://siragpt.com automatically. The mechanism:

```
PR → squash-merge → push production-main → CI (push) ─┐
                                                       ▼
   Publish production (Lenovo)  ──►  self-hosted runner (this container)
   .github/workflows/publish-production.yml            on the Lenovo, uid 1000
                                                       │
                                                       ▼
            /home/user/deployments/iliagpt/publish.sh <target> <live>
            (the same reviewed script an operator runs by hand)
```

There is no inbound port, no DNS change and no new secret: the runner polls
GitHub over outbound HTTPS with the identity created at registration.

## What runs where

| Piece | Location |
|---|---|
| Runner container `siragpt-github-runner` | Lenovo Docker host (started from the deploy bastion via the socket) |
| Runner identity + work dir | volume `siragpt-github-runner-home` |
| Repo checkout used by the publish | `/home/user/SiraGPT-APP` (host path, bind-mounted 1:1) |
| Deployment (compose, `.env`, backups) | `/home/user/deployments/iliagpt` (host path, bind-mounted 1:1) |
| Workflow | `.github/workflows/publish-production.yml` (labels `self-hosted, linux, siragpt-lenovo`) |

The container runs as the host uid/gid (1000) and the docker socket group, so
everything the publish writes stays owned by the Lenovo user, exactly as a
manual run from the bastion.

## Install / re-install (from the bastion)

```bash
# On the Mac: mint a short-lived registration token (repo admin) and copy the files
gh api -X POST repos/infosiragpt-ops/SiraGPT-APP/actions/runners/registration-token --jq .token \
  | ssh siragpt-lenovo 'umask 077; mkdir -p /home/user/deployments/siragpt-publisher; cat > /home/user/deployments/siragpt-publisher/runner.token'
scp -r deploy/lenovo-runner siragpt-lenovo:/home/user/deployments/siragpt-publisher/runner

# On the bastion
cd /home/user/deployments/siragpt-publisher/runner
RUNNER_TOKEN_FILE=../runner.token ./install.sh && rm -f ../runner.token
```

Re-running `./install.sh` without a token rebuilds the image and recreates
the container while keeping the registration (identity lives on the volume).

## Operate

```bash
docker logs -f siragpt-github-runner          # listener + job output
docker restart siragpt-github-runner
docker stop siragpt-github-runner             # pause auto-publish (jobs queue in GitHub)
```

- GitHub → Settings → Actions → Runners shows `siragpt-lenovo` (Idle/Active).
- Each publication appears as a run of **Publish production (Lenovo)** with the
  target SHA in its summary; private build logs stay on the Lenovo under
  `deployments/iliagpt/backups/reviewed-<sha>-*/publish.log`.
- To publish a specific commit by hand: run the workflow manually with
  `target_sha`, or ssh in and run `publish.sh` as before (both use the same
  script; the workflow's `concurrency` group serialises automatic runs, but a
  manual bastion run does not share the container's `/tmp` lock — do not run
  both at once).

## Gates that still apply

1. Only `production-main` pushes trigger it; the branch is protected (PR +
   green CI, no force-push).
2. The job waits for the **push** CI of the exact SHA to be green.
3. `publish.sh` refuses dirty checkouts, non-fast-forward targets, schema or
   migration diffs, unhealthy baselines, and rolls back on failure.
4. `scripts/verify-lenovo-release.cjs` must confirm `/api/version` and
   `/api/health/ready` after activation.

Schema/migration changes are still a separately reviewed release (the script
stops before activation) — merge them and publish by hand following
`docs/operations/LENOVO_REVIEWED_RELEASE.md`.
