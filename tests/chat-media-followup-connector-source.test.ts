import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"), "utf8")

// With Gmail, Calendar, Drive, Spotify or Computer active, the turn belongs
// to that connector: «agenda una reunión de 10:00 a 11:00» must reach the
// calendar, never the media branch with the last recording of the chat.
describe("media follow-up vs dedicated connectors (source contract)", () => {
  it("never borrows the last recording while a dedicated connector owns the turn", () => {
    const sendStart = source.indexOf("const handleSend = async () => {")
    assert.ok(sendStart > 0, "missing handleSend")
    const send = source.slice(sendStart, source.indexOf("const handleGmailCommand = async", sendStart))
    const owns = send.match(/const connectorOwnsTurn = ([^;]+);/)
    assert.ok(owns, "handleSend computes connectorOwnsTurn")
    for (const flag of ["isGmailActive", "isGoogleCalendarActive", "isGoogleDriveActive", "isSpotifyActive", "isComputerUseActive"]) {
      assert.match(owns[1], new RegExp(`\\b${flag}\\b`), `${flag} owns its turn`)
    }
    assert.match(
      send,
      /const mediaFollowupFiles = !codingWorkspace && composerFiles\.length === 0\s*\? resolveMediaFollowupFiles\(msg, currentChat\?\.messages \|\| \[\]\)\.filter\(\(\) => !connectorOwnsTurn\)\s*: \[\];/,
    )
    assert.ok(send.indexOf("const connectorOwnsTurn") < send.indexOf("const mediaFollowupFiles"))
  })
})
