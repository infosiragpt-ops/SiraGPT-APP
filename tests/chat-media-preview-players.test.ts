import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import {
  isAudioComposerFile,
  isVideoComposerFile,
  resolveComposerMediaSrc,
  snapshotComposerFilesForMessage,
} from "../lib/chat/composer-files"
import {
  assertMonochromeMediaPlayerChrome,
  formatMediaClock,
  forbiddenMediaPlayerColorHits,
  isFilenameOnlyPreview,
  mediaPlayerChrome,
  mediaPreviewAspectCss,
  mediaPreviewCombos,
  normalizeMediaPreviewAspect,
  normalizeWaveformPeaks,
  type MediaPreviewKind,
} from "../lib/chat/media-preview-players"
import {
  mergeChatPreservingUserMessages,
} from "../lib/message-preservation"

const chatInterface = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)
const messageComponent = fs.readFileSync(
  path.join(process.cwd(), "components", "message-component.tsx"),
  "utf8",
)
const playerSource = fs.readFileSync(
  path.join(process.cwd(), "components", "chat", "media-preview-players.tsx"),
  "utf8",
)
const viewerSource = fs.readFileSync(
  path.join(process.cwd(), "components", "viewers", "UnifiedDocumentViewer.tsx"),
  "utf8",
)

const videoFile = {
  id: "file-video-1",
  tempId: "temp-video-1",
  name: "clip.mp4",
  originalName: "clip.mp4",
  type: "video/mp4",
  mimeType: "video/mp4",
  size: 512_000,
  url: "/uploads/user/clip.mp4",
  preview: "blob:https://siragpt.com/video-preview",
  mediaMeta: { durationSeconds: 8.2, thumbnailDataUrl: "data:image/jpeg;base64,aaa" },
}

const audioFile = {
  id: "file-audio-1",
  tempId: "temp-audio-1",
  name: "nota.m4a",
  originalName: "nota.m4a",
  type: "audio/mp4",
  mimeType: "audio/mp4",
  size: 248_320,
  url: "/uploads/user/nota.m4a",
  preview: "blob:https://siragpt.com/audio-preview",
  mediaMeta: { durationSeconds: 12.4, peaks: [0.2, 0.8, 0.4, 0.9] },
}

describe("media preview helpers", () => {
  it("formats clocks and aspects", () => {
    assert.equal(formatMediaClock(0), "0:00")
    assert.equal(formatMediaClock(12.4), "0:12")
    assert.equal(formatMediaClock(75), "1:15")
    assert.equal(formatMediaClock(3661), "1:01:01")
    assert.equal(normalizeMediaPreviewAspect("9:16"), "9:16")
    assert.equal(normalizeMediaPreviewAspect("nope"), "16:9")
    assert.equal(mediaPreviewAspectCss("9:16"), "9 / 16")
  })

  it("classifies audio and video composer files and keeps a playable src", () => {
    assert.equal(isVideoComposerFile(videoFile), true)
    assert.equal(isAudioComposerFile(videoFile), false)
    assert.equal(isAudioComposerFile(audioFile), true)
    assert.equal(isVideoComposerFile(audioFile), false)
    assert.equal(isVideoComposerFile({ name: "demo.webm" }), true)
    assert.equal(isAudioComposerFile({ name: "demo.mp3" }), true)
    assert.equal(resolveComposerMediaSrc(videoFile), "blob:https://siragpt.com/video-preview")
    assert.equal(resolveComposerMediaSrc({ url: "/uploads/user/clip.mp4" }), "/uploads/user/clip.mp4")
  })

  it("normalizes waveform peaks without collapsing to empty", () => {
    const peaks = normalizeWaveformPeaks([0, 1, 0.5], 8)
    assert.equal(peaks.length, 8)
    assert.ok(peaks.every((n) => n >= 0.08 && n <= 1))
    assert.equal(normalizeWaveformPeaks([], 48).length, 48)
  })
})

describe("video and audio player chrome is black and white", () => {
  for (const kind of ["video", "audio"] as MediaPreviewKind[]) {
    it(`${kind} player frame has no purple/celeste tokens`, () => {
      const chrome = mediaPlayerChrome(kind)
      assertMonochromeMediaPlayerChrome(chrome.className)
      assert.equal(forbiddenMediaPlayerColorHits(chrome.className).length, 0)
    })
  }
})

function playerMarkupLooksReal(kind: MediaPreviewKind): boolean {
  if (kind === "video") {
    return playerSource.includes('data-testid="chat-video-player"')
      && playerSource.includes("<video")
      && playerSource.includes("chat-video-play")
      && playerSource.includes("formatMediaClock")
  }
  return playerSource.includes('data-testid="chat-audio-player"')
    && playerSource.includes("<audio")
    && playerSource.includes("chat-audio-play")
    && playerSource.includes("normalizeWaveformPeaks")
}

