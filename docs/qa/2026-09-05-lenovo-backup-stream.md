# Lenovo backup validation stream correction

The first reviewed publication of PR #563 stopped before building or activating
any application container. Production remained at
`ff61eeb9d980775cb75900d5350278c58e098243`, externally healthy, with unchanged
runner/frontend/backend/database/Redis start timestamps. No rollback was needed.

## Confirmed cause and correction

The real 35,739,173-byte gzip archive passed `gzip -t`, and `pg_restore --list`
successfully read its table of contents. It then closed stdin before the producer
finished sending the archive. With `pipefail`, gzip's SIGPIPE correctly stopped
the publisher: producer exit 141, consumer exit 0.

The correction drains the remaining stream in the same database exec shell,
preserving the exit status of `pg_restore` and failing on a drain failure. Global
`pipefail` and the gzip integrity check remain in place. It does not ignore
SIGPIPE or weaken the pre-activation gate.

A read-only comparison using that same real archive and PostgreSQL container
confirmed producer/consumer statuses **141/0 before** and **0/0 after** the fix.
The archive was listed, not restored; no database data or active service changed.

## Regression coverage

- All 37 publisher tests pass, including the 32 existing orchestration checks
  and five new stream probes. An independent reviewer reproduced that result.
- Five additional probes use real gzip, POSIX pipes and an 8 MiB payload:
  reproduce the old SIGPIPE; drain without adding payload to the TOC; preserve
  invalid-archive consumer status; reject drain failure; reject corrupt gzip.
- These stream probes use a short-reading `pg_restore` stand-in, not a real
  database. The real PostgreSQL/Compose comparison above covers that boundary.
- Six backend deployment/canary/migration contract suites: 110 tests passed,
  with no omissions or contract changes.

This is an operational publisher correction, not a frontend/backend application
feature change. GitHub CI and the next publication must still be verified before
claiming that the document release is public. Archive integrity/TOC checks are
not a full database restoration rehearsal.
