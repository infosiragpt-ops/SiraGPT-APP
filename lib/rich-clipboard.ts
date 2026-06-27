"use client"

import DOMPurify from "dompurify"
import { marked } from "marked"

type ClipboardPayload = {
  html: string
  text: string
  rtf: string
}

function getErrorName(err: unknown): string {
  return err instanceof Error ? err.name : ""
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isClipboardPermissionDenied(err: unknown): boolean {
  const name = getErrorName(err)
  const message = getErrorMessage(err)
  return name === "NotAllowedError" || /write permission denied/i.test(message)
}

const START_FRAGMENT = "<!--StartFragment-->"
const END_FRAGMENT = "<!--EndFragment-->"

marked.setOptions({ gfm: true, breaks: false, pedantic: false })

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DL",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
])

const OFFICE_STYLES: Record<string, string> = {
  H1: "margin:0 0 12pt 0;font-family:Aptos,Arial,sans-serif;font-size:20pt;line-height:1.2;font-weight:700;color:#111827;",
  H2: "margin:16pt 0 8pt 0;font-family:Aptos,Arial,sans-serif;font-size:16pt;line-height:1.25;font-weight:700;color:#111827;",
  H3: "margin:14pt 0 6pt 0;font-family:Aptos,Arial,sans-serif;font-size:13pt;line-height:1.3;font-weight:700;color:#111827;",
  H4: "margin:12pt 0 6pt 0;font-family:Aptos,Arial,sans-serif;font-size:11.5pt;line-height:1.3;font-weight:700;color:#111827;",
  P: "margin:0 0 10pt 0;font-family:Aptos,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#111827;",
  UL: "margin:0 0 10pt 20pt;padding:0;font-family:Aptos,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#111827;",
  OL: "margin:0 0 10pt 20pt;padding:0;font-family:Aptos,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#111827;",
  LI: "margin:0 0 4pt 0;font-family:Aptos,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#111827;",
  BLOCKQUOTE: "margin:10pt 0 10pt 12pt;padding:0 0 0 10pt;border-left:3pt solid #CBD5E1;font-family:Aptos,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#374151;",
  TABLE: "border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;margin:8pt 0 12pt 0;width:100%;font-family:Aptos,Arial,sans-serif;font-size:10.5pt;color:#111827;",
  THEAD: "font-family:Aptos,Arial,sans-serif;",
  TBODY: "font-family:Aptos,Arial,sans-serif;",
  TR: "page-break-inside:avoid;",
  TH: "border:1pt solid #94A3B8;background:#EEF2F7;padding:5pt 7pt;text-align:left;vertical-align:top;font-family:Aptos,Arial,sans-serif;font-size:10.5pt;line-height:1.35;font-weight:700;color:#111827;",
  TD: "border:1pt solid #CBD5E1;padding:5pt 7pt;text-align:left;vertical-align:top;font-family:Aptos,Arial,sans-serif;font-size:10.5pt;line-height:1.35;color:#111827;",
  PRE: "margin:8pt 0 12pt 0;padding:8pt;border:1pt solid #CBD5E1;background:#F8FAFC;white-space:pre-wrap;font-family:Consolas,'Courier New',monospace;font-size:9.5pt;line-height:1.35;color:#111827;",
  CODE: "font-family:Consolas,'Courier New',monospace;font-size:9.5pt;background:#F3F4F6;color:#111827;",
  STRONG: "font-weight:700;",
  B: "font-weight:700;",
  EM: "font-style:italic;",
  I: "font-style:italic;",
  A: "color:#075985;text-decoration:underline;",
  HR: "border:0;border-top:1pt solid #CBD5E1;margin:14pt 0;",
  IMG: "max-width:100%;height:auto;",
}

const COPY_ALLOWED_ATTRS = new Set([
  "href",
  "title",
  "target",
  "rel",
  "colspan",
  "rowspan",
  "start",
  "src",
  "alt",
  "width",
  "height",
])

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeRtf(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, "\\par\n")
}

function plainTextToRtf(text: string) {
  return `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Aptos;}{\\f1 Calibri;}}\\fs22 ${escapeRtf(text)}}`
}

function sanitizeHtml(value: string) {
  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [
      "a",
      "b",
      "blockquote",
      "br",
      "code",
      "col",
      "colgroup",
      "dd",
      "del",
      "div",
      "dl",
      "dt",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "img",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "span",
      "strong",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "tfoot",
      "th",
      "thead",
      "tr",
      "u",
      "ul",
    ],
    ALLOWED_ATTR: Array.from(COPY_ALLOWED_ATTRS),
    ALLOW_DATA_ATTR: false,
  })
}

function removeNonPortableUi(root: HTMLElement) {
  root.querySelectorAll(
    [
      "button",
      "svg",
      "style",
      "script",
      "noscript",
      "[data-copy-exclude]",
      "[aria-hidden='true']",
      ".sr-only",
      ".sgpt-copy-exclude",
      ".copy-exclude",
    ].join(","),
  ).forEach((node) => node.remove())
}

