/**
 * Word / Google Docs rich HTML -> safe Markdown.
 *
 * Pipeline: strip Word artifacts (regex) -> DOM pre-clean (unwrap Google Docs
 * bold wrappers, drop mso-* styles / Mso* classes) -> DOMPurify with a
 * conservative allowlist -> Turndown with a hand-rolled GFM table rule.
 */
import DOMPurify from 'dompurify'
import TurndownService from 'turndown'

const ALLOWED_TAGS = [
  'p', 'div', 'span', 'br',
  'b', 'strong', 'i', 'em', 'u', 's',
  'a',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'blockquote', 'pre', 'code', 'img',
]

const ALLOWED_ATTR = ['href', 'src', 'alt', 'colspan', 'rowspan']

/**
 * Tags whose presence marks the input as "rich" (formatted) HTML.
 * No whitespace is allowed after '<' (per the HTML spec, '< b' is text,
 * not a tag), which avoids false positives on prose like 'a < b'.
 */
const RICH_TAG_PATTERN =
  /<(?:p|div|span|br|b|strong|i|em|u|s|a|ul|ol|li|h[1-6]|table|thead|tbody|tr|th|td|blockquote|pre|code|img)\b[^>]*\/?>/i

/**
 * Removes Microsoft Word / Outlook paste artifacts that are pure noise:
 * conditional comments, embedded XML islands and Office-namespaced tags.
 * Text content inside namespaced tags (e.g. <o:p>) is preserved.
 */
function stripWordArtifacts(html: string): string {
  return html
    // Conditional comments: <!--[if gte mso 9]> ... <![endif]-->
    .replace(/<!--\[if[\s\S]*?<!\[endif\]\s*-->/gi, '')
    // Downlevel-revealed variant: <![if !supportLists]> ... <![endif]>
    .replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, '')
    // Embedded Office XML islands: <xml> ... </xml>
    .replace(/<xml[\s\S]*?<\/xml\s*>/gi, '')
    // Office-namespaced tags such as <o:p>, <w:sdt>, keep inner text
    .replace(/<\/?(?:o|w|m|v|st1):[a-z0-9]+[^>]*>/gi, '')
}

/** Replaces an element with its own children (keeps content, drops the tag). */
function unwrapElement(el: Element): void {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
}

/** True for Google Docs wrappers like <b style="font-weight:normal" id="docs-internal-guid-...">. */
function isGoogleDocsBoldWrapper(el: Element): boolean {
  const id = el.getAttribute('id') ?? ''
  if (id.startsWith('docs-internal-guid')) return true
  const style = (el.getAttribute('style') ?? '').replace(/\s+/g, '').toLowerCase()
  return style.includes('font-weight:normal') || style.includes('font-weight:400')
}

/**
 * DOM-level pre-clean before sanitization:
 * - unwrap Google Docs <b> wrappers so their content is NOT bold-ified
 *   (the HTML parser may clone the wrapper into block children, so every
 *   matching <b> is unwrapped, not just the outermost one);
 * - strip mso-* inline style declarations and Mso* classes from Word.
 */
function preCleanDom(html: string): string {
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')

  for (const el of Array.from(doc.querySelectorAll('b'))) {
    if (isGoogleDocsBoldWrapper(el)) unwrapElement(el)
  }

  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const style = el.getAttribute('style') ?? ''
    if (!/(^|[;\s])mso-/i.test(style)) continue
    const kept = style
      .split(';')
      .filter((decl) => decl.trim() && !/^mso-/i.test(decl.trim()))
      .join(';')
    if (kept.trim()) el.setAttribute('style', kept)
    else el.removeAttribute('style')
  }

  for (const el of Array.from(doc.querySelectorAll('[class]'))) {
    const classes = (el.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((cls) => cls && !/^Mso/i.test(cls))
    if (classes.length > 0) el.setAttribute('class', classes.join(' '))
    else el.removeAttribute('class')
  }

  return doc.body.innerHTML
}

/**
 * Sanitizes rich HTML (Word / Google Docs paste) down to a conservative
 * allowlist of structural and formatting tags. Scripts, styles, event
 * handlers and editor artifacts are removed; plain text is preserved.
 */
export function sanitizeRichHtml(html: string): string {
  if (!html || typeof html !== 'string') return ''
  const preCleaned = preCleanDom(stripWordArtifacts(html))
  return DOMPurify.sanitize(preCleaned, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  })
}

/** Normalizes whitespace inside a table cell and escapes GFM pipes. */
function escapeTableCell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

/**
 * Renders a <table> element as a GFM pipe table. Tables without a <thead>
 * use their first row as the header row. Returns '' for empty tables.
 */
function renderGfmTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'))
    .filter((tr) => tr.closest('table') === table)
    .map((tr) =>
      Array.from(tr.children)
        .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
        .map((cell) => escapeTableCell(cell.textContent ?? ''))
    )
    .filter((cells) => cells.length > 0)

  if (rows.length === 0) return ''

  const width = Math.max(...rows.map((cells) => cells.length))
  const toLine = (cells: string[]): string => {
    const padded = [...cells]
    while (padded.length < width) padded.push('')
    return `| ${padded.join(' | ')} |`
  }

  const [headerRow, ...bodyRows] = rows
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  return [toLine(headerRow), separator, ...bodyRows.map(toLine)].join('\n')
}

let turndownInstance: TurndownService | null = null

function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  })
  // turndown-plugin-gfm is not installed; hand-rolled GFM table rule.
  service.addRule('gfmTable', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (content, node) => {
      const table = renderGfmTable(node as Element)
      return table ? `\n\n${table}\n\n` : content
    },
  })
  turndownInstance = service
  return service
}

/**
 * Converts rich HTML to Markdown: sanitize first, then Turndown (ATX
 * headings, '-' bullets, fenced code) with GFM pipe tables. Collapses
 * runs of 3+ newlines down to 2 and trims the result.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || typeof html !== 'string') return ''
  const safe = sanitizeRichHtml(html)
  if (!safe.trim()) return ''
  const markdown = getTurndown().turndown(safe)
  return markdown.replace(/\n{3,}/g, '\n\n').trim()
}

/** True when the input contains HTML formatting tags (rich content). */
export function isRichHtml(html: string): boolean {
  if (!html || typeof html !== 'string') return false
  return RICH_TAG_PATTERN.test(html)
}
