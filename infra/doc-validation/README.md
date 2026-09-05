# Independent document validation image

This image is not the editor. It executes only the reviewed validator, never an
agent recipe. The worker passes pristine read-only inputs and a frozen plan. No
credentials, Docker socket or editor-writeable volume enter the container.

Build from the repository root with an audited base digest:

```sh
docker build --build-arg BASE_IMAGE=ubuntu@sha256:<approved-digest> -f infra/doc-validation/Dockerfile -t siragpt/doc-validation:<release> .
```

The release process must record `/opt/validator/os-packages.lock`,
`python-packages.lock`, installed font inventory and the resulting image digest.
Runtime accepts `image@sha256:...` or a full local `sha256:...` image ID, uses
`--pull never` and requires `runsc`. Tags and short IDs are rejected.
Missing tools/runtime/image are failures; there is no host fallback. The launcher
kills/removes the container after timeout/cancellation, not merely its CLI client.
Cleanup failure is an explicit error requiring reconciliation. Artifacts use a
32 MiB private tmpfs, never a writeable host bind, and at most 16 MiB are returned
inline to the worker (32 MiB transport limit including Base64 and manifests).
The image has a separate 600-second hard deadline, even if its worker disappears.
Containers carry label `siragpt.role=doc-validation`; reconcile exited orphan
containers and their private staging directories against durable worker leases.
Do not blindly remove live containers owned by another running worker.
A candidate image was built on Lenovo on 2026-09-05 UTC:
`sha256:1a2be5c74d0291ffb120dbb5d8adb9689672858a181946adb7082c3398c4becc`.
Writer/Calc/Impress conversion, qpdf, extraction and rendering passed without
network as UID 65532. This was a **component test under runc**, not gVisor
attestation or an application deployment. Production eligibility remains blocked.

Runtime setup status on Lenovo (2026-09-04): the fixed gVisor package was installed,
but its SIGHUP helper exited 1 with an unrecorded precise cause. Runtime registration
did not take effect. The newly created daemon.json was restored to its originally
absent state using verified backup/CAS; all 23 production container identities and
start times remained unchanged, with core services healthy. No security profile
was relaxed and no daemon/container was restarted. The package and backup remain;
runsc is **not available** yet. See `install-runtime-result.md` for exact evidence.
Do not treat package installation or unit tests as an isolated-runtime pass.

A Dockerized worker must configure `stagingRoot` as a dedicated directory mounted
at the identical absolute path on the Docker host and inside the worker. Provision
it as 0700 owned by the worker UID; symlinks, group/other access, non-normalized or
relative paths are rejected. Per-job children are 0700; only their input directory
is bound read-only into the validator. The native-host development default uses a
private child of the OS temporary directory; that default is not a shared-volume
configuration for a Dockerized worker. No source directory is created/chmodded
implicitly, so a bad deployment mapping fails closed rather than exposing inputs.

The Python CLI consumes one JSON request on stdin. `inspect` produces a private
inventory. `validate` returns four independently executed levels, cuts at the
first failure, and exports private PNG/diff artifacts. Level 5 is the worker's
pristine-input retry policy. Reports and inventory can contain document data and
must never be sent to application logs.

Flat text has parser/encoding validation and no pretend Office rendering: levels
2/3 are explicitly `applicable:false, passed:false` with a reason. Office and PDF
require every level. PDF overlays use black Helvetica, single-line Latin text,
PDF-point bottom-left coordinates; unsupported scripts/rotated-overlay ambiguity
fail rather than silently choosing another font or coordinate transform.

Direct Python invocation is intended only for anonymous developer fixtures. It is
not proof of Docker/gVisor isolation, which requires a real runtime test before
release. PDF structural validation always requires `qpdf --check`.

Developer fixture tests require `requirements-test.txt` plus LibreOffice and
Poppler and qpdf on PATH. Run `python3 backend/tests/doc-sandbox-validation.test.py` or set
`DOC_VALIDATION_TEST_PYTHON` for the Node wrapper. These tests are not skipped when
tools are missing. They include real Writer/Calc/Impress render/recalculation,
notes-page rendering, actual raster differences and negative ZIP/XML cases.
`python-pptx` generates the anonymous fixture only; it is never an editor/runtime
dependency. XLSX shared-string cloning is explicitly unavailable until phase two;
changing a shared entry without a cell-scoped validator is rejected.

Startup now submits a fixed, random-hash-bound `preflight` request before any
worker is started. The reviewed validator checks UID/GID 65532, loopback-only
interfaces, and actual Writer/Calc/Impress conversion, qpdf checks, text extraction
and PNG decoding. Direct-host `preflight_tools()` tests are separate component
evidence, never a substitute for the real `runsc` invocation. Redis readiness is
a renewable lease, not proof of the document container's isolation.

APT uses content-addressed indexes (`Acquire::By-Hash=force`) and fails incomplete
updates; signature/date/package-hash verification remains on. This addresses an
observed mirror index hash mismatch without accepting a corrupt download.

`Dockerfile.tests` is a separate development image for reviewed synthetic
fixtures. Supply audited `NODE_IMAGE` (application dependencies),
`NODE_RUNTIME_IMAGE` (official glibc Node binary) and `VALIDATOR_IMAGE` inputs.
Do not copy an Alpine/musl Node executable into Ubuntu: the first component-test
image demonstrated that loader incompatibility. The corrected build executes
`node --version` to reject it before tests. No Node binary or document-generator
libraries are added to the production validator. These developer containers have
no network, no production mounts/secrets, dropped capabilities and hard limits;
they never replace the required runsc acceptance suite.

API references checked during implementation (2026-09-04):

- [Python ZIP](https://docs.python.org/3/library/zipfile.html)
- [lxml parser controls](https://lxml.de/parsing.html)
- [LibreOffice command-line options](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)
- [LibreOffice notes-page PDF options](https://help.libreoffice.org/latest/en-US/text/shared/guide/pdf_params.html)
- [qpdf validation](https://qpdf.readthedocs.io/en/stable/cli.html)
- [Pillow image differences](https://pillow.readthedocs.io/en/stable/reference/ImageChops.html)
- [pypdf merge](https://pypdf.readthedocs.io/en/stable/user/merging-pdfs.html)
- [pypdf watermark](https://pypdf.readthedocs.io/en/stable/user/add-watermark.html)
- [ReportLab Canvas](https://docs.reportlab.com/reportlab/userguide/ch2_graphics/)

No PyMuPDF or restricted document skills are vendored here.
