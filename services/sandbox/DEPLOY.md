# SiraGPT sandbox microservice — deploy & architecture

The document agent (Cowork-style) needs a Docker host to run ephemeral, network-less
containers. The main app stays on **Replit, untouched** (domain, DB, deploy intact);
a dedicated server is "the muscle of the sandbox".

```
  ┌─────────────┐   HTTPS (Cloudflare Tunnel)   ┌──────────────────────────────┐
  │  SiraGPT    │  sandbox.chatagic.com         │  Lenovo (Ubuntu 22.04)       │
  │  (Replit)   │ ───────────────────────────▶  │  systemd: siragpt-sandbox    │
  │  doc-agent  │   Bearer SANDBOX_API_KEY       │  node server.js @127.0.0.1:4000│
  │  LOOP + LLM │                                │   └─ docker run (per session)│
  └─────────────┘                                │       siragpt-doc-sandbox    │
        ▲ remote-sandbox.js                       │       --network none, 1cpu,  │
        │ (proxies the 5 tools over HTTP)         │       1g, 100 pids, ephemeral│
        └─ collectOutputs → download cards        └──────────────────────────────┘
```

- The **agentic loop + the LLM key stay on the app** (Replit). Only **tool
  execution** happens on the Lenovo, inside a throwaway container.
- The app auto-selects the remote driver when `SANDBOX_SERVICE_URL` +
  `SANDBOX_API_KEY` are set (see `backend/src/services/doc-agent/sandbox.js`).
- Capacity: **15 concurrent containers** (32 vCPU host), 10-min TTL + GC.

## What this directory ships
- `server.js` — zero-dependency HTTP API (`/health` public; everything else Bearer).
- `lib/docker-sandbox.js` — one ephemeral container per session.
- `runner/Dockerfile` — the runner image (python-docx/openpyxl/python-pptx/pypdf/
  mammoth + LibreOffice headless + poppler + metric fonts), built as
  `siragpt-doc-sandbox:latest`. It is the **only** Dockerfile that builds that
  tag — see «Runner image» below.
- `siragpt-sandbox.service` — systemd unit (binds 127.0.0.1 only, auto-restart).
- `scripts/smoke.js` — post-deploy validation.
- `.env.example` — config template (the real `.env` lives only on the host).

## Server deploy (run on the Lenovo as `lenovo`)
One script does it all (idempotent, no secrets inside):
```bash
# transfer just this directory, then:
cd /home/lenovo/siragpt-sandbox
bash scripts/server-setup.sh            # add --harden-ssh to also lock down SSH
```
What it does (and what was done in production):
1. **Runner image** — `docker build -t siragpt-doc-sandbox:latest runner`.
2. **Config** — generates a strong `SANDBOX_API_KEY` into `.env` (chmod 600) and
   `~/secrets/lenovo-server.txt`.
3. **Service** — installs `siragpt-sandbox.service`, binds **127.0.0.1:4000**,
   `curl http://127.0.0.1:4000/health` → `{"ok":true,"docker":true,...}`.
4. **Dedicated tunnel** — creates a **separate named** cloudflared tunnel
   (`siragpt-sandbox`) with its OWN config (`~/.cloudflared/sandbox-config.yml`)
   and its OWN systemd unit (`cloudflared-sandbox.service`), routes
   `sandbox.chatagic.com` to it by explicit tunnel UUID, and runs it. The
   host's existing cloudflared config (SSH ingress + other sites) is **never
   touched** — a mistake here cannot break SSH access or the other tunnels.

> Why a separate tunnel and not an extra ingress in the shared config? The only
> way into this host is the Cloudflare SSH tunnel; corrupting the shared config
> would mean a permanent lockout. An isolated tunnel removes that risk entirely.

## Deploy on the same host as the app (Docker Compose — production today)

When the app itself runs on the Docker host (the Lenovo production stack), the
service runs as a compose service instead of a systemd unit. `Dockerfile` in
this directory builds it (node:22-alpine + docker-cli); it joins the internal
`app` network, mounts the Docker socket and is never published to the host.

```yaml
  sandbox:
    build:
      context: /home/user/SiraGPT-APP/services/sandbox
      dockerfile: Dockerfile
    image: siragpt-sandbox:latest
    container_name: siragpt-sandbox
    hostname: siragpt-sandbox
    restart: unless-stopped
    environment:
      SANDBOX_BIND: "0.0.0.0"
      SANDBOX_PORT: "4000"
      SANDBOX_API_KEY: ${SANDBOX_API_KEY}          # interpolated from the deploy .env
      SANDBOX_RUNNER_IMAGE: siragpt-doc-sandbox:latest
      SANDBOX_MAX_CONCURRENCY: "8"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    expose: ["4000"]
    networks: [app]
```

