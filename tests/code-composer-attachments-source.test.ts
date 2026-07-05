import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

function sectionBetween(start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.notEqual(from, -1, `missing start marker: ${start}`)
  assert.notEqual(to, -1, `missing end marker: ${end}`)
  return source.slice(from, to)
}

describe("code composer attachments", () => {
  it("reuses the chat attachment ingest pipeline before uploading files", () => {
    assert.match(source, /extractFilesFromDataTransfer/)
    assert.match(source, /extractFromClipboardEvent/)
    assert.match(source, /filesToFileList/)
    assert.match(source, /validateBatch/)
    assert.match(source, /logIngest/)

    const uploadCodeFiles = sectionBetween("const uploadCodeFiles = React.useCallback", "const removeCodeAttachment")
    const validateIndex = uploadCodeFiles.indexOf("validateBatch(")
    const uploadIndex = uploadCodeFiles.indexOf("apiClient.uploadFiles(")

    assert.ok(validateIndex >= 0, "uploadCodeFiles must validate the incoming batch")
    assert.ok(uploadIndex >= 0, "uploadCodeFiles must call the shared upload endpoint")
    assert.ok(validateIndex < uploadIndex, "validation must happen before the network upload")
    assert.match(uploadCodeFiles, /asyncProcessing:\s*true/)
    assert.match(uploadCodeFiles, /idempotencyKey:/)
  })

  it("supports picker, paste, and drag/drop on the /code composer", () => {
    assert.match(source, /ref=\{codeFileInputRef\}/)
    assert.match(source, /type="file"[\s\S]*multiple/)
    assert.match(source, /onPaste=\{handleCodeTextareaPaste\}/)
    assert.match(source, /onDrop=\{handleComposerDrop\}/)
    assert.match(source, /window\.addEventListener\("drop", onDrop\)/)
    assert.match(source, /document\.addEventListener\("paste", onPaste\)/)
    assert.match(source, /Suelta archivos para adjuntarlos al agente de APPS/)
  })

  it("sends ready attachments as agent context and blocks while uploads are active", () => {
    assert.match(source, /const readyCodeAttachments = React\.useMemo/)
    assert.match(source, /const hasUploadingCodeAttachments =/)
    assert.match(source, /const canSubmitCodePrompt =/)
    assert.match(source, /function codeAttachmentFileId/)
    assert.match(source, /const fileIds = readyCodeAttachments\.map\(codeAttachmentFileId\)/)
    assert.match(source, /void dispatch\(payload, \{ files: fileIds \}\)/)
    assert.match(source, /files: override\?\.files && override\.files\.length > 0 \? override\.files : undefined/)
    assert.match(source, /const attachedFileIds = Array\.from\(new Set\(\(opts\?\.files \|\| \[\]\)\.filter\(Boolean\)\)\)/)
    assert.match(source, /await sendPrompt\(action\.instruction, \{ autoApply: true, files: attachedFileIds \}\)/)
    assert.match(source, /pendingInputRef\.current\.push\(\{ text: rawInput, files: attachedFileIds \}\)/)
    assert.match(source, /composeCodePromptWithAttachments\(input, readyCodeAttachments\)/)
    assert.match(source, /clearSentCodeAttachments\(readyCodeAttachments\)/)
    assert.match(source, /disabled=\{!canSubmitCodePrompt\}/)
  })
})
