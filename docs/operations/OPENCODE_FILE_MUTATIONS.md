# SiraCode: conditional file edits

## Source and scope

Native adaptation of the file mutation contract in
[OpenCode at ecbc6ccac85b3e8087b6445e584318419b9e2b34](https://github.com/anomalyco/opencode/tree/ecbc6ccac85b3e8087b6445e584318419b9e2b34):

- `packages/core/src/file-mutation.ts`: compare expected bytes and commit
  under a cooperating process-local lock; create a new target exclusively.
- `packages/core/src/effect/keyed-mutex.ts`: serialize cooperating mutations
  by canonical target path without introducing a global filesystem lock.
- `LICENSE`: MIT, Copyright (c) 2025 opencode. Matching license text is
  retained at `vendor/opencode/LICENSE` and attribution in
  `THIRD_PARTY_NOTICES.md`.

The native implementation uses Node APIs in the existing SiraCode engine.
It does not import or launch the upstream runtime. The pin above identifies
the reviewed source, **not** all files in the historical vendor snapshot.
No UI, model, dependency, database, runtime flag or deployment setting changes.
After updating to production base `24b6047fff48abdb70e39a3cffdc5040cfa9400c`,
the edit caller lives in `file-tools.js` (#621), not `tools.js`. Existing
newline handling, argument aliases, explicit replace-all and result metadata
are preserved. Canonical workspace roots also keep macOS temporary-directory
aliases consistent with the existing path jail. Roots that are themselves
symbolic links are refused.

## Acceptance contract

| Capability | Required observable behavior |
| --- | --- |
| Conditional edit/update | If source bytes change after the mutation snapshot, return a conflict instead of overwriting the newer content. |
| Exclusive patch Add | Two attempts cannot silently overwrite each other's new file; a pre-existing target stays intact. |
| Safe patch Move | A destination collision does not change either source or destination; a successful move preserves the edited content. |
| Complete source | Mutation reads fail closed on oversized or unsupported input; display truncation is never treated as the complete original. |
| Literal replacement | `$&`, `$$`, prefix/suffix replacement markers and Unicode are written as requested, not interpreted as JavaScript replacement directives. |
| Permissions | Existing read-only and approval rules still run before mutation. |
| File types and aliases | Reject links and non-regular mutation targets, including pipes, rather than blocking or using ambiguous lock identities. |

## Limits

This is **one integrated capability**, not 100% parity with OpenCode.
The source snapshot is captured inside the edit operation; it is not a ledger
of what the model read in a previous turn. An explicit full-file `write`
retains its intentional replacement semantics.

Cooperating mutation serialization is in-process only. This is not an OS
sandbox, a cross-process lock, protection against an adversarial shell or
an all-or-nothing multi-file transaction. Concurrent non-cooperating writes,
process termination and disk failures require separate runtime/recovery work.
Do not infer production isolation from these filesystem tests.
These checks harden mutation paths; they do not certify every existing read or
shell tool as an isolation boundary.

When an edit reports a conflict, read the current file, re-evaluate the requested
change and retry only that change with the user's existing permissions. Do not
automatically fall back to an unconditional overwrite. A failed multi-file patch
must be inspected for earlier operations already applied before retrying.

## Reproducible verification

Verified on 2026-09-08 with Node 24.19.0. From the repository root:

```sh
NODE_ENV=test node --test \
  backend/tests/sira-code-*.test.js \
  backend/tests/codex-opencode-harness.test.js \
  backend/tests/opencode-route.test.js \
  backend/tests/opencode-client.test.js \
  backend/tests/codex-github-clone-publish-route.test.js \
  backend/tests/backend-dockerfile.test.js
```

Result: **320/320**, zero failures/skips, including **26 new cases** in
`sira-code-file-mutation.test.js` and `sira-code-mutation-loop.test.js`.
The general root `NODE_ENV=test npm test` lane passed **12,494/12,494** with
no skips. Counts are not added together as unique acceptance tests.
TypeScript, lint (zero warnings in changed files), UI-lock and the scoped
secret scan passed. No coverage thresholds, quarantines or F1 lanes changed.

Mutation tests use real temporary files; the loop test scripts only the model
responses. Existing HTTP/provider/runner/GitHub harnesses retain their own
fixtures. No remote repository is cloned or published by these test doubles.
These are not paid-provider or production end-to-end tests. New tests are
discovered by `backend/scripts/test-shard.sh` in CI, not by the older explicit
backend `npm test` file list.

Review reproduced and closed a FIFO-open hang and Unicode alias lost writes
(sigma/final-sigma, Latin/long-s, mu/micro-sign on APFS). Conditional writes
resolve existing paths through the filesystem; a lowercase-only lock key is
insufficient. The Unicode cases also test distinct filenames on case-sensitive
filesystems without omitting the tests.

Production acceptance is separate: the public SHA must contain the reviewed
change, required CI must pass, and the real authenticated file-edit flow must
be checked. A local passing suite or an open PR is not a production release.