The backend then needs, in the same `.env`:

```
SANDBOX_SERVICE_URL=http://siragpt-sandbox:4000
SANDBOX_API_KEY=<same key>
```

`createSandbox()` (auto driver) picks the remote sandbox as soon as both are
set — the backend container itself needs neither the Docker CLI nor the
socket. The runner image is built once on the host:
`docker build -t siragpt-doc-sandbox:latest services/sandbox/runner`.

## Runner image — single builder (edición milimétrica, Fase A)

`services/sandbox/runner/Dockerfile` is the one and only builder of
`siragpt-doc-sandbox:latest`. Until 2026-09-26 `infra/sandbox/Dockerfile` built
the same tag with a different package list (poppler + metric fonts there,
pandas here), so the fonts in production depended on which image was built
last (docs/specs/edicion-milimetrica/SPEC.md, hallazgo 13). The two lists were
merged into the runner Dockerfile and `infra/sandbox/Dockerfile` was removed;
`backend/tests/sandbox-runner-image-contract.test.js` keeps it that way.

What the office engine (`backend/src/services/agent-runner/sira_office.py`)
needs from the image, and why:

| Package | Why |
|---|---|
| `libreoffice` | Renders docx/xlsx/pptx to PDF and recalculates xlsx copies |
| `poppler-utils` | `pdftoppm` rasterizes EVERY page (the old preview only saw page 1); `pdftotext`/`pdfinfo` for text checks and page counts |
| `fonts-crosextra-carlito` / `-caladea` | Metric twins of Calibri / Cambria |
| `fonts-liberation` / `fonts-liberation2` | Metric twins of Arial / Times New Roman / Courier New |
| `pillow`, `lxml` | Before/after composites with zoom; surgical XML edits |

The automatic publish (`.github/workflows/publish-production.yml`) rebuilds
this image whenever anything under `services/sandbox/runner/` changes
(Dockerfile, `capabilities.json`, the checks): it builds a candidate, runs
`/opt/sira/verify_env.py` in it, tags it `latest`, proves the live backend
reaches it (`backend/scripts/verify-agent-sandbox-runtime.cjs`) and restores
the previous image if any step fails. What the image ships is declared once in
`runner/capabilities.json`; the build itself fails unless every package,
binary and Node module imports/resolves (`verify_env.py`) and a real file of
every advertised format is produced and reopened offline (`smoke_formats.py`).

Manual rebuild on the Lenovo, keeping the previous image for rollback:

```bash
cd /home/user/SiraGPT-APP            # at the merged commit
docker tag siragpt-doc-sandbox:latest siragpt-doc-sandbox:rollback-$(date +%Y%m%d)
docker build -t siragpt-doc-sandbox:latest -f services/sandbox/runner/Dockerfile services/sandbox/runner
# verify in a fresh container (expected: Carlito, Liberation Serif, Liberation Sans, pdftoppm version)
docker run --rm siragpt-doc-sandbox:latest sh -c 'fc-match Calibri; fc-match "Times New Roman"; fc-match Arial; pdftoppm -v 2>&1 | head -1; python3 -c "import lxml, PIL; print(\"py ok\")"'
docker run --rm --network none --read-only --tmpfs /tmp siragpt-doc-sandbox:latest python3 /opt/sira/verify_env.py      # → SIRA_ENV_OK
docker run --rm --network none siragpt-doc-sandbox:latest python3 /opt/sira/smoke_formats.py /tmp/f   # → SIRA_FORMATS_OK
docker exec siragpt-sandbox node scripts/smoke.js      # → SMOKE PASS
```

Rollback: `docker tag siragpt-doc-sandbox:rollback-<date> siragpt-doc-sandbox:latest`
(new sessions pick it up immediately; running sessions are ephemeral).

## Validate from anywhere
```bash
SANDBOX_SERVICE_URL=https://sandbox.chatagic.com SANDBOX_API_KEY=<key> \
  node services/sandbox/scripts/smoke.js     # → SMOKE PASS ✅
# /health is 200 without auth; any /v1/* is 401 without the Bearer, 200 with it.
```

## ⚠️ Final manual step — paste into Replit Secrets
The deploy prints these (also stored in `~/secrets/lenovo-server.txt` on the
Lenovo). Add them to the **Replit** app's Secrets so the doc-agent uses the
remote sandbox:

| Secret | Value |
|---|---|
| `SANDBOX_SERVICE_URL` | `https://sandbox.chatagic.com` |
| `SANDBOX_API_KEY` | `<the openssl-generated key>` |

No secrets are committed to the repo — only this template. Rotate the key by
regenerating `.env` on the host + updating the Replit Secret.

## Security posture
- The service binds **127.0.0.1** only; the sole public path is the Cloudflare
  Tunnel (HTTPS) which enforces nothing itself — the Bearer key is the gate.
