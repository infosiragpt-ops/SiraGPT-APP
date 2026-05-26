const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("nodemon ignores generated runtime directories", () => {
  const configPath = path.join(__dirname, "..", "nodemon.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const ignored = new Set(config.ignore || []);

  assert.ok(ignored.has("uploads/**"), "uploads must not trigger backend restarts");
  assert.ok(ignored.has("uploads/agent-tasks/**"), "agent task snapshots must not trigger restarts");
  assert.ok(ignored.has("uploads/document-pipeline/**"), "generated document artifacts must not trigger restarts");
  assert.ok(ignored.has("tmp/**"), "temporary logs must not trigger restarts");
});
