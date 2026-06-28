/**
 * web-fetch — pins the load-bearing security checks of the
 * `web.fetch` MCP tool. Every branch below was added to defend
 * against a specific class of mistake; the tests exist so that a
 * future "small refactor" does not silently regress one of them.
 *
 *   1. Default-disabled posture.
 *   2. Scheme allowlist (http / https only).
 *   3. IP-literal rejection (anti-allowlist-bypass).
 *   4. Private / loopback / link-local / cloud-metadata block.
 *   5. Host suffix allowlist match (no prefix injection).
 *   6. DNS-resolution SSRF defense (rebinding via public DNS A
 *      records pointing at metadata IPs).
 *   7. Body cap (no buffering past the configured limit).
 *   8. Post-redirect host re-validation.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveWebFetchConfig,
  validateRequestUrl,
  resolveAndAssertSafe,
  isPrivateOrReservedAddress,
  hostMatchesAllowlist,
  executeWebFetch,
  WebFetchError,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
} = require("../src/services/connectors/web-fetch");

describe("resolveWebFetchConfig", () => {
  test("disabled when neither env var is set", () => {
    const cfg = resolveWebFetchConfig({});
    assert.equal(cfg.enabled, false);
    assert.deepEqual(cfg.allowedHosts, []);
    assert.equal(cfg.defaultMaxBytes, DEFAULT_MAX_BYTES);
    assert.equal(cfg.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
  });

  test("disabled when only MCP_WEB_FETCH_ENABLED=true (no allowlist) — fail closed", () => {
    const cfg = resolveWebFetchConfig({ MCP_WEB_FETCH_ENABLED: "true" });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.enabledFlag, true);
  });

  test("disabled when only the allowlist is set (no enabled flag)", () => {
    const cfg = resolveWebFetchConfig({ MCP_WEB_FETCH_ALLOWED_HOSTS: "example.com" });
    assert.equal(cfg.enabled, false);
  });

  test("enabled only when BOTH env vars are set", () => {
    const cfg = resolveWebFetchConfig({
      MCP_WEB_FETCH_ENABLED: "true",
      MCP_WEB_FETCH_ALLOWED_HOSTS: "example.com",
    });
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.allowedHosts, ["example.com"]);
  });

  test("allowed hosts are lowercased + trimmed + deduplicated by entry", () => {
    const cfg = resolveWebFetchConfig({
      MCP_WEB_FETCH_ENABLED: "1",
      MCP_WEB_FETCH_ALLOWED_HOSTS: "  EXAMPLE.com , api.example.com,",
    });
    assert.deepEqual(cfg.allowedHosts, ["example.com", "api.example.com"]);
  });
});

describe("isPrivateOrReservedAddress", () => {
  test("IPv4 private ranges blocked", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "0.0.0.0"]) {
      assert.equal(isPrivateOrReservedAddress(ip), true, `${ip} must be blocked`);
    }
  });

  test("IPv4 public addresses allowed", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.5"]) {
      assert.equal(isPrivateOrReservedAddress(ip), false, `${ip} should NOT be blocked`);
    }
  });

  test("IPv6 loopback / link-local / ULA blocked", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd00::1"]) {
      assert.equal(isPrivateOrReservedAddress(ip), true);
    }
  });

  test("NAT64 / 6to4 embedding a private/metadata IPv4 blocked", () => {
    // 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) can smuggle a private/loopback/
    // metadata IPv4 through hextets the ::-anchored hex form missed.
    for (const ip of ["64:ff9b::7f00:1", "64:ff9b::c0a8:101", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::"]) {
      assert.equal(isPrivateOrReservedAddress(ip), true, `${ip} must be blocked`);
    }
    // …but public embeddings are not over-blocked.
    for (const ip of ["2002:0808:0808::", "2607:f8b0:4005:80a::200e"]) {
      assert.equal(isPrivateOrReservedAddress(ip), false, `${ip} should NOT be blocked`);
    }
  });

  test("non-IP strings return false (the URL-level check catches them earlier)", () => {
    assert.equal(isPrivateOrReservedAddress("example.com"), false);
  });

  test("nullish input fails closed (true = blocked)", () => {
    assert.equal(isPrivateOrReservedAddress(""), true);
    assert.equal(isPrivateOrReservedAddress(null), true);
  });
});

describe("hostMatchesAllowlist", () => {
  test("exact match wins", () => {
    assert.equal(hostMatchesAllowlist("example.com", ["example.com"]), true);
  });

  test("suffix match: subdomain of allowed host is allowed", () => {
    assert.equal(hostMatchesAllowlist("api.example.com", ["example.com"]), true);
    assert.equal(hostMatchesAllowlist("a.b.example.com", ["example.com"]), true);
  });

  test("prefix injection NOT allowed (notexample.com vs example.com)", () => {
    assert.equal(hostMatchesAllowlist("notexample.com", ["example.com"]), false);
  });

  test("suffix injection NOT allowed (example.com.attacker.tld)", () => {
    assert.equal(hostMatchesAllowlist("example.com.attacker.tld", ["example.com"]), false);
  });

  test("empty allowlist rejects every host", () => {
    assert.equal(hostMatchesAllowlist("example.com", []), false);
  });
});

describe("validateRequestUrl", () => {
  const allow = ["example.com"];

  test("accepts https://api.example.com/path", () => {
    const url = validateRequestUrl("https://api.example.com/v1/resource", allow);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "api.example.com");
  });

  test("rejects ftp://", () => {
    assert.throws(() => validateRequestUrl("ftp://example.com/", allow), { code: "web_fetch_unsupported_scheme" });
  });

  test("rejects file:///etc/passwd", () => {
    assert.throws(() => validateRequestUrl("file:///etc/passwd", allow), { code: "web_fetch_unsupported_scheme" });
  });

  test("rejects gibberish (unparseable)", () => {
    assert.throws(() => validateRequestUrl("not a url", allow), { code: "web_fetch_invalid_url" });
  });

  test("rejects IP literal even when allowlist is empty", () => {
    assert.throws(() => validateRequestUrl("https://203.0.113.5/", allow), { code: "web_fetch_ip_literal_rejected" });
  });

  test("rejects localhost by name", () => {
    assert.throws(() => validateRequestUrl("https://localhost/", allow), { code: "web_fetch_blocked_host" });
  });

  test("rejects host not on allowlist", () => {
    assert.throws(() => validateRequestUrl("https://attacker.tld/", allow), { code: "web_fetch_host_not_allowlisted" });
  });

  test("rejects example.com.attacker.tld (suffix injection)", () => {
    assert.throws(() => validateRequestUrl("https://example.com.attacker.tld/", allow), { code: "web_fetch_host_not_allowlisted" });
  });
});

describe("resolveAndAssertSafe", () => {
  test("rejects when DNS resolves to a private address (rebinding defense)", async () => {
    const fakeLookup = async () => [{ address: "169.254.169.254", family: 4 }];
    await assert.rejects(
      () => resolveAndAssertSafe("attacker-rebind.example.com", fakeLookup),
      { code: "web_fetch_resolved_blocked" },
    );
  });

  test("rejects when ALL records are public except one private (any-private-blocks)", async () => {
    const fakeLookup = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await assert.rejects(
      () => resolveAndAssertSafe("mixed.example.com", fakeLookup),
      { code: "web_fetch_resolved_blocked" },
    );
  });

  test("passes when all records are public", async () => {
    const fakeLookup = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ];
    await assert.doesNotReject(() => resolveAndAssertSafe("public.example.com", fakeLookup));
  });

  test("rejects when DNS lookup itself fails", async () => {
    const fakeLookup = async () => {
      const err = new Error("nope");
      err.code = "ENOTFOUND";
      throw err;
    };
    await assert.rejects(
      () => resolveAndAssertSafe("nonexistent.example.com", fakeLookup),
      { code: "web_fetch_dns_failed" },
    );
  });
});

describe("executeWebFetch — disabled posture", () => {
  test("throws web_fetch_disabled when no env vars are set", async () => {
    await assert.rejects(
      () => executeWebFetch({ url: "https://example.com" }, {}),
      { code: "web_fetch_disabled" },
    );
  });

  test("throws web_fetch_disabled when allowlist is empty", async () => {
    await assert.rejects(
      () => executeWebFetch(
        { url: "https://example.com" },
        { MCP_WEB_FETCH_ENABLED: "true" },
      ),
      { code: "web_fetch_disabled" },
    );
  });
});

describe("executeWebFetch — happy path with mocked fetch", () => {
  // Build a fake fetch that returns a body of N bytes for size-cap tests.
  function makeFakeFetch(body, { status = 200, contentType = "text/plain", url = null } = {}) {
    return async (input) => {
      const text = body;
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      return {
        status,
        url: url || (typeof input === "string" ? input : input.toString()),
        headers: {
          get: (h) => (h.toLowerCase() === "content-type" ? contentType : null),
        },
        body: {
          getReader() {
            return {
              async read() {
                if (offset >= bytes.length) return { done: true, value: undefined };
                const chunk = bytes.subarray(offset);
                offset = bytes.length;
                return { done: false, value: chunk };
              },
              cancel() {},
            };
          },
        },
        async text() { return text; },
      };
    };
  }

  test("success returns status / contentType / body / truncated:false", async () => {
    const result = await executeWebFetch(
      { url: "https://api.example.com/v1/data" },
      {
        MCP_WEB_FETCH_ENABLED: "true",
        MCP_WEB_FETCH_ALLOWED_HOSTS: "example.com",
      },
      {
        skipDnsCheck: true,
        fetch: makeFakeFetch("hello world", { status: 200, contentType: "text/plain" }),
      },
    );
    assert.equal(result.status, 200);
    assert.equal(result.contentType, "text/plain");
    assert.equal(result.body, "hello world");
    assert.equal(result.truncated, false);
    assert.equal(result.finalUrl, "https://api.example.com/v1/data");
  });

  test("body exceeding maxBytes is truncated, not buffered fully", async () => {
    const big = "x".repeat(5000);
    const result = await executeWebFetch(
      { url: "https://api.example.com/big", maxBytes: 1024 },
      {
        MCP_WEB_FETCH_ENABLED: "true",
        MCP_WEB_FETCH_ALLOWED_HOSTS: "example.com",
      },
      {
        skipDnsCheck: true,
        fetch: makeFakeFetch(big),
      },
    );
    assert.equal(result.truncated, true);
    assert.equal(result.body.length, 1024);
    assert.equal(result.bytesRead, 1024);
  });

  test("rejects post-redirect host hop to a non-allowlisted host", async () => {
    // The fake fetch claims it ended up at attacker.tld — after-the-fact
    // we re-validate the final URL, so the response is rejected.
    await assert.rejects(
      () => executeWebFetch(
        { url: "https://api.example.com/redirect" },
        {
          MCP_WEB_FETCH_ENABLED: "true",
          MCP_WEB_FETCH_ALLOWED_HOSTS: "example.com",
        },
        {
          skipDnsCheck: true,
          fetch: makeFakeFetch("redirected", { url: "https://attacker.tld/" }),
        },
      ),
      { code: "web_fetch_host_not_allowlisted" },
    );
  });

  test("throws web_fetch_invalid_arguments when url is missing", async () => {
    await assert.rejects(
      () => executeWebFetch(
        {},
        {
          MCP_WEB_FETCH_ENABLED: "true",
          MCP_WEB_FETCH_ALLOWED_HOSTS: "example.com",
        },
      ),
      { code: "web_fetch_invalid_arguments" },
    );
  });
});
