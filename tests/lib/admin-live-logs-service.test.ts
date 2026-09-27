import { describe, expect, it } from "vitest"
import {
  buildLogsQuery,
  createLogStreamParser,
  formatLinesAsText,
  type LiveLogLine,
} from "@/lib/admin/live-logs-service"
import { appendLines, applyRepeats } from "@/components/admin/live-logs/live-logs-buffer"

const line = (id: string, over: Partial<LiveLogLine> = {}): LiveLogLine => ({
  id, ts: Number(id.split("-")[0]), level: "info", source: "backend", msg: `m${id}`, ...over,
})

describe("live logs SSE parser", () => {
  it("parses events split across chunks and CRLF", () => {
    const p = createLogStreamParser()
    expect(p.push('event: hello\r\ndata: {"now":1}\r\n\r\nevent: lin')).toEqual([{ event: "hello", data: { now: 1 } }])
    expect(p.push('es\ndata: [{"id":"1-0"}]\n\n')).toEqual([{ event: "lines", data: [{ id: "1-0" }] }])
  })
  it("skips malformed frames", () => {
    const p = createLogStreamParser()
    expect(p.push("event: lines\ndata: {nope\n\nevent: ping\ndata: {\"now\":2}\n\n")).toEqual([{ event: "ping", data: { now: 2 } }])
  })
})

describe("query + buffer helpers", () => {
  it("builds a query with only meaningful filters", () => {
    expect(buildLogsQuery({ level: "all", q: "  ", user: "luis" }, { backfill: 300, after: null })).toBe("?user=luis&backfill=300")
    expect(buildLogsQuery({ level: "error", reqId: "abc" })).toBe("?level=error&reqId=abc")
  })
  it("appends in id order, dedupes and bounds", () => {
    let lines = appendLines([], [line("10-0"), line("11-0")])
    lines = appendLines(lines, [line("11-0"), line("12-0")])
    expect(lines.map((l) => l.id)).toEqual(["10-0", "11-0", "12-0"])
    lines = appendLines(lines, [line("10-5")])
    expect(lines.map((l) => l.id)).toEqual(["10-0", "10-5", "11-0", "12-0"])
    expect(appendLines(lines, [line("13-0")], 3).map((l) => l.id)).toEqual(["11-0", "12-0", "13-0"])
  })
  it("applies repeat counters", () => {
    const lines = applyRepeats([line("1-0"), line("2-0")], [{ id: "2-0", repeat: 4, lastTs: 9 }])
    expect(lines[1].repeat).toBe(4)
  })
  it("formats lines as text with indented bodies", () => {
    const text = formatLinesAsText([line("1700000000000-0", { level: "error", email: "a@b.co", reqId: "r1", body: "stack\n  at x" })])
    expect(text).toContain("ERROR [backend] a@b.co req=r1 m1700000000000-0")
    expect(text).toContain("    stack")
  })
})
