/**
 * search-agentic — SSE endpoint that streams the agentic batched
 * academic search.
 *
 *   POST /api/search/agentic
 *     body: {
 *       query:     string,                    // required, ≥ 2 chars
 *       chatId?:   string,                    // optional, will persist final markdown
 *       target?:   number,                    // total sources to collect, [10..1000], default 500
 *       batchSize?: number,                   // sources per batch, [5..50], default 10
 *       topK?:     number,                    // best-of selection size, [5..100], default 25
 *       providers?: string[],                 // subset of [openalex, scielo, semantic, crossref, pubmed, doaj]
 *       language?: string                     // ISO 639-1 (filters Crossref/SciELO)
 *     }
 *
 * Wire format: SSE frames `data: <json>\n\n` of the events emitted
 * by services/searchBrain/agenticBatch.js. The frontend renders a
 * progress UI from `batch` events and prints `summary` markdown when
 * the run finishes.
 *
 * Auth: same JWT middleware the rest of the chat surface uses
 * (authenticateToken). chatId is verified-owned before persistence.
 */

const express = require("express");
const { body, validationResult } = require("express-validator");
const { authenticateToken } = require("../middleware/auth");
const { runAgenticBatch, DEFAULT_PROVIDERS } = require("../services/searchBrain/agenticBatch");

const prisma = (() => {
  try { return require("../config/database"); } catch { return null; }
})();
const serializer = (() => {
  try { return require("../utils/bigint-serializer"); } catch { return null; }
})();

const router = express.Router();

const VALID_PROVIDERS = new Set(["openalex", "scielo", "semantic", "crossref", "pubmed", "doaj"]);

function pickProviders(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((p) => typeof p === "string" && VALID_PROVIDERS.has(p));
  return out.length > 0 ? out : undefined;
}

function pickMailto(req) {
  if (typeof req.body?.mailto === "string" && /@/.test(req.body.mailto)) return req.body.mailto.slice(0, 120);
  if (req.user?.email) return req.user.email;
  return process.env.SEARCH_BRAIN_MAILTO || process.env.OPENALEX_MAILTO || undefined;
}

router.post(
  "/agentic",
  [
    body("query").isString().trim().isLength({ min: 2, max: 500 }).withMessage("query must be 2-500 chars"),
    body("chatId").optional().isString(),
    body("target").optional().isInt({ min: 10, max: 1000 }),
    body("batchSize").optional().isInt({ min: 5, max: 50 }),
    body("topK").optional().isInt({ min: 5, max: 100 }),
    body("providers").optional().isArray(),
    body("language").optional().isString().isLength({ min: 2, max: 8 }),
    body("mailto").optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        // Client likely disconnected mid-write — the close handler
        // will tear down the run on the next iteration.
      }
    };

    // Propagate client disconnect to the orchestrator. The agentic
    // loop checks `signal?.aborted` between provider calls, so a
    // closed tab stops burning Crossref / OpenAlex quota immediately.
    const controller = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let finalMarkdown = "";
    let selectedSources = [];
    let stats = null;

    try {
      for await (const evt of runAgenticBatch({
        query: req.body.query,
        target: req.body.target,
        batchSize: req.body.batchSize,
        topK: req.body.topK,
        providers: pickProviders(req.body.providers),
        language: typeof req.body.language === "string" ? req.body.language : undefined,
        mailto: pickMailto(req),
        signal: controller.signal,
      })) {
        send(evt);
        if (evt.type === "summary" && typeof evt.markdown === "string") {
          finalMarkdown = evt.markdown;
        } else if (evt.type === "selected" && Array.isArray(evt.sources)) {
          selectedSources = evt.sources;
        } else if (evt.type === "done") {
          stats = evt.stats;
        }
      }

      // Persist as a chat message when the caller bound this run to
      // an owned chat — mirrors what /research/investigate does so
      // the user can scroll back and find the report.
      let dbMessage = null;
      const chatId = typeof req.body.chatId === "string" ? req.body.chatId : null;
      if (chatId && finalMarkdown && prisma) {
        try {
          const chat = await prisma.chat.findFirst({ where: { id: chatId, userId: req.user.id } });
          if (chat) {
            await prisma.message.create({
              data: {
                chatId,
                role: "USER",
                content: `🤖 Búsqueda agéntica: ${req.body.query}`,
                timestamp: new Date(),
              },
            });
            dbMessage = await prisma.message.create({
              data: {
                chatId,
                role: "ASSISTANT",
                content: finalMarkdown,
                tokens: Math.ceil(finalMarkdown.length / 4),
                timestamp: new Date(),
                metadata: {
                  source: "agentic-search",
                  selectedSources,
                  stats,
                },
              },
            });
          }
        } catch (persistErr) {
          send({ type: "persist_error", error: persistErr.message || "failed to save message" });
        }
      }

      send({
        type: "saved",
        dbMessage: dbMessage && serializer ? serializer.serializeBigIntFields(dbMessage) : dbMessage,
      });
      try { res.end(); } catch { /* already closed */ }
    } catch (err) {
      console.error("[search-agentic] fatal:", err);
      send({ type: "error", message: err && err.message ? err.message : "agentic search failed" });
      try { res.end(); } catch { /* already closed */ }
    }
  }
);

router.get("/agentic/providers", (_req, res) => {
  res.json({
    providers: DEFAULT_PROVIDERS,
    descriptions: {
      openalex:  "OpenAlex (240 M obras académicas, CC0)",
      scielo:    "SciELO (red Open Access de Latinoamérica/España/Portugal vía Crossref miembro 530)",
      semantic:  "Semantic Scholar (alta cobertura en STEM)",
      crossref:  "Crossref (registro autoritativo de DOIs)",
      pubmed:    "PubMed (biomédico, NCBI E-utilities)",
      doaj:      "DOAJ (Directory of Open Access Journals)",
    },
  });
});

module.exports = router;