function normalizeAttributes(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("*").forEach((el) => {
    const tag = el.tagName.toUpperCase()
    for (const attr of Array.from(el.attributes)) {
      if (!COPY_ALLOWED_ATTRS.has(attr.name.toLowerCase())) {
        el.removeAttribute(attr.name)
      }
    }

    const style = OFFICE_STYLES[tag]
    if (style) el.setAttribute("style", style)

    if (tag === "A") {
      const href = el.getAttribute("href") || ""
      if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href) && !/^tel:/i.test(href) && !href.startsWith("#")) {
        el.removeAttribute("href")
      }
      el.setAttribute("target", "_blank")
      el.setAttribute("rel", "noopener noreferrer")
    }

    if (tag === "IMG") {
      const src = el.getAttribute("src") || ""
      if (!/^https?:\/\//i.test(src) && !/^data:image\//i.test(src)) {
        el.remove()
      }
    }
  })
}

function unwrapEmptyContainers(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("div,span").forEach((el) => {
    const hasElementChildren = Array.from(el.children).some((child) => BLOCK_TAGS.has(child.tagName.toUpperCase()))
    const text = (el.textContent || "").replace(/\s+/g, "")
    if (!hasElementChildren && !text && el.querySelectorAll("img,table,pre").length === 0) {
      el.remove()
    }
  })
}

function normalizeHtmlForWord(fragmentHtml: string) {
  if (typeof window === "undefined") return fragmentHtml

  const cleanHtml = sanitizeHtml(fragmentHtml)
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<article>${cleanHtml}</article>`, "text/html")
  const root = doc.body.firstElementChild as HTMLElement | null
  if (!root) return ""

  removeNonPortableUi(root)
  unwrapEmptyContainers(root)
  normalizeAttributes(root)

  root.setAttribute(
    "style",
    "margin:0;font-family:Aptos,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#111827;",
  )

  return root.innerHTML.trim()
}

function normalizePlainBlock(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function tableToPlainText(table: Element) {
  return Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td"))
        .map((cell) => normalizePlainBlock(cell.textContent || ""))
        .join("\t"),
    )
    .filter(Boolean)
    .join("\n")
}

function inlineTextFromNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ""
  if (node.nodeType !== Node.ELEMENT_NODE) return ""

  const el = node as Element
  const tag = el.tagName.toUpperCase()

  if (tag === "BR") return "\n"
  if (tag === "TABLE") return tableToPlainText(el)
  if (tag === "PRE") return el.textContent || ""
  if (tag === "IMG") return el.getAttribute("alt") || ""

  return Array.from(el.childNodes).map(inlineTextFromNode).join("")
}

function inlineTextWithoutNestedLists(el: Element) {
  return Array.from(el.childNodes)
    .filter((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return true
      const tag = (node as Element).tagName.toUpperCase()
      return tag !== "UL" && tag !== "OL"
    })
    .map(inlineTextFromNode)
    .join("")
}

function htmlToPlainText(fragmentHtml: string, fallback = "") {
  if (typeof window === "undefined") return fallback.trim()

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<article>${fragmentHtml}</article>`, "text/html")
  const blocks: string[] = []

  const walk = (node: Element, listPrefix?: string) => {
    const tag = node.tagName.toUpperCase()

    if (tag === "TABLE") {
      blocks.push(tableToPlainText(node))
      return
    }

    if (tag === "PRE") {
      blocks.push((node.textContent || "").trim())
      return
    }

    if (tag === "UL" || tag === "OL") {
      Array.from(node.children).forEach((child, index) => {
        if (child.tagName.toUpperCase() !== "LI") return
        walk(child, tag === "OL" ? `${index + 1}.` : "-")
      })
      return
    }

    if (tag === "LI") {
      const text = normalizePlainBlock(inlineTextWithoutNestedLists(node))
      if (text) blocks.push(`${listPrefix || "-"} ${text}`)
      Array.from(node.children)
        .filter((child) => ["UL", "OL"].includes(child.tagName.toUpperCase()))
        .forEach((child) => walk(child))
      return
    }

    if (["H1", "H2", "H3", "H4", "P", "BLOCKQUOTE"].includes(tag)) {
      blocks.push(normalizePlainBlock(inlineTextFromNode(node)))
      return
    }

    const blockChildren = Array.from(node.children).filter((child) =>
      BLOCK_TAGS.has(child.tagName.toUpperCase()),
    )

    if (blockChildren.length > 0) {
      blockChildren.forEach((child) => walk(child))
      return
    }

    const text = normalizePlainBlock(inlineTextFromNode(node))
    if (text) blocks.push(text)
  }

  Array.from(doc.body.children).forEach((child) => walk(child))

  const text = blocks
    .map((block) => normalizePlainBlock(block))
    .filter(Boolean)
    .join("\n\n")

  return (text || normalizePlainBlock(inlineTextFromNode(doc.body)) || fallback || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function stripNonCopyableArtifactBlocks(value: string) {
  return String(value || "")
    .replace(/<artifact\b[^>]*>[\s\S]*?<\/artifact>/gi, "")
    .replace(/```html\s*\n[\s\S]*?<!DOCTYPE html>[\s\S]*?\n```/gi, "")
    .trim()
}

export function createWordClipboardPayloadFromHtml(html: string, fallbackText = ""): ClipboardPayload {
  const fragment = normalizeHtmlForWord(html)
  const text = htmlToPlainText(fragment, fallbackText)
  const body = `${START_FRAGMENT}<div>${fragment || `<p>${escapeHtml(text)}</p>`}</div>${END_FRAGMENT}`

  return {
    html: [
      "<!doctype html>",
      "<html>",
      "<head><meta charset=\"utf-8\"></head>",
      "<body>",
      body,
      "</body>",
      "</html>",
    ].join(""),
    text,
    rtf: plainTextToRtf(text),
  }
}

export function createWordClipboardPayloadFromMarkdown(markdown: string): ClipboardPayload {
  const safeMarkdown = stripNonCopyableArtifactBlocks(markdown)
  const rendered = safeMarkdown
    ? (marked.parse(safeMarkdown) as string)
    : ""
  return createWordClipboardPayloadFromHtml(rendered, safeMarkdown)
}

export function createWordClipboardPayloadFromSelection(root: HTMLElement, fallbackMarkdown = ""): ClipboardPayload | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const anchor = selection.anchorNode
  const focus = selection.focusNode
  if ((anchor && !root.contains(anchor)) || (focus && !root.contains(focus))) return null

  const range = selection.getRangeAt(0)
  const holder = document.createElement("div")
  holder.appendChild(range.cloneContents())

  const selectedText = selection.toString()
  return createWordClipboardPayloadFromHtml(holder.innerHTML, selectedText || fallbackMarkdown)
}

