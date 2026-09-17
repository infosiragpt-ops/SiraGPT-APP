import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DOCUMENT_EDIT_STOPPED,
  advanceDocumentEditSteps,
  documentEditTaskState,
  failDocumentEditSteps,
} from "../lib/document-editor-progress"

test("each new stage completes the previous one; repeated stages only refresh the detail", () => {
  let steps = advanceDocumentEditSteps([], "Preparando la edición")
  steps = advanceDocumentEditSteps(steps, "Editando el documento", "unzip informe.docx")
  steps = advanceDocumentEditSteps(steps, "Editando el documento", "python3 edit.py")
  assert.deepEqual(steps.map((step) => [step.label, step.status, step.reasoning]), [
    ["Preparando la edición", "done", undefined],
    ["Editando el documento", "running", "python3 edit.py"],
  ])
  assert.deepEqual(failDocumentEditSteps(steps).map((step) => step.status), ["done", "error"])
})

test("the bubble is an agent-task-state fence without model or provider identity", () => {
  const content = documentEditTaskState(advanceDocumentEditSteps([], "Leyendo el documento"), false)
  const match = /^```agent-task-state\n([\s\S]*)\n```$/.exec(content)
  assert.ok(match)
  const state = JSON.parse(match![1])
  assert.equal(state.done, false)
  assert.equal("meta" in state, false)
  assert.deepEqual(JSON.parse(/```agent-task-state\n([\s\S]*)\n```/.exec(documentEditTaskState([], true, "falló"))![1]).error, "falló")
  assert.match(DOCUMENT_EDIT_STOPPED, /original no se modificó/)
})
