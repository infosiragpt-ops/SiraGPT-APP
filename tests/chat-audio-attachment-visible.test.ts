import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import {
  isAudioComposerFile,
  mergeMessageFileLists,
  snapshotComposerFilesForMessage,
} from "../lib/chat/composer-files"
import { parseMessageFilesForRender } from "../lib/chat/message-rendering"
import {
  dedupeMessages,
  mergeMessagesPreservingUserContent,
} from "../lib/message-preservation"

const audioFile = {
  id: "file-audio-1",
  tempId: "temp-audio-1",
  name: "nota.m4a",
  originalName: "nota.m4a",
  type: "audio/mp4",
  mimeType: "audio/mp4",
  size: 248_320,
  url: "/uploads/user/nota.m4a",
  mediaMeta: { durationSeconds: 12.4, peaks: [0.2, 0.8, 0.4, 0.9] },
  file: { name: "nota.m4a", type: "audio/mp4", size: 248_320 },
}

describe("optimistic audio attachments stay visible", () => {
  it("parseMessageFilesForRender keeps audio objects from arrays and JSON", () => {
    assert.equal(parseMessageFilesForRender([audioFile])[0], audioFile)
    const parsed = parseMessageFilesForRender(JSON.stringify([{
      id: "file-audio-1",
      name: "entrevista.mp3",
      mimeType: "audio/mpeg",
    }]))
    assert.equal(parsed.length, 1)
    assert.equal((parsed[0] as { name: string }).name, "entrevista.mp3")
    assert.equal((parsed[0] as { mimeType: string }).mimeType, "audio/mpeg")
  })

  it("snapshotComposerFilesForMessage keeps name, mime, url and waveform without the native File", () => {
    const [snapshot] = snapshotComposerFilesForMessage([audioFile])
    assert.equal(snapshot.name, "nota.m4a")
    assert.equal(snapshot.mimeType, "audio/mp4")
    assert.equal(snapshot.url, "/uploads/user/nota.m4a")
    assert.equal(snapshot.mediaMeta?.durationSeconds, 12.4)
    assert.deepEqual(snapshot.mediaMeta?.peaks, [0.2, 0.8, 0.4, 0.9])
    assert.equal("file" in snapshot, false)
    assert.equal(isAudioComposerFile(snapshot), true)
    JSON.stringify(snapshot)
  })

  it("mergeMessageFileLists keeps local waveform when the server returns a canonical URL", () => {
    const local = snapshotComposerFilesForMessage([{
      ...audioFile,
      url: "blob:https://siragpt.com/optimistic",
    }])
    const incoming = [{
      id: "file-audio-1",
      name: "nota.m4a",
      mimeType: "audio/mp4",
      url: "/uploads/user/nota.m4a",
    }]
    const merged = mergeMessageFileLists(incoming, local)
    assert.equal(merged.length, 1)
    const file = merged[0] as {
      url?: string
      mediaMeta?: { durationSeconds?: number; peaks?: number[] }
      name?: string
    }
    assert.equal(file.url, "/uploads/user/nota.m4a")
    assert.equal(file.name, "nota.m4a")
    assert.equal(file.mediaMeta?.durationSeconds, 12.4)
    assert.deepEqual(file.mediaMeta?.peaks, [0.2, 0.8, 0.4, 0.9])
  })

  it("preservation does not drop optimistic audio files for an empty server payload", () => {
    const local = [
      {
        id: "msg-user-1",
        role: "USER",
        content: "transcribir este audio",
        files: snapshotComposerFilesForMessage([audioFile]),
      },
      { id: "msg-ai-1", role: "ASSISTANT", content: "" },
    ]
    const incoming = [
      { id: "msg-user-1", role: "USER", content: "transcribir este audio", files: [] },
      { id: "srv-ai-1", role: "ASSISTANT", content: "" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const files = (merged[0] as { files?: unknown[] }).files || []
    assert.equal(files.length, 1)
    assert.equal((files[0] as { name?: string }).name, "nota.m4a")
    assert.equal(isAudioComposerFile(files[0]), true)
  })

  it("dedupeMessages grafts audio files from the optimistic twin onto the server copy", () => {
    const msgs = [
      {
        id: "msg-user-1700000000000",
        role: "USER",
        content: "transcribir",
        files: snapshotComposerFilesForMessage([audioFile]),
      },
      {
        id: "clx_server_user",
        role: "USER",
        content: "transcribir",
        files: [{ id: "file-audio-1" }],
      },
      { id: "msg-assistant-processing-1", role: "ASSISTANT", content: "" },
    ]
    const out = dedupeMessages(msgs)
    const user = out.filter((message) => String(message.role).toUpperCase() === "USER")
    assert.equal(user.length, 1)
    assert.equal(user[0].id, "clx_server_user")
    const files = (user[0] as { files?: unknown[] }).files || []
    assert.equal(files.length, 1)
    assert.equal((files[0] as { name?: string }).name, "nota.m4a")
    assert.equal(((files[0] as { mediaMeta?: { durationSeconds?: number } }).mediaMeta)?.durationSeconds, 12.4)
  })
})

describe("chat audio attachment source contract", () => {
  it("optimistic send snapshots composer files instead of raw File handles", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
      "utf8",
    )
    assert.match(source, /snapshotComposerFilesForMessage\(filesToSend\)/)
    assert.match(
      source,
      /files: snapshotComposerFilesForMessage\(filesToSend\),\s*\n\s*metadata: JSON\.stringify\(\{ idempotencyKey \}\)/,
    )
  })

  it("user bubbles classify and render audio attachments separately from documents", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components", "message-component.tsx"),
      "utf8",
    )
    assert.match(source, /isAudioComposerFile/)
    assert.match(source, /getAudioMediaMeta/)
    assert.match(source, /parseMessageFilesForRender\(message\.files\)/)
  })
})
