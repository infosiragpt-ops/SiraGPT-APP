import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { describe, it } from "node:test"

const cjsRequire = createRequire(__filename)

type ProjectContext = {
  buildProjectContextManifest: (project: any) => any
  buildProjectPromptHeader: (project: any) => string
}

type ChatScope = {
  buildChatListWhere: (opts: { userId: string; projectId?: string | null; includeProjects?: boolean; search?: string }) => any
}

const projectContext = cjsRequire("../../backend/src/services/project-context") as ProjectContext
const chatScope = cjsRequire("../../backend/src/services/chat-scope") as ChatScope

describe("project context manifest", () => {
  it("summarizes files, chats, documents, memory and extraction coverage", () => {
    const manifest = projectContext.buildProjectContextManifest({
      id: "project_1",
      name: "Tesis Asesoría",
      instructions: "Usa APA 7.",
      files: [
        { mimeType: "application/pdf", extractedText: "contenido" },
        { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extractedText: "" },
      ],
      chats: [{ id: "chat_1" }],
      memories: [{ fact: "tono formal" }],
      documents: [{ id: "doc_1" }, { id: "doc_2" }],
    })

    assert.equal(manifest.isolation, "project_scoped")
    assert.equal(manifest.hasInstructions, true)
    assert.deepEqual(manifest.counts, { files: 2, chats: 1, memories: 1, documents: 2 })
    assert.equal(manifest.fileTypes.application, 2)
    assert.deepEqual(manifest.textCoverage, { extracted: 1, total: 2, percent: 50 })
  })

  it("renders a prompt header that enforces project isolation", () => {
    const header = projectContext.buildProjectPromptHeader({
      name: "IliaGPT.io",
      files: [],
      chats: [],
      memories: [],
      documents: [],
    })

    assert.match(header, /PROJECT WORKSPACE MANIFEST/)
    assert.match(header, /project_scoped/)
    assert.match(header, /Do not import facts from other projects/)
  })
})

describe("chat scope rules", () => {
  it("excludes project chats from the global chat list by default", () => {
    assert.deepEqual(
      chatScope.buildChatListWhere({ userId: "user_1" }),
      { userId: "user_1", deletedAt: null, isArchived: false, projectId: null }
    )
  })

  it("scopes search to a single project when projectId is present", () => {
    const where = chatScope.buildChatListWhere({
      userId: "user_1",
      projectId: "project_1",
      search: "APA 7",
    })

    assert.equal(where.userId, "user_1")
    assert.equal(where.deletedAt, null)
    assert.equal(where.projectId, "project_1")
    assert.equal(where.isArchived, false)
    assert.equal(where.OR.length, 2)
    assert.equal(where.OR[0].title.contains, "APA 7")
  })
})
