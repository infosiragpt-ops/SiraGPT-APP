/**
 * InteractiveArtifact — sandboxed HTML renderer for artifact blocks.
 *
 * The backend's artifact-generator produces a self-contained HTML
 * document (inline CSS + JS + SVG). Rendering it directly in the page
 * is a security risk — generated JS would run with page-level scope.
 * We mount it inside an <iframe sandbox="allow-scripts"> so:
 *   - The generated JS can't touch window.parent.
 *   - No same-origin access back to siraGPT.
 *   - No network requests (sanitiser also strips external resources).
 *   - No top-navigation.
 *
 * The iframe uses `srcdoc` so we don't need a separate URL. Height is
 * fixed at render and can be expanded via a full-screen toggle.
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';

interface InteractiveArtifactProps {
  html: string;
  title?: string;
  description?: string;
  initialHeight?: number;
}

export function InteractiveArtifact({
  html,
  title,
  description,
  initialHeight = 540,
}: InteractiveArtifactProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Re-render when the HTML changes (e.g. the user edits the prompt and
  // a new artifact arrives for the same message slot).
  useEffect(() => {
    if (iframeRef.current) {
      // srcdoc is an attribute, not a property — writing it triggers a
      // full iframe reload, which is exactly what we want.
      iframeRef.current.srcdoc = html;
    }
  }, [html]);

  if (!html) return null;

  return (
    <div
      className={
        expanded
          ? 'fixed inset-4 z-50 overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl'
          : 'my-3 overflow-hidden rounded-xl border border-border/60 bg-background'
      }
    >
      {(title || description) && (
        <div className="flex items-start justify-between gap-3 border-b border-border/40 bg-muted/30 px-4 py-2">
          <div className="min-w-0 flex-1">
            {title && (
              <div className="truncate text-sm font-semibold text-foreground">{title}</div>
            )}
            {description && (
              <div className="line-clamp-2 text-xs text-muted-foreground">{description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="shrink-0 rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-medium text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors"
            aria-label={expanded ? 'Cerrar' : 'Expandir'}
          >
            {expanded ? 'Cerrar' : 'Expandir'}
          </button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-scripts"
        className="block w-full bg-background"
        style={{
          height: expanded ? 'calc(100vh - 12rem)' : `${initialHeight}px`,
          border: 0,
        }}
        title={title || 'Interactive visualization'}
      />
    </div>
  );
}

/**
 * Parse an assistant message body for artifact blocks and return a
 * structured result. Supports two marker styles so we don't bind to
 * a single convention:
 *
 *   1. <artifact type="html" title="..." description="...">...</artifact>
 *   2. A ```html fenced code block whose first line is a DOCTYPE.
 *
 * Returns `{ before, artifact, after }` when a block is found, or null
 * when no artifact is present. Callers render `before` text, then the
 * artifact viewer, then `after` text.
 */
export function extractArtifact(content: string): {
  before: string;
  artifact: { title: string; description: string; html: string };
  after: string;
} | null {
  if (typeof content !== 'string' || content.length === 0) return null;

  // Shape 1: explicit <artifact> tag.
  const tagMatch = content.match(
    /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/i
  );
  if (tagMatch) {
    const attrs = tagMatch[1];
    const inner = tagMatch[2].trim();
    const titleMatch = attrs.match(/title=['"]([^'"]+)['"]/i);
    const descMatch = attrs.match(/description=['"]([^'"]+)['"]/i);
    return {
      before: content.slice(0, tagMatch.index).trim(),
      artifact: {
        title: titleMatch?.[1] || '',
        description: descMatch?.[1] || '',
        html: inner,
      },
      after: content.slice((tagMatch.index ?? 0) + tagMatch[0].length).trim(),
    };
  }

  // Shape 2: ```html fenced block that starts with a DOCTYPE.
  // We only treat fenced blocks starting with <!DOCTYPE as artifacts to
  // avoid hijacking normal code-example blocks.
  const fenceMatch = content.match(
    /```html\s*\n([\s\S]*?<!DOCTYPE html>[\s\S]*?)\n```/i
  );
  if (fenceMatch) {
    return {
      before: content.slice(0, fenceMatch.index).trim(),
      artifact: {
        title: '',
        description: '',
        html: fenceMatch[1].trim(),
      },
      after: content.slice((fenceMatch.index ?? 0) + fenceMatch[0].length).trim(),
    };
  }

  return null;
}
