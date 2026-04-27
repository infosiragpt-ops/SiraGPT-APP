const express = require("express");
const crypto = require("crypto");
const { body, validationResult } = require("express-validator");
const prisma = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

router.use(authenticateToken);

function validationFail(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function normalizePlatforms(raw) {
  const platforms = Array.isArray(raw) && raw.length
    ? raw
      .filter((p) => typeof p === "string")
      .map((p) => p.toLowerCase())
      .filter((p) => /^(facebook|instagram|youtube|tiktok|linkedin)$/.test(p))
      .slice(0, 8)
    : ["instagram"];
  return [...new Set(platforms)];
}

function buildSeriesPostData({ userId, prompt, paletteName, days, platforms, start, batchId, referenceImages }) {
  const rows = [];
  for (let i = 0; i < days; i += 1) {
    rows.push({
      userId,
      prompt: `${prompt.trim()}\n\nDía ${i + 1} de ${days}: genera una variación profesional coherente con la serie.`,
      caption: null,
      platforms,
      scheduledAt: addDays(start, i),
      status: "scheduled",
      batchId,
      referenceImages,
      config: {
        paletteName: paletteName || "Profesional",
        generationMode: "automatic_series",
        dayIndex: i + 1,
        totalDays: days,
      },
    });
  }
  return rows;
}

router.get("/", async (req, res) => {
  try {
    const batchId = typeof req.query.batchId === "string" && req.query.batchId.trim()
      ? req.query.batchId.trim()
      : undefined;
    const posts = await prisma.scheduledPost.findMany({
      where: { userId: req.user.id, ...(batchId ? { batchId } : {}) },
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
      take: 100,
    });
    res.json({ posts });
  } catch (err) {
    console.error("[social-posts] list error:", err);
    res.status(500).json({ error: "Failed to list scheduled posts" });
  }
});

router.get("/connections", async (req, res) => {
  try {
    const connections = await prisma.socialConnection.findMany({
      where: { userId: req.user.id },
      select: {
        id: true,
        platform: true,
        accountId: true,
        accountName: true,
        profile: true,
        scopes: true,
        expiresAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ connections });
  } catch (err) {
    console.error("[social-posts] connections error:", err);
    res.status(500).json({ error: "Failed to list social connections" });
  }
});

router.post(
  "/series",
  [
    body("prompt").trim().isLength({ min: 2, max: 12000 }),
    body("paletteName").optional().isString().isLength({ max: 120 }),
    body("days").optional().isInt({ min: 1, max: 60 }),
    body("platforms").optional().isArray({ min: 1, max: 8 }),
    body("referenceImages").optional().isArray({ max: 8 }),
  ],
  async (req, res) => {
    try {
      if (validationFail(req, res)) return;
      const days = Math.min(Math.max(Number(req.body.days || 1), 1), 60);
      const platforms = normalizePlatforms(req.body.platforms);
      if (platforms.length === 0) return res.status(400).json({ error: "At least one supported platform is required" });
      const start = req.body.startDate ? new Date(`${req.body.startDate}T14:00:00.000Z`) : new Date(Date.now() + 24 * 60 * 60 * 1000);
      const batchId = crypto.randomUUID();
      const referenceImages = Array.isArray(req.body.referenceImages) ? req.body.referenceImages.slice(0, 8) : [];

      const posts = [];
      const rows = buildSeriesPostData({
        userId: req.user.id,
        prompt: req.body.prompt,
        paletteName: req.body.paletteName,
        days,
        platforms,
        start,
        batchId,
        referenceImages,
      });
      for (const data of rows) {
        const post = await prisma.scheduledPost.create({
          data,
        });
        posts.push(post);
      }

      res.status(201).json({ batchId, posts });
    } catch (err) {
      console.error("[social-posts] create series error:", err);
      res.status(500).json({ error: "Failed to create scheduled series" });
    }
  },
);

router.get("/connect/:platform", async (req, res) => {
  const platform = String(req.params.platform || "").toLowerCase();
  if (!/^(facebook|instagram|youtube|tiktok|linkedin)$/.test(platform)) {
    return res.status(400).json({ error: "Unsupported platform" });
  }
  await prisma.socialConnection.upsert({
    where: { userId_platform: { userId: req.user.id, platform } },
    create: {
      userId: req.user.id,
      platform,
      accountName: `${platform} pendiente`,
      profile: { status: "oauth_stub", note: "Configure real OAuth credentials for this platform." },
      scopes: [],
    },
    update: {
      accountName: `${platform} pendiente`,
      profile: { status: "oauth_stub", note: "Configure real OAuth credentials for this platform." },
    },
  });
  res.redirect(`${process.env.FRONTEND_URL || "http://localhost:3000"}/post?connected=${encodeURIComponent(platform)}`);
});

module.exports = router;
module.exports.INTERNAL = { addDays, buildSeriesPostData, normalizePlatforms };