export function setClipboardDataForWord(clipboardData: DataTransfer, payload: ClipboardPayload) {
  clipboardData.setData("text/html", payload.html)
  clipboardData.setData("text/plain", payload.text)

  try {
    clipboardData.setData("text/rtf", payload.rtf)
  } catch {
    // Some browsers expose only text/plain + text/html for copy events.
  }
}

function legacyTextCopy(text: string) {
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.left = "-9999px"
  ta.style.top = "0"
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand("copy")
  document.body.removeChild(ta)
  if (!ok) throw new Error("execCommand_copy_failed")
}

export async function writeWordClipboardPayload(payload: ClipboardPayload) {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new Error("clipboard_unavailable")
  }

  const ClipboardItemCtor = (window as any).ClipboardItem
  const canWriteRich =
    !!navigator.clipboard &&
    typeof navigator.clipboard.write === "function" &&
    !!ClipboardItemCtor &&
    window.isSecureContext

  if (canWriteRich) {
    const supports = typeof ClipboardItemCtor.supports === "function"
      ? (type: string) => {
          try {
            return ClipboardItemCtor.supports(type)
          } catch {
            return false
          }
        }
      : null

    const plain = new Blob([payload.text], { type: "text/plain" })
    const html = payload.html ? new Blob([payload.html], { type: "text/html" }) : null
    // Safari does NOT accept `text/rtf` in a ClipboardItem, and when
    // `ClipboardItem.supports` is unavailable, optimistically including it made
    // Safari reject the ENTIRE write — so the user silently got plain text
    // instead of the formatted HTML. Only include rtf when explicitly supported.
    const rtf = payload.rtf && supports?.("text/rtf")
      ? new Blob([payload.rtf], { type: "text/rtf" })
      : null

    // Try richest → safest. If a browser rejects an exotic MIME type, fall back
    // to text/html (formatted Office paste) rather than dropping to plain text.
    const attempts: Record<string, Blob>[] = []
    if (html && rtf) attempts.push({ "text/plain": plain, "text/html": html, "text/rtf": rtf })
    if (html) attempts.push({ "text/plain": plain, "text/html": html })
    attempts.push({ "text/plain": plain })

    for (let i = 0; i < attempts.length; i++) {
      try {
        await navigator.clipboard.write([new ClipboardItemCtor(attempts[i])])
        return
      } catch (err) {
        // A denied permission won't be fixed by writing fewer MIME types — stop
        // retrying and fall through to the writeText/legacy paths below.
        if (isClipboardPermissionDenied(err)) break
        // Otherwise the browser likely rejected a MIME type (e.g. Safari + rtf);
        // try the next, smaller set so the user still gets rich HTML.
        if (i === attempts.length - 1) {
          console.warn("[rich-clipboard] Falling back to text clipboard", getErrorMessage(err))
        }
      }
    }
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(payload.text)
      return
    } catch (err) {
      if (!isClipboardPermissionDenied(err)) {
        console.warn("[rich-clipboard] Falling back to legacy text clipboard", getErrorMessage(err))
      }
    }
  }

  legacyTextCopy(payload.text)
}

export async function copyMarkdownToWordClipboard(markdown: string) {
  const payload = createWordClipboardPayloadFromMarkdown(markdown)
  await writeWordClipboardPayload(payload)
  return payload
}
