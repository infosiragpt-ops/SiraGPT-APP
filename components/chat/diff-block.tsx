"use client";

import { useEffect, useState } from "react";
import { Check, Clipboard } from "lucide-react";

/**
 * DiffBlock — Cursor/Codex-style unified-diff renderer for chat code
 * blocks fenced as ```diff. Parses the unified diff with diff2html
 * (MIT) and renders side-by-side panels with file headers, +/− line
 * numbers and per-line coloring.
 *
 * Lazy-loads diff2html on first paint so the ~50 KB bundle splits out
 * of the main chunk. Pre-load fallback renders the raw diff text in a
 * monospaced block so the user always sees content.
 */

type Diff2Html = typeof import("diff2html");

let _diff2html: Promise<Diff2Html> | null = null;
function loadDiff2html(): Promise<Diff2Html> {
  if (!_diff2html) _diff2html = import("diff2html");
  return _diff2html;
}

export function DiffBlock({ diff }: { diff: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!diff) {
      setHtml(null);
      return;
    }
    loadDiff2html()
      .then((mod) =>
        mod.html(diff, {
          drawFileList: false,
          matching: "lines",
          outputFormat: "side-by-side",
          renderNothingWhenEmpty: false,
        }),
      )
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [diff]);

  const handleCopy = () => {
    navigator.clipboard.writeText(diff).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-md bg-gray-900/80 border border-gray-700 relative my-4 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800/50 border-b border-gray-700">
        <span className="text-xs font-sans text-gray-400">diff</span>
        <button
          onClick={handleCopy}
          className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1"
        >
          {isCopied ? <Check size={14} /> : <Clipboard size={14} />}
          {isCopied ? "Copied!" : "Copy diff"}
        </button>
      </div>
      {html ? (
        // diff2html escapes the source content; the rendered HTML is
        // structural markup with class names we restyle in
        // styles/diff-block.css. The wrapper class scopes those overrides.
        <div
          className="diff-block-wrapper text-[13px] overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="m-0 p-4 text-[14px] text-gray-100 whitespace-pre-wrap break-all font-mono">
          {diff}
        </pre>
      )}
    </div>
  );
}
