/**
 * sandbox-adapter — contract for the "Ejecución segura de código" layer.
 *
 * Designed to bind cleanly to:
 *   - E2B           (managed isolated sandboxes for agents)
 *   - Modal         (serverless containers / sandboxes)
 *   - Docker        (per-task throwaway containers)
 *   - Firecracker   (microVMs with KVM)
 *   - gVisor        (user-space kernel sandbox)
 *   - Kubernetes Job(per-task pods)
 *
 * The platform NEVER runs untrusted code in the host process. All
 * code execution goes through this adapter.
 *
 * Public methods:
 *
 *   start({ template, env, timeout_ms, mem_mb, network })  → handle
 *   exec(handle, { language, code, args, stdin, files })   → { stdout, stderr, exit_code, files_out }
 *   readFile(handle, path)
 *   writeFile(handle, path, contents)
 *   stop(handle)
 *
 * Stub provides a safe no-op runner that:
 *   - validates the language
 *   - checks for obvious dangerous patterns (rm -rf, fork bombs)
 *   - returns a deterministic placeholder
 *
 * Real production binds E2B / Docker / Firecracker.
 */

const VENDORS = Object.freeze(["e2b", "modal", "docker", "firecracker", "gvisor", "kubernetes-job", "stub"]);

const SUPPORTED_LANGUAGES = Object.freeze(["python", "node", "javascript", "typescript", "bash", "sh"]);

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,            // fork bomb
  /chmod\s+777\s+\//,
  /dd\s+if=\/dev\/zero\s+of=\/dev\/sda/i,
  /\bcurl\s+\S+\s*\|\s*(sh|bash)\b/i,
  /\bwget\s+\S+\s*-O-\s*\|\s*(sh|bash)\b/i,
];

function createSandboxAdapter({ provider = null, vendor = "stub" } = {}) {
  if (!VENDORS.includes(vendor)) throw new Error(`sandbox-adapter: unknown vendor "${vendor}"`);
  const impl = provider || createStubProvider();
  validateProvider(impl);

  return {
    vendor,
    provider: impl,

    async start({ template = "default", env = {}, timeout_ms = 30000, mem_mb = 512, network = false } = {}) {
      return impl.start({ template, env, timeout_ms, mem_mb, network });
    },

    async exec(handle, { language, code, args = [], stdin = "", files = [] } = {}) {
      if (!handle) throw new Error("sandbox-adapter.exec: handle required");
      if (!SUPPORTED_LANGUAGES.includes(language)) throw new Error(`sandbox-adapter.exec: unsupported language "${language}"`);
      if (typeof code !== "string" || code.length === 0) throw new Error("sandbox-adapter.exec: code (string) required");
      const reasons = scanForDanger(code);
      if (reasons.length > 0) {
        const e = new Error(`sandbox-adapter.exec: rejected — ${reasons.join(", ")}`);
        e.code = "policy_violation";
        throw e;
      }
      return impl.exec(handle, { language, code, args, stdin, files });
    },

    async readFile(handle, path) { return impl.readFile(handle, path); },
    async writeFile(handle, path, contents) { return impl.writeFile(handle, path, contents); },
    async stop(handle) { return impl.stop(handle); },

    capabilities() {
      return {
        vendor,
        languages: impl.languages || SUPPORTED_LANGUAGES,
        supports_network: Boolean(impl.supports_network),
        supports_filesystem: Boolean(impl.supports_filesystem),
        supports_gpu: Boolean(impl.supports_gpu),
        max_memory_mb: impl.max_memory_mb || 512,
        max_timeout_ms: impl.max_timeout_ms || 60000,
      };
    },
  };
}

function validateProvider(p) {
  for (const m of ["start", "exec", "readFile", "writeFile", "stop"]) {
    if (typeof p[m] !== "function") throw new Error(`sandbox-adapter: provider missing ${m}()`);
  }
}

function scanForDanger(code) {
  const issues = [];
  for (const re of DANGEROUS_PATTERNS) if (re.test(code)) issues.push(re.source);
  return issues;
}

function createStubProvider() {
  const handles = new Map();
  let seq = 0;
  return {
    languages: SUPPORTED_LANGUAGES,
    supports_network: false,
    supports_filesystem: true,
    supports_gpu: false,
    max_memory_mb: 256,
    max_timeout_ms: 30000,

    async start({ template, env, timeout_ms, mem_mb, network }) {
      const id = `stub_box_${++seq}`;
      handles.set(id, { id, template, env, timeout_ms, mem_mb, network, files: new Map(), started_at: Date.now() });
      return { id };
    },
    async exec(handle, { language, code, args, stdin }) {
      if (!handles.has(handle.id)) throw new Error("sandbox-adapter (stub): handle not found");
      return {
        stdout: `[stub:${language}] code length=${code.length}, args=${args.length}, stdin=${stdin.length}`,
        stderr: "",
        exit_code: 0,
        files_out: [],
        wallclock_ms: 1,
      };
    },
    async readFile(handle, path) {
      const box = handles.get(handle.id);
      if (!box) throw new Error("sandbox-adapter (stub): handle not found");
      return box.files.get(path) || null;
    },
    async writeFile(handle, path, contents) {
      const box = handles.get(handle.id);
      if (!box) throw new Error("sandbox-adapter (stub): handle not found");
      box.files.set(path, contents);
      return { path, size: typeof contents === "string" ? contents.length : (contents && contents.length) || 0 };
    },
    async stop(handle) {
      handles.delete(handle.id);
      return { ok: true, id: handle.id };
    },
  };
}

module.exports = {
  createSandboxAdapter,
  createStubProvider,
  VENDORS,
  SUPPORTED_LANGUAGES,
  DANGEROUS_PATTERNS,
};
