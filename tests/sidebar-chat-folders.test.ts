import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  deleteChatFolder,
  listChatFolderNames,
  normalizeChatFolderName,
  parseChatFolderAssignments,
  parseChatFolderNameList,
  renameChatFolder,
  SUGGESTED_CHAT_FOLDERS,
} from "../lib/sidebar-chat-folders"

describe("sidebar chat folders", () => {
  it("normalizes folder names and drops blanks", () => {
    assert.equal(normalizeChatFolderName("  Trabajo  "), "Trabajo")
    assert.equal(normalizeChatFolderName("  "), "")
    assert.deepEqual(parseChatFolderNameList([" Trabajo ", "", "Empresa", "trabajo"]), ["Trabajo", "Empresa"])
    assert.deepEqual(parseChatFolderAssignments({ a: " Personal ", b: "  ", c: 1 }), { a: "Personal" })
  })

  it("lists named folders before assignment-only folders without duplicates", () => {
    assert.deepEqual(
      listChatFolderNames({ c1: "Personal", c2: "trabajo" }, ["Trabajo", "Empresa"]),
      ["Trabajo", "Empresa", "Personal"],
    )
    assert.deepEqual(SUGGESTED_CHAT_FOLDERS, ["Trabajo", "Empresa", "Personal"])
  })

  it("renames a folder across the named list and chat assignments", () => {
    const next = renameChatFolder(
      { a: "Trabajo", b: "Personal" },
      ["Trabajo", "Empresa"],
      "trabajo",
      " Clientes ",
    )
    assert.deepEqual(next.named, ["Clientes", "Empresa", "Personal"])
    assert.deepEqual(next.assignments, { a: "Clientes", b: "Personal" })
  })

  it("deletes a folder and unassigns its chats", () => {
    const next = deleteChatFolder(
      { a: "Trabajo", b: "Personal" },
      ["Trabajo", "Empresa"],
      "Trabajo",
    )
    assert.deepEqual(next.named, ["Empresa", "Personal"])
    assert.deepEqual(next.assignments, { b: "Personal" })
  })
})
