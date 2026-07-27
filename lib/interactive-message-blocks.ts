const INTERACTIVE_FENCE_LANGUAGES = new Set([
  "agent-task-state",
  "scientific-papers",
])

export function shouldUnwrapInteractiveFence(className: unknown) {
  if (typeof className !== "string") return false
  const language = /(?:^|\s)language-([\w-]+)/.exec(className)?.[1]?.toLowerCase()
  return Boolean(language && INTERACTIVE_FENCE_LANGUAGES.has(language))
}
