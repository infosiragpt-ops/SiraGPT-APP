import { describe, expect, it } from "vitest"

import { hasUserTurnForGoal, isUserTurn } from "@/lib/chat/agent-task-turn"

const user = (content: string) => ({ role: "USER", content })
const assistant = (content: string) => ({ role: "ASSISTANT", content })

describe("hasUserTurnForGoal (agent-task user bubble)", () => {
  it("an older user turn never counts as «already added» for a new request", () => {
    const history = [user("hazme una gráfica de la proyección"), assistant("**Proyección** …")]
    expect(hasUserTurnForGoal(history, "crea un word con esta información e incorpora esta gráfica")).toBe(false)
  })

  it("finds the goal when it is the latest user turn, ignoring whitespace and a trailing placeholder", () => {
    const goal = "crea un word con esta información"
    expect(hasUserTurnForGoal([assistant("…"), user("crea  un word con\nesta información")], goal)).toBe(true)
    expect(hasUserTurnForGoal([user(goal), assistant("```agent-task-state\n{}\n```")], goal)).toBe(true)
  })

  it("re-sending an old prompt still gets a new bubble (lookback window)", () => {
    const goal = "resume esto"
    const history = [user(goal), assistant("a"), user("otra cosa"), assistant("b"), user("y más"), assistant("c")]
    expect(hasUserTurnForGoal(history, goal)).toBe(false)
    expect(hasUserTurnForGoal(history, goal, 10)).toBe(true)
  })

  it("is false for empty goals, empty lists and non-user roles", () => {
    expect(hasUserTurnForGoal([], "x")).toBe(false)
    expect(hasUserTurnForGoal(null, "x")).toBe(false)
    expect(hasUserTurnForGoal([user("x")], "")).toBe(false)
    expect(hasUserTurnForGoal([assistant("x")], "x")).toBe(false)
    expect(isUserTurn({ role: "user" })).toBe(true)
    expect(isUserTurn(null)).toBe(false)
  })
})
