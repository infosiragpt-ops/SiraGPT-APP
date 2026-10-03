import { describe, expect, it } from "vitest"
import { displayUrl, hasRichUserTokens, tokenizeUserText } from "@/lib/chat/user-text-tokens"

describe("tokenizeUserText", () => {
  it("recognises a pasted recording link followed by the request, trimming the closing punctuation", () => {
    const tokens = tokenizeUserText("https://upn.class.com/player/recording/1d178f25-49ba-47b7-8b7f-b0e334ae0905 ) transcribir del minuto 1.5 al minuto 10")
    expect(tokens[0]).toMatchObject({ type: "url", href: "https://upn.class.com/player/recording/1d178f25-49ba-47b7-8b7f-b0e334ae0905" })
    expect((tokens[0] as { display: string }).display).toMatch(/^upn\.class\.com\/player\/recording\/1d178f25-49ba-47b7-8b7f-…$/)
    expect(tokens[1]).toEqual({ type: "text", value: " ) transcribir del minuto 1.5 al minuto 10" })
  })

  it("keeps sentence punctuation out of the link but keeps a balanced paren inside it", () => {
    const [, url, rest] = tokenizeUserText("mira https://es.wikipedia.org/wiki/Python_(lenguaje).")
    expect(url).toMatchObject({ type: "url", value: "https://es.wikipedia.org/wiki/Python_(lenguaje)" })
    expect(rest).toEqual({ type: "text", value: "." })
    const [, plain, dot] = tokenizeUserText("ver https://siragpt.com/agentes, luego")
    expect(plain).toMatchObject({ type: "url", value: "https://siragpt.com/agentes" })
    expect(dot).toEqual({ type: "text", value: ", luego" })
  })

  it("links a bare www host, mails an e-mail, chips file names and timecodes, codes backticks", () => {
    const tokens = tokenizeUserText("revisa informe_final.docx, escribe a luis@siragpt.com (ver www.ejemplo.com/ruta). Corta de 1:30 a 01:02:03 y usa `npm test`.")
    expect(tokens.map((t) => t.type)).toEqual(["text", "file", "text", "email", "text", "url", "text", "timecode", "text", "timecode", "text", "code", "text"])
    expect(tokens[1]).toEqual({ type: "file", value: "informe_final.docx", ext: "docx" })
    expect(tokens[3]).toEqual({ type: "email", value: "luis@siragpt.com", href: "mailto:luis@siragpt.com" })
    expect(tokens[5]).toMatchObject({ type: "url", href: "https://www.ejemplo.com/ruta", display: "ejemplo.com/ruta" })
    expect(tokens[7]).toEqual({ type: "timecode", value: "1:30" })
    expect(tokens[11]).toEqual({ type: "code", value: "npm test" })
  })

  it("leaves plain prose, decimals and counts untouched", () => {
    expect(tokenizeUserText("hola, ¿cómo estás? 10.5 kg y 3 archivos.")).toEqual([{ type: "text", value: "hola, ¿cómo estás? 10.5 kg y 3 archivos." }])
    expect(tokenizeUserText("")).toEqual([])
    expect(hasRichUserTokens("solo texto")).toBe(false)
    expect(hasRichUserTokens("ver a.pdf")).toBe(true)
  })

  it("never swallows the words before a file name with spaces (chips the last word only)", () => {
    const tokens = tokenizeUserText("revisa informe final.docx y ventas 2026.xlsx")
    expect(tokens.filter((t) => t.type === "file").map((t) => t.value)).toEqual(["final.docx", "2026.xlsx"])
  })

  it("displayUrl bounds long paths and keeps the host", () => {
    expect(displayUrl("https://www.youtube.com/watch?v=abcdefghijk&t=120s&list=PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toMatch(/^youtube\.com\/watch\?v=abcdefghijk.*…$/)
    expect(displayUrl("https://siragpt.com/")).toBe("siragpt.com")
    expect(displayUrl("https://siragpt.com/agentes")).toBe("siragpt.com/agentes")
  })
})