- Every runner: `--network none` (no egress), 1 vCPU / 1 GB / 100 pids,
  `no-new-privileges`, non-root, auto-removed; per-command 120 s timeout;
  sessions destroyed on TTL (10 min) or `DELETE`.
- The host's own SSH hardening (key-only auth, fail2ban, unattended-upgrades)
  is documented in `scripts/server-setup.sh` and applied during deploy.

### Precision editing toolkit

The runner's `precision` catalog entries are pinned and each names a functional
`proof` in `smoke_precision.py`. They add measured text shaping and glyph
coverage, WOFF2 round trips, colour contrast, independent PDF geometry and Excel
reads, encrypted Office round trips, and strict OOXML preservation. Licences and
scope are recorded in `runner/PRECISION_LIBRARIES.md`. Several packages previously
arrived only transitively; the new direct pins make their availability explicit.

`/opt/sira/sira_layout.py` supplies measurements, not a layout certification.
The agent still renders and inspects the final file. The `office_verify` tool
accepts an optional `expect.preserve` contract specifying exact XML text or
attributes that may change; it protects all remaining parts and values. This
is opt-in for compatibility, and the agent is instructed to use it for narrow
edits. It is deliberately conservative about XML structure and whitespace.

Build validation executes both the existing format smoke and the precision
smoke. The Docker workflow repeats precision proofs as uid 10001, offline, with
a read-only root filesystem and bounded temporary workspace, then saves the
machine-readable report and image identity. No image is published by the tests.

```bash
python3 /opt/sira/smoke_precision.py --list-proofs
python3 /opt/sira/smoke_precision.py /workspace/tmp/precision-proof
```

Adding a library to this toolkit requires a functional proof, not just a
successful import. Library count is not a multiplier of quality, and these
checks do not guarantee every document or every Office feature is supported.


### Document toolkit extension

The runner catalog now advertises 84 explicit Python entries: the previous 60,
twenty-three additional document/data libraries and an explicit `packaging` pin that
was previously transitive. Exact releases, artifact license fingerprints and
operating limits are documented in
[`runner/DOCUMENT_TOOLKIT_LIBRARIES.md`](runner/DOCUMENT_TOOLKIT_LIBRARIES.md).

Thirteen additional proof groups in `smoke_document_toolkit.py`,
`smoke_document_interop.py` and `smoke_document_publishing.py` are registered by
the existing `smoke_precision.py` entrypoint. The same offline, non-root build/CI gate checks
real Word composition, structured edits, candidate matching, units, SVG,
SVG/PNG/PDF charts, Parquet, visual fingerprints, Word merge fields,
BibTeX/RIS metadata, native ODF edits, QR decoding and exact structured diffs. Run the precision command
above in the candidate image and retain `precision-report.json` plus the image
identity before claiming release validation. These checks do not certify every
file format or arbitrary document layout.

Before preparing a remote/Docker document workspace, AgentRunner now compares
`/opt/sira/capabilities.json` with the backend release and checks every declared
Python distribution version. The probe runs once per workspace preparation,
without importing document libraries or reading credentials. Pure text turns
that never allocate a sandbox do not run it. Local development is explicitly
unverified, not treated as proof of the production image.

Release the matching runner image and backend together using the existing
publish workflow, which rebuilds the runner before publishing the app. Old
sessions must be recreated against that image when their release catalog no
longer matches. An image mismatch stops document execution with an actionable
update error; capacity, timeout and process failures remain distinct errors.
CI exercises this same startup probe against the built Linux image in addition
to the functional artifact checks.


### Exact toolkit release check

The production workflow supplies the SHA-256 of the TARGET checkout's backend
catalog as an explicit argument to `verify-agent-sandbox-runtime.cjs`. The
standalone script runs through the actual backend sandbox driver and verifies
that hash before importing document libraries, then checks installed versions,
imports, SAV round trips and every functional proof required by that catalog.
It prints only bounded summary counts, the digest and the driver. A fresh,
non-persistent workspace is used and cleanup is requested in `finally`; the
driver may rely on its session TTL if immediate cleanup fails. This check does not
require an interactive Cloudflare login: the Lenovo runner uses the existing
backend container and its configured internal sandbox connection.

The same check runs after app publication, including an already-live target.
Failure at that point stops release verification without independently restoring
an old runner image underneath the new backend. Public version/readiness checks
remain separate; a green origin check does not certify the public browser path.

Operational limitation: the current workflow retags the document runner before
the app build/activation finishes. On future catalog changes, an old backend
that already enforces a catalog hash can temporarily reject new document tasks
until the matching backend is active. Coordinate the release window and runner /
backend activation; do not disable the integrity check to hide this mismatch.
Existing sessions keep their original image and must be recreated when needed.
