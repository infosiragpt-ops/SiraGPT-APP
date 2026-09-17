# RLCD for documents — calibrated decisions

**RLCD** in SiraGPT means **Reinforcement Learning for Calibrated Decisions**
(Luis Carrera). It is **not** the ICLR paper “Reinforcement Learning from
Contrastive Distillation”, unless a small contrastive-pair helper clearly
helps calibration. This slice does not implement that paper.

The first production slice is **document analysis only** (`agent=document`):
uploaded-doc Q&A / docintel paths in `/agentes`. It sits on top of the
existing RLHF flywheel (`preference_events`, thumbs, steering) and the
pre-turn posture module (`confidence-calibration.js`).

It **coexists** with the #722 system-wide decision ledger
(`backend/src/services/rlcd/decision-ledger.js`, `GET /api/rlcd/stats`).
That ledger uses `SIRAGPT_RLCD_ENABLED` (default on). This document
slice uses `SIRAGPT_RLCD_DOCUMENTS` (default off). Same `rlcd/index.js`
re-exports both; `messages.metadata.rlcd` may hold ledger `decisions[]`
and document `{confidence, bin, deferred}` together.

There is **no** in-process GPU PPO. Learning is: verbalized/structured
confidence → human outcome (👍 / 👎 / regenerate) → Brier / ECE → defer
policy + optional few-shot notes.

## How it differs from plain RLHF thumbs

| | RLHF thumbs | RLCD (this slice) |
|---|---|---|
| Signal | “this answer was helpful / not” | “this **high/low-confidence claim** was correct / incorrect” |
| Storage | `preference_events.label` | same row, `judgeScore.rlcd` `{ confidence, outcome, bin }` |
| Inference | few-shot style steering | confidence metadata + **defer/abstain** when low |
| Metric | chosen/rejected counts, BT-RM | Brier + ECE buckets + defer rate |
| Default | collection on | **off** (`SIRAGPT_RLCD_DOCUMENTS`) |

Thumbs still write the flywheel. When RLCD is on **and** the turn is a
document agent, the same thumb also updates calibration stats.

## Loop

```
document turn
    │
    ├─ flag off → identical to today
    │
    └─ flag on
         ├─ prompt: compact CALIBRACION DOCUMENTAL block
         │          (hidden <!--rlcd:{"c":0-1,"r":"..."}--> trailer)
         ├─ generate (existing RAG / react-agent / fidelity paths)
         ├─ parse trailer or verbalized hedges or heuristic
         ├─ evidence blend: extract / RAG coverage, citations, empty extract
         ├─ retrieval scores + page locators from RAG / docintel hits
         ├─ claims: each sentence → supported | inferred
         ├─ if confidence < threshold (and defer-rate cap allows)
         │     defer: warm Spanish ask for section/page (candidate
         │     pages from hits when known). No scare copy.
         └─ persist message.metadata.rlcd
              { v:3, confidence, rawConfidence, bin, deferred, evidence, claims }

user 👍 / 👎 / regenerate
    └─ record outcome against the stored (or re-parsed) confidence
         ├─ regenerate of a high-confidence prior is weighted ×2
         └─ Brier + ECE on GET /api/rlhf/stats → rlcd
```

Fail-open: any RLCD exception leaves chat and document analysis unchanged.

## Flags (defaults safe for prod)

Do **not** flip these on in the Lenovo `.env` from this PR.

| Env | Default | Effect |
|-----|---------|--------|
| `SIRAGPT_RLCD_DOCUMENTS` | **off** | Document-analysis switch. `1` / `true` / `on` enables prompt, scoring, defer, and outcome learning |
| `SIRAGPT_RLCD_DEFER_THRESHOLD` | `0.45` | Defer when predicted confidence is below this (clamped 0.05–0.95) |
| `SIRAGPT_RLCD_MAX_DEFER_RATE` | `0.25` | Cap of document turns that may defer in this process (0–1) |
| `SIRAGPT_RLCD_PROMPT` | on (when documents on) | `0` / `off` skips the hidden-trailer contract |
| `SIRAGPT_RLCD_PHRASE` | on (when documents on) | `0` / `off` skips the compact “Confianza baja/media” line |
| `SIRAGPT_RLCD_AUTO_THRESHOLD` | **off** | When on **and** there are enough labeled outcomes, use the ECE-suggested defer threshold. Code default stays off. Do not flip from this PR. |
| `SIRAGPT_RLCD_AUTO_THRESHOLD_MIN_N` | `20` | Minimum labeled document outcomes before a suggested threshold is usable (8–200) |

Independent of `SIRAGPT_RLHF_*` **and** of the #722 decision ledger
(`SIRAGPT_RLCD_ENABLED`, default on — `docs/rlcd.md`). You can leave
ledger telemetry on and document RLCD off. Do **not** reuse
`SIRAGPT_RLCD_ENABLED` for this slice: that flag already shipped as
the ledger master switch.

## Metrics

Exposed on `GET /api/rlhf/stats` as `rlcd`:

- `enabled`, `threshold`, `maxDeferRate`
- `n` — labeled (confidence, outcome) pairs
- `brier` — weighted mean `(p − y)²` (`y=1` thumb-up, `y=0` thumb-down / regenerate-of-prior; regenerate of a high-confidence prior counts twice)
- `ece` — expected calibration error over 5 equal bins (same weights)
- `buckets[]` — `{ lo, hi, n, avgConfidence, avgAccuracy, gap }` (admin)
- `byBin`, `bySource` — accuracy / Brier split (admin on `/api/rlhf/stats`; always on `/api/rlcd` → `documents`)
- `overconfidenceRate` — high-bin answers that were wrong
- `claimSupportRate`, `evidenceQuality` — means over labeled turns
- `deferRate`, `documentTurns`, `deferred`, `scored`
- `recommendedThreshold`, `thresholdAdvice`, `thresholdDelta`,
  `autoThreshold`, `effectiveThreshold` — ECE/overconfidence suggestion
  (applied only when `SIRAGPT_RLCD_AUTO_THRESHOLD` is on)

