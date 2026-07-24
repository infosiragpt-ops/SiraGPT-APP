const { test } = require("node:test");
const assert = require("node:assert/strict");

const { INTERNAL } = require("../src/routes/social-posts");

test("social-posts: normalizePlatforms filters unsupported networks and dedupes", () => {
  assert.deepEqual(
    INTERNAL.normalizePlatforms(["Instagram", "x", "linkedin", "instagram", "youtube"]),
    ["instagram", "x", "linkedin", "youtube"],
  );
  assert.deepEqual(INTERNAL.normalizePlatforms(undefined), ["facebook"]);
});

test("social-posts: buildSeriesPostData creates dated batch rows with references", () => {
  const start = new Date("2026-04-27T14:00:00.000Z");
  const rows = INTERNAL.buildSeriesPostData({
    userId: "u1",
    prompt: "Lanzamiento de producto",
    paletteName: "Vidrio liquido",
    days: 3,
    platforms: ["instagram", "linkedin"],
    start,
    batchId: "batch-1",
    referenceImages: [{ name: "ref.png" }],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].batchId, "batch-1");
  assert.deepEqual(rows[0].platforms, ["instagram", "linkedin"]);
  assert.equal(rows[0].config.paletteName, "Vidrio liquido");
  assert.equal(rows[0].config.dayIndex, 1);
  assert.equal(rows[2].scheduledAt.toISOString(), "2026-04-29T14:00:00.000Z");
  assert.deepEqual(rows[0].referenceImages, [{ name: "ref.png" }]);
  assert.equal(rows[0].config.approved, false);
});
