"use client"

import * as React from "react"
import { Pause, Play } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  AUDIO_PLAYER_FRAME_CLASS,
  MEDIA_PLAY_BUTTON_CLASS,
  MEDIA_SEEK_TRACK_CLASS,
  VIDEO_PLAYER_FRAME_CLASS,
  formatMediaClock,
  mediaPreviewAspectCss,
  normalizeMediaPreviewAspect,
  normalizeWaveformPeaks,
  type MediaPreviewVariant,
} from "@/lib/chat/media-preview-players"

type MediaSourceFile = File | Blob | null | undefined

type SharedPlayerProps = {
  src?: string | null
  file?: MediaSourceFile
  title?: string
  durationSeconds?: number | null
  variant?: MediaPreviewVariant
  className?: string
}

function playableSrc(raw: string): string {
  const value = String(raw || "").trim()
  if (!value) return ""
  if (/^(data:|blob:)/i.test(value)) return value
  try {
    const parsed = /^(https?:|\/\/)/i.test(value)
      ? new URL(value, "https://siragpt.com")
      : new URL(value, "https://siragpt.com")
    if (parsed.pathname.startsWith("/uploads/")) {
      return `${parsed.pathname}${parsed.search || ""}`
    }
  } catch {
    /* keep raw */
  }
  return value
}

function useObjectUrl(src?: string | null, file?: MediaSourceFile): string {
  const [objectUrl, setObjectUrl] = React.useState("")
  React.useEffect(() => {
    const direct = playableSrc(src || "")
    if (direct) {
      setObjectUrl(direct)
      return
    }
    if (!file || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      setObjectUrl("")
      return
    }
    const created = URL.createObjectURL(file)
    setObjectUrl(created)
    return () => {
      try { URL.revokeObjectURL(created) } catch { /* ignore */ }
    }
  }, [src, file])
  return objectUrl
}

function seekFromClientX(media: HTMLMediaElement | null, el: HTMLElement | null, clientX: number) {
  if (!media || !el) return
  const total = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0
  if (!total) return
  const rect = el.getBoundingClientRect()
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)))
  media.currentTime = fraction * total
}

