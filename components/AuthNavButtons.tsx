"use client"

import { useCallback, useRef, type MouseEvent, type PointerEvent, type TouchEvent } from "react"
import Link from "next/link"

const GoogleIcon = ({ size = 15 }: { size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 48 48"
    aria-hidden="true"
    className="shrink-0"
  >
    <path
      fill="#FFC107"
      d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
    />
    <path
      fill="#FF3D00"
      d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
    />
  </svg>
)

type InstantNavigationEvent =
  | MouseEvent<HTMLAnchorElement>
  | PointerEvent<HTMLAnchorElement>
  | TouchEvent<HTMLAnchorElement>

type InstantNavigationHandler = (href: string) => void

type LoginButtonProps = {
  href?: string
  /** @internal Test hook; production uses native browser navigation. */
  navigate?: InstantNavigationHandler
}

function navigateWithBrowser(href: string) {
  if (typeof window === "undefined") return
  window.location.assign(href)
}

function hasModifiedActivation(event: InstantNavigationEvent) {
  return Boolean(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
}

function isNonPrimaryPointer(event: PointerEvent<HTMLAnchorElement>) {
  if (typeof event.isPrimary === "boolean" && !event.isPrimary) return true
  if (typeof event.button === "number" && event.button !== 0) return true
  return false
}

function isNonPrimaryClick(event: MouseEvent<HTMLAnchorElement>) {
  if (typeof event.button === "number" && event.button !== 0) return true
  return false
}

export function LoginButton({ href = "/auth/login", navigate = navigateWithBrowser }: LoginButtonProps) {
  const navigationStartedRef = useRef(false)

  const startNavigation = useCallback(
    (event: InstantNavigationEvent) => {
      if (hasModifiedActivation(event)) return

      event.preventDefault()

      if (navigationStartedRef.current) return
      navigationStartedRef.current = true
      navigate(href)
    },
    [href, navigate],
  )

  const handlePointerDownCapture = useCallback(
    (event: PointerEvent<HTMLAnchorElement>) => {
      // Mobile Safari/Chrome can feel unresponsive when route loading waits
      // for the later synthetic click. Start on the first touch/pen signal.
      if (event.pointerType === "mouse" || isNonPrimaryPointer(event)) return
      startNavigation(event)
    },
    [startNavigation],
  )

  const handleTouchStartCapture = useCallback(
    (event: TouchEvent<HTMLAnchorElement>) => {
      // Fallback for older iOS WebViews that do not emit PointerEvent.
      startNavigation(event)
    },
    [startNavigation],
  )

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (isNonPrimaryClick(event)) return
      startNavigation(event)
    },
    [startNavigation],
  )

  return (
    <>
      <Link
        href={href}
        prefetch={true}
        onPointerDownCapture={handlePointerDownCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onClick={handleClick}
        data-instant-nav="login"
        className="group relative inline-flex touch-manipulation select-none items-center justify-center rounded-full p-[1px] overflow-hidden transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
      >
        {/* Refined rotating border beam — tri-tone indigo → violet → rose, slow */}
        <span
          aria-hidden
          className="absolute inset-[-120%] z-0"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg 285deg, rgba(79,70,229,0.85) 315deg, rgba(139,92,246,0.9) 335deg, rgba(236,72,153,0.7) 350deg, rgba(236,72,153,0) 360deg)",
            animation: "login-beam 5s linear infinite",
            filter: "blur(0.3px)",
          }}
        />
        {/* Base ring — refined, always present */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "linear-gradient(135deg, rgba(15,23,42,0.08), rgba(99,102,241,0.10), rgba(15,23,42,0.08))",
          }}
        />
        {/* Inner surface */}
        <span className="relative z-10 inline-flex items-center gap-2 rounded-full bg-white dark:bg-zinc-950 px-6 py-[9px] text-[13.5px] font-medium tracking-tight text-slate-900 dark:text-zinc-100">
          {/* Subtle top sheen */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-3 top-0 h-px opacity-60 dark:opacity-40"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(15,23,42,0.25), transparent)",
            }}
          />
          <GoogleIcon size={15} />
          <span>Login</span>
        </span>
      </Link>

      <style>{`
        @keyframes login-beam {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </>
  )
}

export function SignUpButton({ href = "/auth/register" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="group relative inline-flex items-center justify-center overflow-hidden rounded-full px-6 py-[9px] text-[13.5px] font-medium tracking-tight text-white transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
      style={{
        background:
          "linear-gradient(180deg, #4f46e5 0%, #4338ca 100%)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.18) inset, 0 0 0 1px rgba(67,56,202,0.9), 0 1px 2px rgba(15,23,42,0.12), 0 6px 16px -6px rgba(79,70,229,0.55)",
      }}
    >
      {/* Top specular highlight */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
        }}
      />
      {/* Inner bottom shadow for depth */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          boxShadow: "inset 0 -6px 12px rgba(15,23,42,0.18)",
        }}
      />
      {/* Hover shimmer */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 ease-in-out"
        style={{
          background:
            "linear-gradient(110deg, transparent 42%, rgba(255,255,255,0.22) 50%, transparent 58%)",
        }}
      />
      <span className="relative z-10">Sign Up</span>
    </Link>
  )
}
