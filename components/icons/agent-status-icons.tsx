import * as React from "react"
import { ThinkingBarsIcon } from "@/components/icons/thinking-bars-icon"

export type AgentStatusIconKind =
  | "thinking"
  | "working"
  | "coding"
  | "verifying"
  | "repairing"
  | "done"
  | "queued"
  | "error"

type IconProps = React.SVGProps<SVGSVGElement>

function WorkingIcon({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="12" cy="12" r="7.25" stroke="currentColor" strokeWidth="1.8" opacity="0.22" />
      <path
        d="M12 4.75a7.25 7.25 0 0 1 7.25 7.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1.1s"
          repeatCount="indefinite"
        />
      </path>
      <circle cx="12" cy="12" r="2.25" fill="currentColor" opacity="0.72">
        <animate attributeName="r" values="2.1;2.8;2.1" dur="0.9s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.55;0.9;0.55" dur="0.9s" repeatCount="indefinite" />
      </circle>
    </svg>
  )
}

function CodingIcon({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M9 7 4.75 12 9 17"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <animateTransform
          attributeName="transform"
          type="translate"
          values="0 0;-1 0;0 0"
          dur="0.75s"
          repeatCount="indefinite"
        />
      </path>
      <path
        d="M15 7 19.25 12 15 17"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <animateTransform
          attributeName="transform"
          type="translate"
          values="0 0;1 0;0 0"
          dur="0.75s"
          repeatCount="indefinite"
        />
      </path>
      <path d="M13.25 5.5 10.75 18.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.65" />
      <rect x="12.8" y="16.2" width="1.6" height="2.3" rx="0.6" fill="currentColor">
        <animate attributeName="opacity" values="0.2;1;0.2" dur="0.8s" repeatCount="indefinite" />
      </rect>
    </svg>
  )
}

function VerifyingIcon({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M12 3.8 18.2 6v5.3c0 3.8-2.45 7.1-6.2 8.9-3.75-1.8-6.2-5.1-6.2-8.9V6L12 3.8Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <path
        d="m8.7 12.1 2.1 2.1 4.8-5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="9"
        strokeDashoffset="9"
      >
        <animate attributeName="stroke-dashoffset" values="9;0;0" dur="1.1s" repeatCount="indefinite" />
      </path>
    </svg>
  )
}

function RepairingIcon({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <g>
        <animateTransform
          attributeName="transform"
          type="rotate"
          values="-8 12 12;8 12 12;-8 12 12"
          dur="0.9s"
          repeatCount="indefinite"
        />
        <path
          d="M14.8 5.3a3.4 3.4 0 0 0 3.9 4.6l-7.8 7.8a2.25 2.25 0 0 1-3.2-3.2l7.8-7.8a3.3 3.3 0 0 1-.7-1.4Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

function DoneIcon({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.7" opacity="0.35" />
      <path
        d="m8 12.3 2.65 2.65L16.4 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function QueuedIcon({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.7" opacity="0.55" />
      <path d="M12 7.7v4.6l3 1.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ErrorIcon({ className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" opacity="0.55" />
      <path d="m9 9 6 6M15 9l-6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

export function AgentStatusIcon({
  kind,
  className,
}: {
  kind: AgentStatusIconKind
  className?: string
}) {
  if (kind === "thinking") return <ThinkingBarsIcon className={className} />
  if (kind === "coding") return <CodingIcon className={className} />
  if (kind === "verifying") return <VerifyingIcon className={className} />
  if (kind === "repairing") return <RepairingIcon className={className} />
  if (kind === "done") return <DoneIcon className={className} />
  if (kind === "queued") return <QueuedIcon className={className} />
  if (kind === "error") return <ErrorIcon className={className} />
  return <WorkingIcon className={className} />
}

export default AgentStatusIcon
