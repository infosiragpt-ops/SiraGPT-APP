import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildWriteMetrics } from "../lib/code-chat-metrics"

// The Worked Summary (actions + metrics) of a coding turn comes from
// buildWriteMetrics, shared by the live chat session store.

describe("code-agent progress rail — Worked Summary data (behavioral)", () => {
  it("a completed file-writing turn produces a non-empty Worked Summary (actions + metrics)", () => {
    const startedAt = 1_000
    const { actions, metrics } = buildWriteMetrics(
      [
        { path: "app/page.tsx", content: "line1\nline2\nline3\n" },
        { path: "lib/db.ts", content: "export const db = 1\n" },
      ],
      {
        startedAt,
        now: startedAt + 4_200,
        getPrevContent: () => "",
      },
    )

    assert.ok(actions.length > 0, "a turn that wrote files must yield a non-empty action log")
    assert.equal(metrics.filesChanged, 2, "metrics must count the real files written")
    assert.ok(metrics.linesAdded > 0, "new files must report added lines in the Worked Summary")
    assert.ok(metrics.timeWorkedMs > 0, "the Worked Summary must report measured wall-clock time")
    assert.ok(metrics.actionsCount > 0, "actionsCount must be non-zero for a turn that did work")
  })
})
