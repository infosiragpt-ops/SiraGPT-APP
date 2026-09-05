# Reviewed Lenovo release (no schema changes)

Production runs on Lenovo through Cloudflare. Do not use the retired legacy VPS
workflow, `/opt/siragpt`, DNS changes or database-baseline tags for this release.
The deployment and SSH credentials stay on the authorized client/server, never
in Git or command output.

## Release gates

1. Review the PR against current `production-main`, preserving newer published
   changes. Require successful CI for the exact final commit. Merge normally;
   never bypass protected-branch checks or use a force push.
2. Require successful push CI for the merged main SHA. Read public `/api/version`
   and `/api/health/ready`; record the expected previous SHA. Verify the Lenovo
   checkout is clean, then update with a fast-forward only. Stop on concurrent
   changes or any schema/migration difference.
3. Inspect the actual `/home/user/deployments/iliagpt/compose.yaml`: only the
   gateway should bind loopback; PostgreSQL and Redis must not publish ports.
   Public frontend URLs must point to `https://siragpt.com`, not localhost.
4. Install `deploy/iliagpt/publish-reviewed.sh` as the existing executable
   `/home/user/deployments/iliagpt/publish.sh`, preserving the old script in a
   private, uniquely named backup first. Verify the uploaded file's hash and
   `bash -n`. The operator must have reviewed this version before invoking it.

## Publish

Invoke through the existing, host-key-verified `siragpt-lenovo` SSH alias:

```sh
/home/user/deployments/iliagpt/publish.sh FULL_MERGED_MAIN_SHA FULL_PREVIOUS_LIVE_SHA
```

The script requires the checkout already at the approved target. It uses the
shared publication lock, never deletes an existing lock, and does not change
branches itself. Backups and detailed build output are private under the
printed `backups/reviewed-...` directory. Do not paste those logs or `.env`.

Before activation it validates a PostgreSQL custom-format dump, saves exact
previous app-image IDs, builds the candidate images and verifies the image-size
patch within the candidate backend with no network or credentials. It checks
that the checkout, public release, configuration, running images and release
metadata have not changed during the build. Only then does it change the two
release metadata keys and activate runner/backend/frontend. Database, Redis,
gateway, volumes and DNS are left untouched.

The database archive is checked with gzip and `pg_restore --list`; this is not
a restore rehearsal. Retain backups until a separately reviewed restore and
retention policy is confirmed. Existing automatic backups are not replaced.

## Failure and rollback

On activation/readiness failure the script restores only the old release keys,
preserving other current secrets, and restores the three previous app-image IDs.
It verifies the previous public SHA and database/Redis/migration readiness.
Exit 2 means rollback could not be verified and requires operator investigation.
Do not claim successful release, delete volumes, reset the checkout or restart
the Docker daemon to bypass a failure. Build failures stop before activation.

## Public proof

Run `node scripts/verify-lenovo-release.cjs FULL_MERGED_MAIN_SHA` from an external
client. Confirm `/agentes`, source-preserving document editing and downloaded
artifact contents through the real runtime; distinguish synthetic adapter/UI
checks from an authenticated model request. A green build or merge is not a
publication. The manual GitHub workflow **Verify Lenovo production release**
provides an additional read-only SHA/readiness check after publication.

Do not enable that workflow while GitHub still holds the legacy auto-deployer.
First verify its merged contents contain only the read-only workflow, then enable
and dispatch it with the exact published SHA. It has no production credentials.
