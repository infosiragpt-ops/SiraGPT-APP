/**
 * api-docs — pins the env-gate (resolveApiDocsConfig) and the
 * "disabled" mode router shape. We deliberately do NOT integration-
 * test the full Swagger UI mount here — swagger-ui-express ships
 * compiled HTML/JS assets that are best validated by the CI smoke
 * test (visit /api-docs and check for 200 + non-empty body).
 *
 * Two properties matter:
 *
 *   1. Default OFF in production, ON elsewhere. A typo in NODE_ENV
 *      shouldn't accidentally expose the docs in prod.
 *
 *   2. When disabled the router still RESPONDS — with a JSON 404
 *      that points the operator at the env flag — instead of
 *      Express's generic "Cannot GET /api-docs" page.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const {
  resolveApiDocsConfig,
  buildApiDocsRouter,
} = require("../src/routes/api-docs");

describe("resolveApiDocsConfig", () => {
  test("default ON in development", () => {
    const cfg = resolveApiDocsConfig({ NODE_ENV: "development" });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.isProduction, false);
  });

  test("default ON when NODE_ENV is unset", () => {
    const cfg = resolveApiDocsConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.isProduction, false);
  });

  test("default OFF in production", () => {
    const cfg = resolveApiDocsConfig({ NODE_ENV: "production" });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.isProduction, true);
  });

  test("API_DOCS_ENABLED=true overrides production default", () => {
    const cfg = resolveApiDocsConfig({
      NODE_ENV: "production",
      API_DOCS_ENABLED: "true",
    });
    assert.equal(cfg.enabled, true);
  });

  test("API_DOCS_ENABLED=false overrides non-production default", () => {
    const cfg = resolveApiDocsConfig({
      NODE_ENV: "development",
      API_DOCS_ENABLED: "false",
    });
    assert.equal(cfg.enabled, false);
  });

  test("Custom title falls through from env", () => {
    const cfg = resolveApiDocsConfig({ API_DOCS_TITLE: "Sira Internal" });
    assert.equal(cfg.title, "Sira Internal");
  });

  test("NODE_ENV is case-insensitive (Production / PRODUCTION recognized)", () => {
    assert.equal(resolveApiDocsConfig({ NODE_ENV: "Production" }).isProduction, true);
    assert.equal(resolveApiDocsConfig({ NODE_ENV: "PRODUCTION" }).isProduction, true);
  });
});

// Helper: spin up a tiny express app with the router mounted, hit
// it once, and tear it down. Avoids supertest as a dep.
function callRouter(router, path) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use("/api-docs", router);
    const server = app.listen(0, () => {
      const { port } = server.address();
      http.get(
        { hostname: "127.0.0.1", port, path },
        (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            server.close();
            resolve({ statusCode: res.statusCode, body, headers: res.headers });
          });
        },
      ).on("error", (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe("buildApiDocsRouter — disabled mode", () => {
  test("returns 404 with a JSON hint pointing operators at the env flag", async () => {
    const router = buildApiDocsRouter({
      env: { NODE_ENV: "production" }, // disabled by default
    });
    const { statusCode, body } = await callRouter(router, "/api-docs/");
    assert.equal(statusCode, 404);
    const json = JSON.parse(body);
    assert.equal(json.error, "api-docs disabled");
    assert.match(json.hint, /API_DOCS_ENABLED/);
  });
});

describe("buildApiDocsRouter — enabled mode", () => {
  test("/openapi.json returns the JSON spec without auth", async () => {
    const fakeSpec = {
      openapi: "3.1.0",
      info: { title: "Test", version: "1.0.0" },
      paths: { "/ping": { get: { responses: { 200: { description: "ok" } } } } },
    };
    const router = buildApiDocsRouter({
      env: { NODE_ENV: "development", API_DOCS_TITLE: "Test" },
      buildSpec: () => fakeSpec,
    });
    const { statusCode, body, headers } = await callRouter(router, "/api-docs/openapi.json");
    assert.equal(statusCode, 200);
    assert.match(headers["content-type"] || "", /application\/json/);
    const parsed = JSON.parse(body);
    assert.equal(parsed.openapi, "3.1.0");
    assert.equal(parsed.info.title, "Test");
    assert.ok(parsed.paths["/ping"]);
  });

  test("/api-docs/ returns 200 with the Swagger UI HTML shell", async () => {
    const router = buildApiDocsRouter({
      env: { NODE_ENV: "development" },
      buildSpec: () => ({
        openapi: "3.1.0",
        info: { title: "Test", version: "1.0.0" },
        paths: {},
      }),
    });
    const { statusCode, body, headers } = await callRouter(router, "/api-docs/");
    assert.equal(statusCode, 200);
    assert.match(headers["content-type"] || "", /text\/html/);
    // Sanity: Swagger UI page contains the SwaggerUIBundle init call.
    assert.match(body, /SwaggerUIBundle|swagger-ui/i);
  });
});