describe("preview combos keep a real player not a filename chip", () => {
  const combos = mediaPreviewCombos()
  it("enumerates kind x variant x aspect x poster x peaks x duration", () => {
    assert.equal(combos.length, 2 * 4 * 7 * 2 * 2 * 2)
    assert.ok(combos.length >= 400)
  })
  for (const combo of combos) {
    it(`${combo.kind} ${combo.variant} ${combo.aspect} poster=${combo.hasPoster} peaks=${combo.hasPeaks} dur=${combo.hasDuration}`, () => {
      const chrome = mediaPlayerChrome(combo.kind, combo.variant)
      assert.equal(forbiddenMediaPlayerColorHits(chrome.className).length, 0)
      assert.equal(playerMarkupLooksReal(combo.kind), true)
      assert.equal(isFilenameOnlyPreview(playerSource), false)
    })
  }
})

describe("composer and bubbles render video/audio players not filename chips", () => {
  it("composer attachment rail mounts ChatVideoPlayer and ChatAudioPlayer", () => {
    assert.match(chatInterface, /<ChatVideoPlayer/)
    assert.match(chatInterface, /<ChatAudioPlayer/)
    assert.match(chatInterface, /variant="composer"/)
    assert.match(chatInterface, /isVideo \? \(/)
  })

  it("user bubbles render players for video and audio attachments", () => {
    assert.match(messageComponent, /isVideoComposerFile/)
    assert.match(messageComponent, /<ChatVideoPlayer/)
    assert.match(messageComponent, /<ChatAudioPlayer/)
    assert.match(messageComponent, /variant="bubble"/)
    assert.doesNotMatch(messageComponent, /bg-pink-500\/10 text-pink-600/)
  })

  it("generated video result uses ChatVideoPlayer instead of a bare filename", () => {
    assert.match(messageComponent, /variant="generated"/)
    const start = messageComponent.indexOf("const VideoDisplay")
    const end = messageComponent.indexOf("const ThesisDisplay")
    const videoDisplay = messageComponent.slice(start, end)
    assert.match(videoDisplay, /ChatVideoPlayer/)
    assert.doesNotMatch(videoDisplay, /<video[\s\S]*controls/)
  })

  it("video frame carries an explicit width so it cannot collapse inside flex rows", () => {
    // Regression: on the user bubble the player sits in a `flex-wrap` row and
    // has no intrinsic content (absolutely positioned <video> in an
    // aspect-ratio box). With only `maxWidth` it rendered 2 px wide — the
    // uploaded video was in the DOM but invisible and impossible to play.
    const start = playerSource.indexOf("export function ChatVideoPlayer")
    const end = playerSource.indexOf("export function ChatAudioPlayer")
    const videoPlayer = playerSource.slice(start, end)
    assert.match(videoPlayer, /const frameWidth = variant === "composer" \? "min\(100%, 16\.5rem\)" : variant === "bubble" \? "min\(100%, 28rem\)" : "100%"/)
    assert.match(videoPlayer, /style=\{\{ width: frameWidth, maxWidth: frameWidth \}\}/)
    assert.doesNotMatch(videoPlayer, /style=\{\{ maxWidth \}\}/, "a ceiling alone lets the frame shrink to zero")
  })

  it("unified viewer previews audio and video with the shared players", () => {
    assert.match(viewerSource, /case "video":/)
    assert.match(viewerSource, /case "audio":/)
    assert.match(viewerSource, /<VideoRenderer/)
    assert.match(viewerSource, /<AudioRenderer/)
    assert.match(viewerSource, /<ChatVideoPlayer/)
    assert.match(viewerSource, /<ChatAudioPlayer/)
  })
})

describe("optimistic video/audio stay visible after temp-chat adopt", () => {
  it("snapshot keeps video poster/url and audio waveform", () => {
    const [video] = snapshotComposerFilesForMessage([videoFile])
    const [audio] = snapshotComposerFilesForMessage([audioFile])
    assert.equal(isVideoComposerFile(video), true)
    assert.equal(isAudioComposerFile(audio), true)
    assert.equal(video.mediaMeta?.thumbnailDataUrl, "data:image/jpeg;base64,aaa")
    assert.equal(audio.mediaMeta?.durationSeconds, 12.4)
  })

  it("mergeChatPreservingUserMessages keeps video+audio onto a real id", () => {
    const local = {
      id: "temp-chat-1700000000000",
      title: "preview",
      messages: [
        {
          id: "msg-user-1",
          role: "USER",
          content: "mira esto",
          files: snapshotComposerFilesForMessage([videoFile, audioFile]),
        },
      ],
    }
    const incoming = {
      id: "clx_real_chat",
      title: "Nuevo chat",
      messages: [],
    }
    const merged = mergeChatPreservingUserMessages(incoming as any, local as any)
    assert.equal(merged.id, "clx_real_chat")
    const files = ((merged.messages || [])[0] as { files?: unknown[] }).files || []
    assert.equal(files.length, 2)
    assert.equal(files.some(isVideoComposerFile), true)
    assert.equal(files.some(isAudioComposerFile), true)
  })
})
