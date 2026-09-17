/** Progress bubble for the /agentes document editor (agent-task-state fence). */
export interface DocumentEditStep {
  id: string
  label: string
  icon: "thought"
  status: "running" | "done" | "error"
  reasoning?: string
  toolCalls: []
}

export const DOCUMENT_EDIT_STOPPED = "Edición detenida. El documento original no se modificó."

export function documentEditTaskState(steps: DocumentEditStep[], done: boolean, error?: string): string {
  return "```agent-task-state\n" + JSON.stringify({
    steps, artifacts: [], approvals: [], checkpoints: [], qualityGates: [], repairs: [],
    finalText: "", done, ...(error ? { error } : {}),
  }) + "\n```"
}

/** Next progress list: the previous step completes, the new label runs (repeats only refresh the detail). */
export function advanceDocumentEditSteps(steps: DocumentEditStep[], label: string, detail?: string): DocumentEditStep[] {
  const last = steps[steps.length - 1]
  if (last && last.label === label) {
    return [...steps.slice(0, -1), { ...last, ...(detail ? { reasoning: detail } : {}) }]
  }
  const settled = steps.map((step) => (step.status === "running" ? { ...step, status: "done" as const } : step))
  return [...settled, { id: `document-edit-${steps.length + 1}`, label, icon: "thought", status: "running", toolCalls: [], ...(detail ? { reasoning: detail } : {}) }]
}

export function failDocumentEditSteps(steps: DocumentEditStep[]): DocumentEditStep[] {
  return steps.map((step) => (step.status === "running" ? { ...step, status: "error" as const } : step))
}
