# Isolated document browser tests

`run-isolated-browser.sh` boots the full application with synthetic password
authentication, a real test database and real file uploads, then runs the two
`@no-provider-call` cases in `e2e/document-sandbox.spec.ts`. The document engine
is disabled. The tests pause the actual capabilities request, click the existing
Stop control, and verify that the draft and original attachment remain and no
job admission was submitted. No API response is substituted.

Run from the candidate checkout after preparing the test database:

```sh
sg docker -c 'bash infra/doc-validation/run-isolated-browser.sh /home/user/deployments/doc-sandbox-phase1-tests/candidate-git-561 doc_sandbox_history_browser_561_20260905 /tmp/doc-sandbox-browser-new-run'
```

The evidence directory must be new. It contains mode-0600 synthetic configuration
and private app logs, plus browser screenshots taken only after authentication.
Keep it private: future fixtures may contain documents. Traces, video and automatic
failure screenshots are disabled to avoid recording password entry.

Prerequisites on the isolated test host:

- Candidate checkout and its installed frontend/backend dependencies, no `.env`
  files in either application root, and an installed Playwright Chromium.
- Local test image
  `sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e`
  with the reviewed glibc Node runtime.
- Internal Docker network `doc-sandbox-phase1-test`; test-scoped, unexposed
  `doc-sandbox-history-postgres` and `doc-sandbox-test-redis` containers. PostgreSQL
  fixture credentials are `doc_fixture` / `fixture-only-isolated`.
- A disposable `doc_sandbox_history_*` database with the complete application
  migration history, including F1, and the application schema required by the
  current Prisma client. The seeder rejects a document-only schema.
- Free loopback ports 15161/15162, approximately 8 GiB available memory and three
  CPU cores for the limited backend/frontend containers. Cold Next.js compilation
  can take several minutes.

Both application containers use an internal network without external egress,
read-only source, dropped capabilities and tmpfs writable directories. Only
synthetic configuration is provided. Host TCP relays expose their fixed internal
addresses on loopback, because an internal Docker network does not publish NAT
ports on this host. The runner removes its apps and relays, and stops only test
services it started. An already-running PostgreSQL container remains running.

The migration-only evidence is independent. The original historical database
`doc_sandbox_history_46398ff88700c639` passed 132 base migrations, the F1 migration,
a repeated deploy and migration status. The browser database is a separate clone
aligned for application boot using the repository CI's `prisma db push` approach.
That exposed pre-existing migration/datamodel drift; this browser alignment is
not evidence that F1 reconciles that drift. Preserve the original database and
`test-migration-history-result.md` when preparing or repairing browser fixtures.
The alignment removed raw credit tables absent from the Prisma datamodel.
`restore-browser-credit-schema.cjs` restores only their schema, enum, indexes and
foreign keys from the original synthetic database to the fixed browser clone;
it rejects existing objects. The seeder checks these tables before application
boot. The repair copied no account or transaction data and preserved the aligned
user/chat/file/document-job schema.

## Result on 2026-09-05 UTC

Run D passed both Chromium cases in 43.2 seconds: new chat 16.0 s and existing
empty chat 26.2 s. Both verified real password login and DOCX upload, no idle Stop,
visible Stop during admission, and the restored draft and original attachment
after releasing the interrupted request. The completion/failure listener was
registered before Send. No document admission POST or browser page error occurred.
TypeScript and the spec's lint checks also passed.

Evidence: `/tmp/doc-sandbox-browser-561-d-run.log` and the four `stop-*.png` /
`restored-*.png` files under `/tmp/doc-sandbox-browser-561-d/browser/`. This run
used candidate `6ac1a4bd` based on production-main `09fa991c`, with the reviewed
test-only fixes. It did not test the concurrent later production changes.
The disabled engine and synthetic configuration establish admission cancellation
coverage, not provider, storage, worker or gVisor acceptance.

Visual review also observed a generic "No se pudo iniciar la edición verificada"
toast after cancelling admission; the restored draft and original were correct.
This is a remaining experience detail, with no additional product change in this
verification pass.

The runner exited 0, removed both application containers and TCP relays, stopped
the Redis service it started, and released ports 15161/15162. The pre-existing
synthetic history PostgreSQL service remained running for its owner to stop;
its databases and volume were preserved.
After the browser task released it, the parent task verified its scope, pinned
image, internal network and lack of published ports, then stopped that history
PostgreSQL container too. Its final state is `exited`, with the volume preserved.

## Provider acceptance is a separate run

The no-provider runner cannot execute `@real-provider`. That case requires an
explicit `DOC_SANDBOX_E2E_EXECUTE_REAL=1`, existing shared campaign authorization
and advisory lock, the provider's enforced spending cap, and a trusted test
backend configured with an active finite `DOC_SANDBOX_MAX_COST_USD`. The spec
inspects the fixed backend container and selected non-secret settings before
admission; a budget variable in the Playwright process alone is insufficient.

The worker additionally needs the exact private shared staging directory, the
Docker launcher/socket, a pinned validator image and working `runsc`. The spec
checks the source/staging/socket mount allowlist. Configure these only in a
separate authorized test environment; the no-provider harness grants none of
those mounts or provider credentials. Run the paid case with
`npm run test:e2e:docs -- --grep @real-provider` only after all its gates pass.
