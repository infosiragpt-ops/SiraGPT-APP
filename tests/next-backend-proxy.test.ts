import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

type Rewrite = { source: string; destination: string }

// Import the actual Next config in a fresh process: deployment flags are read
// during module initialization and must not leak between build scenarios.
function generatedBackendRewrites(overrides: Record<string, string> = {}): Rewrite[] {
  const env = { ...process.env }
  for (const key of ["BACKEND_INTERNAL_URL", "DOCKER_BUILD", "REPLIT_DEPLOYMENT", "NEXT_OUTPUT"]) {
    delete env[key]
  }
  const configUrl = pathToFileURL(path.join(process.cwd(), "next.config.mjs")).href
  const script = `
    const { default: config } = await import(${JSON.stringify(configUrl)});
    const rewrites = await config.rewrites();
    process.stdout.write(JSON.stringify(rewrites.afterFiles));
  `
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...env, ...overrides },
    encoding: "utf8",
    timeout: 10_000,
  }))
}

function assertBackendDestinations(rewrites: Rewrite[], base: string) {
  const sources = ["/api/:path*", "/ws/desktop/:sessionId", "/uploads/:path*", "/metrics"]
  for (const source of sources) {
    assert.equal(rewrites.find((rewrite) => rewrite.source === source)?.destination, `${base}${source}`, source)
  }
}

test("Docker builds route backend fallthroughs to the Compose backend service", () => {
  assertBackendDestinations(generatedBackendRewrites({ DOCKER_BUILD: "true" }), "http://backend:5000")
})

test("an explicit backend URL keeps precedence in Docker builds", () => {
  assertBackendDestinations(generatedBackendRewrites({
    DOCKER_BUILD: "true",
    BACKEND_INTERNAL_URL: "http://configured-backend:5055",
  }), "http://configured-backend:5055")
})

test("local builds preserve the local backend default", () => {
  assertBackendDestinations(generatedBackendRewrites(), "http://127.0.0.1:5050")
})

test("Replit builds preserve normalization of the legacy local backend port", () => {
  for (const configured of ["", "http://localhost:5000", "http://127.0.0.1:5000"]) {
    assertBackendDestinations(generatedBackendRewrites({
      REPLIT_DEPLOYMENT: "1",
      DOCKER_BUILD: "true",
      BACKEND_INTERNAL_URL: configured,
    }), "http://127.0.0.1:5050")
  }
})
