/**
 * Agent-task turns («crea un word con esta información…») insert their own
 * USER bubble before the step cards. The check used to be «does the chat
 * already have ANY user message?», which is true for every chat with
 * history: the new request never appeared until the server persisted it
 * and the next refresh brought it back («se auto eliminó de la interfaz»).
 *
 * The right question is whether THIS goal is already the latest user turn.
 */
type TurnMessageLike = {
  role?: unknown
  content?: unknown
}

const LOOKBACK = 4

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

export function isUserTurn(message: TurnMessageLike | null | undefined): boolean {
  return String(message?.role || "").toUpperCase() === "USER"
}

/**
 * True when one of the last few messages is a USER turn with this exact
 * goal text (whitespace-insensitive). Older identical prompts do not count:
 * re-sending the same request must still show a new bubble.
 */
export function hasUserTurnForGoal(
  messages: ReadonlyArray<TurnMessageLike | null | undefined> | null | undefined,
  goal: unknown,
  lookback: number = LOOKBACK,
): boolean {
  const wanted = normalizeText(goal)
  if (!wanted || !Array.isArray(messages) || messages.length === 0) return false
  const start = Math.max(0, messages.length - Math.max(1, lookback))
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]
    if (!isUserTurn(message)) continue
    if (normalizeText(message?.content) === wanted) return true
  }
  return false
}
