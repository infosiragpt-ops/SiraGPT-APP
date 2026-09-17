import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  contentWithoutHiddenImages,
  isAssistantMessage,
  parseMessageFilesForRender,
  shouldRenderChatMessage,
} from "../lib/chat/message-rendering"

describe("chat message rendering", () => {
  const hiddenImage = { type: 'image', fileId: 'artifact:abcdef123456', url: '/api/agent/artifact/abcdef123456?name=imagen.png', deletedAt: '2026-09-17' }
  it('hides exact inline image references while retaining prose and visible neighbors', () => {
    const content = 'Antes ![oculta](/api/agent/artifact/abcdef123456?name=otra.png) después.\n![visible](/api/agent/artifact/abcdef1234567)\n[Documento](/uploads/docs/doc.pdf)'
    const files = [hiddenImage, { type: 'image', url: '/api/agent/artifact/abcdef1234567' }]
    assert.equal(contentWithoutHiddenImages(content, JSON.stringify(files)), 'Antes  después.\n![visible](/api/agent/artifact/abcdef1234567)\n[Documento](/uploads/docs/doc.pdf)')
    assert.equal(files[0], hiddenImage)
    assert.ok(content.includes('![oculta]'))
  })
  it('hides bare local URLs and whole image-only messages without changing user turns', () => {
    const files = [{ type: 'image', url: '/uploads/images/image(2).png', deletedAt: '2026-09-17' }]
    assert.equal(contentWithoutHiddenImages('https://siragpt.com/uploads/images/image(2).png', files), '')
    assert.equal(contentWithoutHiddenImages('![Imagen](/uploads/images/image(2).png "Título")', files), '')
    assert.equal(shouldRenderChatMessage({ role: 'ASSISTANT', content: '/uploads/images/image(2).png', files }), false)
    assert.equal(shouldRenderChatMessage({ role: 'USER', content: '/uploads/images/image(2).png', files }), true)
  })
  it('removes hidden reference-style and HTML previews but keeps visible references', () => {
    const content = 'Texto ![secreta][hide] ![viva][keep]\n[hide]: /api/agent/artifact/abcdef123456\n[keep]: /uploads/images/live.png\n<img alt="oculta" src="/api/agent/artifact/abcdef123456?name=x.png">'
    assert.equal(contentWithoutHiddenImages(content, [hiddenImage]), 'Texto  ![viva][keep]\n\n[keep]: /uploads/images/live.png\n')
  })
  it('removes only hidden download destinations and preserves their labels and unrelated links', () => {
    const content = '[Ver imagen](/api/agent/artifact/abcdef123456) y [otra](https://other.test/a.png).'
    assert.equal(contentWithoutHiddenImages(content, [hiddenImage]), 'Ver imagen y [otra](https://other.test/a.png).')
    assert.equal(contentWithoutHiddenImages(content, [{ ...hiddenImage, deletedAt: undefined }]), content)
    assert.equal(contentWithoutHiddenImages(content, 'not JSON'), content)
  })
  it("hides only deleted attachments while preserving visible siblings", () => {
    const files = [{ id: "hidden", deletedAt: "2026-09-17T00:00:00Z" }, { id: "visible" }]
    assert.deepEqual(parseMessageFilesForRender(files), [files[1]])
    assert.deepEqual(parseMessageFilesForRender(JSON.stringify(files)), [files[1]])
  })
  it("accepts arrays and safely parses persisted JSON file lists", () => {
    const files = [{ id: "file-1" }]
    assert.equal(parseMessageFilesForRender(files), files)
    assert.deepEqual(parseMessageFilesForRender(JSON.stringify(files)), files)
    assert.deepEqual(parseMessageFilesForRender("not json"), [])
    assert.deepEqual(parseMessageFilesForRender('{"id":"file-1"}'), [])
  })

  it("always keeps user turns, including attachment-only and optimistic turns", () => {
    assert.equal(shouldRenderChatMessage({ role: "user", content: "" }), true)
    assert.equal(shouldRenderChatMessage({ role: "USER", files: [] }), true)
  })

  it("renders assistant turns only when they expose content, files, progress, or errors", () => {
    assert.equal(shouldRenderChatMessage({ role: "assistant", content: "" }), false)
    assert.equal(shouldRenderChatMessage({ role: "assistant", content: " listo " }), true)
    assert.equal(shouldRenderChatMessage({ role: "assistant", files: '[{"id":"1"}]' }), true)
    assert.equal(shouldRenderChatMessage({ role: "assistant", progressStage: "searching" }), true)
    assert.equal(shouldRenderChatMessage({ role: "assistant", error: "timeout" }), true)
  })

  it("permits an empty assistant shell only for the active stream", () => {
    const assistant = { role: "Assistant", content: "" }
    assert.equal(isAssistantMessage(assistant), true)
    assert.equal(shouldRenderChatMessage(assistant), false)
    assert.equal(shouldRenderChatMessage(assistant, true), true)
    assert.equal(isAssistantMessage({ role: "user" }), false)
  })

  it("keeps audio attachments when parsing optimistic and persisted file lists", () => {
    const audio = [{ id: "a1", name: "clip.wav", mimeType: "audio/wav" }]
    assert.equal(parseMessageFilesForRender(audio), audio)
    assert.deepEqual(parseMessageFilesForRender(JSON.stringify(audio)), audio)
    assert.equal(
      shouldRenderChatMessage({ role: "USER", content: "", files: audio }),
      true,
    )
  })
})