`GET /api/rlhf/export?format=rlcd` emits contrastive document pairs
`{ prompt, chosen, rejected, chosen_confidence, rejected_confidence, overconfident_reject }`
(PII-scrubbed). Train-prep jobs stay `sft` / `dpo` / `rm` only.

In-process counters (same pattern as RLHF phase-2 telemetry). Durable
learning lives on `preference_events.judgeScore.rlcd` so a restart can
rehydrate later without a new table.

## Storage (no Prisma migration)

This slice does **not** add columns or tables.

- **Inference:** `Message.metadata.rlcd` = `{ v:3, confidence, rawConfidence, bin, source, deferred, reason, adjusted, evidence, claims }`
  (`evidence` may include `retrievalScore`, `pages`, `pageCited`)
- **Outcomes:** `preference_events.judgeScore.rlcd` merged with existing RLAIF
  HHH scores (`mergeJudgeScore`). GDPR scrub of preference text is unchanged.

Schema-once is **not** required to deploy this PR. A later lote may add
indexed `confidence` / `rlcd_outcome` columns if query volume justifies it.

## Integration points

- `backend/src/services/rlcd/` — flags, parse, defer, metrics, prompt
- `document-analysis-rlhf.formatDocumentRlhfBlock` — optional calibrated notes
  plus scrubbed good/bad document snippets when the flag is on
- `/api/ai/generate` — prompt block + finalize (strip trailer, evidence blend,
  claim labels, maybe defer). RAG hits from the operational runtime are passed in.
- `feedback-ledger.record` / chats thumbs — outcome + `judgeScore.rlcd`
- `ingestRegenerate` — prior rejected answer counts as incorrect (weight 2 if
  the prior confidence was high)
- Observability events (closed catalog): `rlcd.prompt_applied`,
  `rlcd.confidence_scored`, `rlcd.deferred`, `rlcd.skipped`,
  `rlcd.evidence_adjusted`

No UI-lock files. Brand: no vendor / raw `model_id` in user-visible copy.
Compact Spanish phrasing only when confidence is medium/low or the turn
defers.

## Contrastive pairs

Existing chosen/rejected pairs (same prompt hash) already feed steering.
Phase 2 also builds document-only pairs for `GET /api/rlhf/export?format=rlcd`
and injects a scrubbed “bien calibrada / sobreconfianza” snippet into the
few-shot block when `findExemplars` returns `judgeScore.rlcd`. That is a
**calibration helper**, not ICLR contrastive distillation.

## Phase 2 (after #721)

Deepens document calibration without touching the #722 ledger flag:

1. **Evidence-aware confidence** — empty extract, thin extract, citation
   marks (`[S1]`, página, “según el documento”), and token overlap with
   the extract / RAG hits adjust the trailer *before* defer.
2. **Supported vs inferred claims** — each sentence is labelled; mostly
   inferred answers lose confidence and may show a compact Spanish line.
3. **Stronger outcome loop** — regenerate of a high-confidence prior is
   weighted; contrastive document pairs are exportable.
4. **Richer stats + steering** — `overconfidenceRate`, `byBin`,
   `bySource`, `claimSupportRate` on the existing `/api/rlhf/stats` →
   `rlcd` and `/api/rlcd` → `documents` objects.

Eval fixtures: `backend/tests/fixtures/document-rlcd-eval.json`.
Runner: `rlcd.runDocumentEval()` / `rlcd/eval-harness.js` (offline, no GPU).

## Phase 3 (after #721 + #723)

Tightens calibration now that `SIRAGPT_RLCD_DOCUMENTS` may be on in prod.
Code default remains **off**. This PR does not change `.env`.

1. **Retrieval-aware evidence** — RAG / docintel hit `score` /
   `rerankScore` / `similarity` and page locators (`page`, `pageNumber`,
   `locator`, or a page mark in the snippet) blend into quality.
   An answer that cites a retrieved page gets a small lift; a weak top
   hit with low overlap pulls confidence down.
2. **Spanish defer UX** — ask for the section or page in warm copy.
   Candidate pages from hits are offered (“¿Es la página 12?”).
   Invented high-trailer answers are replaced, not shown next to a
   warning. No “afirmar con seguridad” / “inventar”.
3. **Eval harness** — expanded fixtures (empty extract, grounded,
   inferred, weak RAG, page cite, page-hint defer, coding-turn gate,
   already-honest). `runDocumentEval` reports per-case pass/fail.
4. **Suggested threshold** — `GET /api/rlcd/stats` → `documents` exposes
   `recommendedThreshold` from ECE / overconfidence. Applied only if
   `SIRAGPT_RLCD_AUTO_THRESHOLD` is on and `n ≥` min samples.

Coding / local-preview turns stay untouched: `finalizeAnswer` no-ops
when `agent` is present and not `document`.

## Rollout

1. Land with the flag **off**. Behavior unchanged.
2. Enable on a staging box: `SIRAGPT_RLCD_DOCUMENTS=1`.
3. Watch `/api/rlhf/stats` → `rlcd` (Brier/ECE/deferRate) and generate
   events `rlcd.*`.
4. Tune `SIRAGPT_RLCD_DEFER_THRESHOLD` / `SIRAGPT_RLCD_MAX_DEFER_RATE`.
5. Only then consider production. Do not publish this PR as a flag-on
   Lenovo change.
