# Runsc workspace sandbox provider (foundation)

Status: feature-gated, disabled by default, July 2026.

This phase introduces `RunscSandboxProvider` without enabling it in production.
It is intentionally smaller than the final `/code` runtime: it proves isolated
container lifecycle and keeps every capability that would need more security
work unavailable.

## Trust boundary

The Sira backend never mounts `/var/run/docker.sock`. An optional, non-root,
read-only controller is the only component that receives that socket. Its API
requires a service bearer token; project ids are converted by the backend into
HMAC references and never become Docker names or host paths.

For every workspace, the controller creates random names for:

- one container using exactly `runsc-systrap`;
- one named workspace volume;
- one internal, non-attachable bridge network.

No sandbox joins the Compose default, data, runner-control, or controller
networks. It publishes no host port, has no bind mount or Docker socket, runs as
UID/GID `10001:10001`, uses a read-only root filesystem, drops all capabilities,
sets `no-new-privileges`, and receives hard CPU, memory, PID, TTL and idle
limits. Its environment is an allowlist and contains no platform credentials.

Every create, status, and execution operation reloads container, volume, and
network evidence from Docker inspect. The worker must be selected by its exact
local `sha256:` image id, and both `Config.Image` and the image id observed by
Docker must match. Docker daemon information must also show the fixed
`/usr/local/bin/runsc` path and the exact systrap/sandbox arguments; merely
naming a runtime `runsc-systrap` is insufficient. A mismatch in runtime,
ownership, resources, mounts, network membership, image, environment, expiry,
or labels fails closed. The controller returns an allowlisted instance
attestation and an opaque preview reference; it never returns a Docker id,
resource name, IP, host path, or port.

Lifecycle operations are idempotent and serialized per workspace. Provider
labels and hard expiry timestamps allow startup garbage collection to recover
after controller restarts and remove expired or inconsistent containers,
volumes, and networks. Last activity is atomically persisted in a dedicated
controller-only volume, so restarting the controller neither renews nor
prematurely expires an active workspace.
An exec marker and deadline are persisted before each command starts. If the
controller restarts before clearing that marker, boot kills the affected
sandbox before accepting traffic, preserving the no-overlap command boundary;
the named workspace volume remains available for an explicit restart.

## Deliberately unavailable

`CODEX_RUNSC_SANDBOX_ENABLED=false` and
`CODEX_SANDBOX_PROVIDER=shared-runner` remain the defaults. Even when a canary
selects the new provider, its boot and per-instance attestations advertise:

- `publicMultiTenant=false`;
- `secretRefs=false`.

The file gateway, preview proxy, egress proxy, disk/inode quota, PostgreSQL
leases, artifacts and snapshot/restore are not implemented in this patch.
Consequently, workspace reads/writes, preview start and export reject requests
instead of falling back to the shared runner. General access must remain closed.

The normal production backend runs under PM2 on the host and reaches the
profile-gated controller at `http://127.0.0.1:4098`; that port is published on
loopback only. The optional Docker-backend profile instead overrides
`CODEX_RUNSC_CONTROLLER_URL` to the internal
`http://runsc-sandbox-controller:4098` service address. Enabling the provider
without the controller token, workspace HMAC key, exact worker image id and
verified runtime blocks boot.

## CI evidence

The path-gated `runsc sandbox provider smoke` workflow installs the same pinned
gVisor `runsc` release used by the existing compatibility gate, builds the
versioned controller and worker images, and runs the real controller as the only
Docker-socket holder. It verifies:

- inspect-backed `runsc-systrap` and containment evidence;
- authenticated lifecycle and idempotent create/delete;
- workspace A cannot read workspace B;
- no default route and no route to Redis, the control database, backend,
  runner, Docker gateway or metadata IP; each internal bridge uses Docker's
  isolated IPv4 gateway mode;
- PID, memory and command-time limits contain only the offending sandbox;
- no labeled container, network or volume survives cleanup.

## Licenses and pinning

No JavaScript package was added. The controller uses only Node.js built-ins and
the Docker Engine HTTP API. The runtime inputs are:

- gVisor/runsc — Apache-2.0, release and SHA512 pinned in CI;
- Node.js — MIT, base image pinned by version and digest;
- Bun — MIT, base image pinned by version and digest;
- Debian packages in the worker image — their upstream licenses apply.

The APT repository snapshot is still mutable; production must deploy the exact
CI-built image digest rather than rebuilding it later. This is an explicit P2
reproducibility limitation, not a reason to enable the provider early.
