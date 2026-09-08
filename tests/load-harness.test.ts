import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { spawn } from "node:child_process"
import path from "node:path"
import { describe, it } from "node:test"

// Black-box integration tests for the zero-dependency load harness CLI.
// Each test boots a throwaway loopback HTTP server, then spawns the
// harness as a child process (async — a sync exec would starve the
// event loop serving the requests) and asserts its exit-code contract:
//   0 = all SLO gates pass, 1 = gate violation, 2 = usage error.

const HARNESS = path.join(process.cwd(), "scripts", "load-harness.mjs")

interface HarnessResult {
  code: number | null
  stdout: string
  stderr: string
}

function runHarness(args: string[]): Promise<HarnessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("error", reject)
    child.on("exit", (code) => resolve({ code, stdout, stderr }))
  })
}

function listenWith(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer(handler)
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  })
}

function urlOf(srv: Server): string {
  const addr = srv.address()
  assert.ok(addr && typeof addr === "object")
  return `http://127.0.0.1:${addr.port}/`
}

function parseJsonSummary(stdout: string): { passed: boolean; results: Array<Record<string, unknown>> } {
  const start = stdout.indexOf("{")
  assert.ok(start >= 0, `expected JSON summary in stdout:\n${stdout}`)
  return JSON.parse(stdout.slice(start))
}

describe("load-harness · CLI contract", () => {
  it("passes SLO gates on a healthy target and reports percentiles", async () => {
    const srv = await listenWith((req, res) => {
      setTimeout(() => res.end("ok"), 30)
    })
    try {
      const result = await runHarness([
        "--url", urlOf(srv),
        "--stages", "2,4",
        "--duration", "1",
        "--warmup", "0",
        "--quiet", "--json",
      ])
      assert.equal(result.code, 0, `harness should pass: ${result.stderr}`)
      const summary = parseJsonSummary(result.stdout)
      assert.equal(summary.passed, true)
      assert.equal(summary.results.length, 2)
      for (const stage of summary.results) {
        assert.equal(stage.errorRate, 0)
        const p95 = stage.p95 as number
        const p50 = stage.p50 as number
        assert.ok(p50 >= 25, `injected 30ms delay must show up in p50 (got ${p50}ms)`)
        assert.ok(p95 >= p50, `p95 must be >= p50 (got ${p95} < ${p50})`)
        assert.ok((stage.rps as number) > 0)
      }
    } finally {
      srv.close()
    }
  })

  it("fails with exit code 1 when the p95 SLO gate is violated", async () => {
    const srv = await listenWith((req, res) => {
      setTimeout(() => res.end("ok"), 30)
    })
    try {
      const result = await runHarness([
        "--url", urlOf(srv),
        "--concurrency", "2",
        "--duration", "1",
        "--warmup", "0",
        "--slo-p95", "5",
      ])
      assert.equal(result.code, 1, "strict p95 gate must fail the run")
      assert.match(result.stderr + result.stdout, /SLO GATE FAILED/)
    } finally {
      srv.close()
    }
  })

  it("fails with exit code 1 when the error-rate gate is violated (HTTP 500)", async () => {
    const srv = await listenWith((req, res) => {
      res.statusCode = 500
      res.end("boom")
    })
    try {
      const result = await runHarness([
        "--url", urlOf(srv),
        "--concurrency", "2",
        "--duration", "1",
        "--warmup", "0",
      ])
      assert.equal(result.code, 1, "100% error rate must fail the run")
      assert.match(result.stderr + result.stdout, /SLO GATE FAILED/)
      assert.match(result.stderr + result.stdout, /HTTP 500/)
    } finally {
      srv.close()
    }
  })

  it("rejects usage without --url with exit code 2", async () => {
    const result = await runHarness([])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /--url is required/)
  })
})
