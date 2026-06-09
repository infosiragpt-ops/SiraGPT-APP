/**
 * Fetches a context-aware intake question for the /code agent. The backend
 * phrases it with the LLM based on the conversation so far; on any failure this
 * resolves to the provided static fallback, so the intake never blocks.
 */

interface MiniTurn {
  role: string
  content: string
}

export async function fetchCodeIntakeQuestion(
  slot: string,
  history: MiniTurn[],
  fallback: string,
): Promise<string> {
  try {
    const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
    const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
    const res = await fetch(`${base}/builder/code-question`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        slot,
        history: history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
        fallback,
      }),
    })
    if (!res.ok) return fallback
    const json = (await res.json().catch(() => ({}))) as { question?: string }
    return typeof json.question === "string" && json.question.trim() ? json.question.trim() : fallback
  } catch {
    return fallback
  }
}
