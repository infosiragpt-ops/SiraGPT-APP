"use client"

import * as React from "react"

import {
  createWordClipboardPayloadFromHtml,
  setClipboardDataForWord,
} from "@/lib/rich-clipboard"

const NATIVE_COPY_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='textbox']",
  ".monaco-editor",
  ".cm-editor",
  "[data-sgpt-native-copy]",
  "[data-no-rich-copy]",
].join(",")

function asElement(node: Node | null): Element | null {
  if (!node) return null
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element
  return node.parentElement
}

function isNativeCopySurface(node: Node | null) {
  return Boolean(asElement(node)?.closest(NATIVE_COPY_SELECTOR))
}

function selectionToHtml(selection: Selection) {
  const holder = document.createElement("div")
  for (let index = 0; index < selection.rangeCount; index += 1) {
    holder.appendChild(selection.getRangeAt(index).cloneContents())
  }
  return holder.innerHTML
}

function shouldLetBrowserHandleCopy(event: ClipboardEvent, selection: Selection) {
  if (event.defaultPrevented) return true
  if (!event.clipboardData) return true
  if (selection.isCollapsed || selection.rangeCount === 0) return true
  if (!selection.toString().trim()) return true

  const active = document.activeElement
  if (active && isNativeCopySurface(active)) return true
  if (isNativeCopySurface(event.target as Node | null)) return true
  if (isNativeCopySurface(selection.anchorNode) || isNativeCopySurface(selection.focusNode)) return true

  return false
}

export function OfficeClipboardBridge() {
  React.useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      const selection = window.getSelection()
      if (!selection || shouldLetBrowserHandleCopy(event, selection)) return

      const selectedHtml = selectionToHtml(selection)
      const payload = createWordClipboardPayloadFromHtml(selectedHtml, selection.toString())
      if (!payload.text) return

      setClipboardDataForWord(event.clipboardData!, payload)
      event.preventDefault()
    }

    document.addEventListener("copy", handleCopy)
    return () => document.removeEventListener("copy", handleCopy)
  }, [])

  return null
}
