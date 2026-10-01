import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("message render stability · source contracts", () => {
  const message = source("components/message-component.tsx")

  it("renders markdown through a module-level memoized component, never an inner one", () => {
    assert.match(message, /const MessageMarkdown = React\.memo\(function MessageMarkdown\(/)
    assert.doesNotMatch(message, /const MessageContent = /)
    assert.doesNotMatch(message, /<MessageContent /)
    // The hoisted component receives stable callbacks from MessageComponent.
    assert.match(message, /const handleExpandTable = useCallback\(/)
    assert.match(message, /const stablePreview = useCallback\(\(\) => previewRef\.current\(\), \[\]\)/)
    assert.match(message, /onExpandTable=\{handleExpandTable\}/)
    assert.match(message, /onPreview=\{stablePreview\}/)
  })

  it("renders inner display helpers as calls so they are not remounted per render", () => {
    for (const name of [
      "FileDisplay",
      "PPTDisplay",
      "VideoDisplay",
      "ThesisDisplay",
      "GmailConnectionDisplay",
      "GoogleServicesConnectionDisplay",
      "SpotifyConnectionDisplay",
      "SpotifyResultsDisplay",
      "ComputerUseReasoningDisplay",
    ]) {
      assert.doesNotMatch(message, new RegExp(`<${name} />`), `${name} must not be mounted as an element`)
      assert.match(message, new RegExp(`\\{${name}\\(\\)\\}`), `${name} must be called directly`)
    }
  })

  it("keeps no write-only audio/video state and no per-frame draft sync", () => {
    assert.doesNotMatch(message, /ontimeupdate/)
    assert.doesNotMatch(message, /setAudioProgress|setShowAudioPlayer|setVideoLoading|setVideoProgress/)
    assert.doesNotMatch(message, /useEffect\(\(\) => \{\s*setEditedContent\(message\.content\);\s*\}, \[message\.content\]\)/)
    assert.match(message, /setEditedContent\(message\.content\);\s*setIsEditing\(true\);/)
  })

  it("only the message that started read-aloud cancels the shared speech engine on unmount", () => {
    assert.match(message, /let speechEngineOwner: symbol \| null = null;/)
    assert.match(message, /speechEngineOwner = speechOwnerIdRef\.current;/)
    assert.match(message, /if \(speechEngineOwner === speechOwnerIdRef\.current\) \{\s*speechEngineOwner = null;/)
    assert.doesNotMatch(message, /window\.speechSynthesis\.cancel\(\)/)
  })

  it("detects thesis messages with one precompiled marker regex, computed once per render", () => {
    assert.match(message, /const THESIS_MARKER_RE = /)
    assert.doesNotMatch(message, /thesisPatterns/)
    assert.match(message, /const thesisData = useMemo\(\(\) => getThesisData\(\)/)
    assert.match(message, /!hasFigmaDiagram && !thesisData &&/)
  })

  it("passes markdown list/table attributes through and does not double-frame fenced code", () => {
    assert.match(message, /ol: \(\{ node, children, className, \.\.\.rest \}: any\) => <ol \{\.\.\.rest\}/)
    assert.match(message, /ul: \(\{ node, children, className, \.\.\.rest \}: any\) => <ul \{\.\.\.rest\}/)
    assert.match(message, /li: \(\{ node, children, className, \.\.\.rest \}: any\) => <li \{\.\.\.rest\}/)
    assert.match(message, /th: \(\{ node, children, style, \.\.\.rest \}: any\) => <th \{\.\.\.rest\} style=\{style\}/)
    assert.match(message, /style=\{\{ \.\.\.style, overflowWrap: 'anywhere', maxWidth: '28rem' \}\}/)
    assert.match(message, /childProps\?\.node\?\.tagName === 'code'/)
  })

  it("reveals image/chart/user actions on keyboard focus and on touch, scoped to their own group", () => {
    assert.match(message, /relative inline-block w-full group\/chart/)
    assert.match(message, /\[@media\(hover:hover\)\]:group-hover\/chart:opacity-100 focus-within:opacity-100/)
    assert.match(message, /relative inline-block group\/img/)
    assert.match(message, /\[@media\(hover:hover\)\]:group-hover\/img:opacity-100 focus-visible:opacity-100/)
    assert.match(message, /aria-label="Descargar imagen"/)
    assert.doesNotMatch(message, /title="Download image"/)
    assert.match(message, /\[@media\(hover:hover\)\]:group-hover\/image:opacity-100 focus-within:opacity-100/)
    assert.match(message, /cursor-crosshair touch-none/)
    assert.match(message, /\[@media\(hover:hover\)\]:opacity-0 \[@media\(hover:hover\)\]:group-hover:opacity-100 focus-within:opacity-100/)
  })

  it("opens attached user images from a real button and fits the edit box on phones", () => {
    assert.match(message, /aria-label=\{`Ampliar imagen \$\{file\.name \|\| file\.originalName \|\| ""\}`\.trim\(\)\}/)
    assert.match(message, /min-w-0 sm:min-w-\[300px\] md:min-w-\[500px\]/)
    assert.match(message, /isEditing && "!w-full !max-w-full"/)
  })

  it("keeps the dislike state neutral and spaces the more-actions menu items", () => {
    const rail = source("components/MessageActionRail.tsx")
    assert.doesNotMatch(rail, /destructive/)
    assert.equal(rail.match(/className="gap-2\.5"/g)?.length, 4)
  })

  it("loads docx lazily from the table download helpers", () => {
    const utils = source("lib/download-utils.ts")
    assert.match(utils, /import type \{ Paragraph as DocxParagraph \} from 'docx';/)
    assert.match(utils, /await import\('docx'\)/)
    assert.doesNotMatch(utils, /^import \{[^}]*\} from 'docx';/m)
  })
})