export function ChatVideoPlayer({
  src,
  file,
  poster,
  title = "video",
  durationSeconds,
  aspect,
  variant = "bubble",
  className,
}: SharedPlayerProps & { poster?: string | null; aspect?: string | null }) {
  const mediaSrc = useObjectUrl(src, file)
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const seekRef = React.useRef<HTMLDivElement | null>(null)
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [duration, setDuration] = React.useState(Number(durationSeconds) > 0 ? Number(durationSeconds) : 0)
  const [isSeeking, setIsSeeking] = React.useState(false)
  const [capturedPoster, setCapturedPoster] = React.useState("")
  const aspectCss = mediaPreviewAspectCss(aspect)
  const posterSrc = playableSrc(poster || "") || capturedPoster
  const compact = variant === "composer"
  // The frame has no intrinsic content (the <video> is absolutely positioned
  // inside an aspect-ratio box), so as a flex item it would shrink to 0 px —
  // that is exactly what happened on the user bubble, where the player sits in
  // a `flex-wrap` row: the video existed in the DOM at 2 px wide. Give it an
  // explicit width, not just a ceiling.
  const frameWidth = variant === "composer" ? "min(100%, 16.5rem)" : variant === "bubble" ? "min(100%, 28rem)" : "100%"

  const toggle = React.useCallback((event?: React.SyntheticEvent) => {
    event?.stopPropagation()
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }, [])

  return (
    <div
      data-testid="chat-video-player"
      data-variant={variant}
      data-aspect={normalizeMediaPreviewAspect(aspect)}
      className={cn(VIDEO_PLAYER_FRAME_CLASS, className)}
      style={{ width: frameWidth, maxWidth: frameWidth }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="relative w-full bg-black" style={{ aspectRatio: aspectCss }}>
        <video
          ref={videoRef}
          src={mediaSrc || undefined}
          poster={posterSrc || undefined}
          preload="metadata"
          playsInline
          className="absolute inset-0 h-full w-full object-contain"
          aria-label={title}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => { setIsPlaying(false); setCurrentTime(0) }}
          onLoadedMetadata={(event) => {
            const el = event.currentTarget
            if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration)
          }}
          onTimeUpdate={(event) => {
            if (!isSeeking) setCurrentTime(event.currentTarget.currentTime)
          }}
          onLoadedData={(event) => {
            if (posterSrc) return
            try {
              const el = event.currentTarget
              const canvas = document.createElement("canvas")
              const w = el.videoWidth || 640
              const h = el.videoHeight || 360
              canvas.width = Math.min(640, w)
              canvas.height = Math.round(canvas.width * (h / Math.max(1, w)))
              const ctx = canvas.getContext("2d")
              if (!ctx) return
              ctx.drawImage(el, 0, 0, canvas.width, canvas.height)
              setCapturedPoster(canvas.toDataURL("image/jpeg", 0.7))
            } catch {
              /* tainted canvas / codec */
            }
          }}
        />
        {!isPlaying && (
          <button
            type="button"
            data-testid="chat-video-play"
            aria-label={`Reproducir ${title}`}
            onClick={toggle}
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/25"
          >
            <span className={cn(MEDIA_PLAY_BUTTON_CLASS, compact ? "h-11 w-11" : "h-14 w-14")}>
              <Play className={cn(compact ? "ml-0.5 h-5 w-5" : "ml-0.5 h-7 w-7", "fill-current")} />
            </span>
          </button>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-3 pb-2.5 pt-10">
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              data-testid="chat-video-toggle"
              aria-label={isPlaying ? `Pausar ${title}` : `Reproducir ${title}`}
              onClick={toggle}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            >
              {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
            </button>
            <div
              ref={seekRef}
              role="slider"
              data-testid="chat-video-seek"
              aria-label={`Buscar en ${title}`}
              aria-valuemin={0}
              aria-valuemax={Math.round(duration) || 0}
              aria-valuenow={Math.round(currentTime)}
              tabIndex={0}
              className="group flex h-4 flex-1 cursor-pointer touch-none items-center"
              onPointerDown={(event) => {
                event.stopPropagation()
                try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
                setIsSeeking(true)
                seekFromClientX(videoRef.current, event.currentTarget, event.clientX)
              }}
              onPointerMove={(event) => {
                if (isSeeking) seekFromClientX(videoRef.current, event.currentTarget, event.clientX)
              }}
              onPointerUp={() => setIsSeeking(false)}
            >
              <div className={cn(MEDIA_SEEK_TRACK_CLASS, "bg-white/25")}>
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-white"
                  style={{ width: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%` }}
                />
              </div>
            </div>
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-white/90">
              {formatMediaClock(currentTime)} / {formatMediaClock(duration)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ChatAudioPlayer({
  src,
  file,
  title = "audio",
  durationSeconds,
  peaks,
  variant = "bubble",
  className,
}: SharedPlayerProps & { peaks?: number[] | null }) {
  const mediaSrc = useObjectUrl(src, file)
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const seekRef = React.useRef<HTMLDivElement | null>(null)
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [duration, setDuration] = React.useState(Number(durationSeconds) > 0 ? Number(durationSeconds) : 0)
  const [isSeeking, setIsSeeking] = React.useState(false)
  const bars = React.useMemo(() => normalizeWaveformPeaks(peaks, variant === "composer" ? 36 : 48), [peaks, variant])
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0
  const compact = variant === "composer"

  const toggle = React.useCallback((event?: React.SyntheticEvent) => {
    event?.stopPropagation()
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play().catch(() => {})
    else audio.pause()
  }, [])

  return (
    <div
      data-testid="chat-audio-player"
      data-variant={variant}
      className={cn(AUDIO_PLAYER_FRAME_CLASS, compact ? "min-w-[14.5rem] max-w-[22rem]" : "max-w-[26rem]", className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        data-testid="chat-audio-play"
        aria-label={isPlaying ? `Pausar ${title}` : `Reproducir ${title}`}
        onClick={toggle}
        className={cn(MEDIA_PLAY_BUTTON_CLASS, compact ? "h-9 w-9" : "h-11 w-11")}
      >
        {isPlaying ? (
          <Pause className={cn(compact ? "h-4 w-4" : "h-5 w-5", "fill-current")} />
        ) : (
          <Play className={cn(compact ? "ml-0.5 h-4 w-4" : "ml-0.5 h-5 w-5", "fill-current")} />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-[13px] font-medium leading-tight">{title}</span>
        <div
          ref={seekRef}
          role="slider"
          data-testid="chat-audio-seek"
          aria-label={`Buscar en ${title}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration) || 0}
          aria-valuenow={Math.round(currentTime)}
          tabIndex={0}
          className="group/wave flex h-8 cursor-pointer touch-none items-center justify-between"
          onPointerDown={(event) => {
            event.stopPropagation()
            try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* ignore */ }
            setIsSeeking(true)
            seekFromClientX(audioRef.current, event.currentTarget, event.clientX)
          }}
          onPointerMove={(event) => {
            if (isSeeking) seekFromClientX(audioRef.current, event.currentTarget, event.clientX)
          }}
          onPointerUp={() => setIsSeeking(false)}
        >
          {bars.map((height, index) => {
            const played = (index + 0.5) / bars.length <= progress
            return (
              <span
                key={`${index}-${height.toFixed(3)}`}
                aria-hidden
                className={cn(
                  "w-[2.5px] shrink-0 rounded-full",
                  played ? "bg-zinc-950 dark:bg-white" : "bg-zinc-900/20 dark:bg-white/20",
                )}
                style={{ height: `${Math.max(4, Math.round(height * 28))}px` }}
              />
            )
          })}
        </div>
        <div className="flex items-center justify-between text-[11px] font-medium tabular-nums text-muted-foreground">
          <span>{formatMediaClock(currentTime)}</span>
          <span>{formatMediaClock(duration)}</span>
        </div>
      </div>
      <audio
        ref={audioRef}
        src={mediaSrc || undefined}
        preload="metadata"
        className="hidden"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => { setIsPlaying(false); setCurrentTime(0) }}
        onLoadedMetadata={(event) => {
          const d = event.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setDuration(d)
        }}
        onTimeUpdate={(event) => {
          if (!isSeeking) setCurrentTime(event.currentTarget.currentTime)
        }}
      />
    </div>
  )
}
