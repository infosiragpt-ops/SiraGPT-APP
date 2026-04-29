"use client"

import * as React from "react"
import { useState, useEffect, useMemo, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn, downloadHref, downloadUrlAsFile } from "@/lib/utils"
import UnifiedDocumentViewer, { type AttachmentLike } from "@/components/viewers/UnifiedDocumentViewer"
import { InteractiveArtifact, extractArtifact } from "@/components/artifact/InteractiveArtifact"
import { AgenticStepsRenderer } from "@/components/agentic-steps"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import GmailConnectionCard from "./GmailConnectionCard"
import GoogleServicesConnectionCard from "./GoogleServicesConnectionCard"
import {
    Copy, Clipboard, Pencil, FileText, Check, Volume2, VolumeX,
    ThumbsUp, ThumbsDown, Share2, Play, Pause, Download,
    Video, AlertCircle, CheckCircle, RefreshCw, Wand2, Video as VideoIcon,
    Sparkles, Eye, Presentation as PresentationIcon,
    ExternalLink, Mail, X, Brush, Maximize2
} from "lucide-react"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogClose,
    DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { apiClient } from "@/lib/api"
import { useVoiceControls } from './voice-controls';
import ReactMarkdown from 'react-markdown'
import { PerformanceOptimizer } from "@/lib/performance-optimizer"
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'
import { DownloadButtons } from './download-buttons';
import TableControls from './TableControls';
import ImageGenerationEffect from './ImageGenerationEffect';
// import CodePreview from './code-preview';
import { parseCodeFromContent, hasWebDevelopmentCode, combineWebCode, detectCodeType } from '@/lib/code-detection';
import ChartComponent from './chart-component';
import { FigmaDiagramDisplay } from './figma-diagram-component';
import { PlanArtifactDisplay } from './plan/plan-artifact-display';
import { VizArtifactDisplay } from './viz/viz-artifact-display';
import { DocArtifactDisplay } from './doc/doc-artifact-display';
import { InteractiveArtifactDisplay } from './artifact/interactive-artifact-display';
import { PresentationView } from './presentation-view';
import { CustomCodeBlock } from "./ui/custom-code-block"
import { ArtifactCard, isExecutableArtifact } from "./chat/ArtifactCard"
import ProcessingGmailCard from "./ProcessingGmailCard"
import ExtractedDataDownload from "./ExtractedDataDownload"
import ThesisProgressComponent from "./ThesisProgressComponent"
import ThesisProgressDisplay from "./ThesisProgressDisplay"
import ProcessingGoogleServicesCard from "./ProcessingGoogleServicesCard"
import SpotifyConnectionCard from "./SpotifyConnectionCard"
import SpotifyResults from "./spotify-results"
import { ThinkingPlaceholder } from "./thinking-placeholder"
import MessageActionRail from "./MessageActionRail"
import ComputerUseReasoning from "./ComputerUseReasoning"
import type { DocumentPreviewTarget } from "./document-preview"
import { resolveImageAttachmentUrl } from "@/lib/attachment-url"
import { isImageOnlyMessageForRender } from "@/lib/message-render-policy"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import {
    copyMarkdownToWordClipboard,
    createWordClipboardPayloadFromSelection,
    setClipboardDataForWord,
    stripNonCopyableArtifactBlocks,
} from "@/lib/rich-clipboard"

// Adjusted truncateUrl function to ensure links are not overly shortened
const truncateUrl = (url: string, maxLength: number = 30) => {
    if (url.length <= maxLength) return url;
    const domain = url.split('/')[2]; // Extract domain
    const path = url.split('/').slice(3).join('/'); // Extract path
    const truncatedPath = path.length > 25 ? `${path.slice(0, 25)}...` : path;
    return `${domain}/${truncatedPath}`;
};

const NON_IMAGE_EXTENSIONS = new Set([
    'doc', 'docx', 'pdf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'md', 'rtf',
]);

const IMAGE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif',
]);

const getAttachmentName = (file: any) =>
    String(file?.originalName || file?.name || file?.filename || '').trim();

const getAttachmentExtension = (file: any) => {
    const name = getAttachmentName(file).toLowerCase();
    return name.includes('.') ? name.split('.').pop() || '' : '';
};

const getAttachmentMime = (file: any) =>
    String(file?.mimeType || file?.contentType || '').toLowerCase();

const isRenderableImageAttachment = (file: any) => {
    const mimeType = getAttachmentMime(file);
    const extension = getAttachmentExtension(file);

    if (NON_IMAGE_EXTENSIONS.has(extension)) return false;
    if (mimeType.startsWith('image/')) return true;
    if (IMAGE_EXTENSIONS.has(extension)) return true;

    // Generated assistant images often use type="image" without a MIME.
    return file?.type === 'image' && !!(file?.url || file?.base64 || file?.path || file?.imageUrl);
};

const isDocumentLikeAttachment = (file: any) => {
    if (!file) return false;
    if (isRenderableImageAttachment(file)) return false;
    if (['gmail_emails', 'gmail_search_results', 'chart'].includes(file?.type)) return false;
    return !!(getAttachmentName(file) || file?.id || file?.attachmentId);
};

const formatAgentTaskUserContent = (content: string) => {
    return String(content || "").replace(/^🤖\s*Tarea:\s*/i, "").trim();
};

const getDocumentChipIcon = (name: string) => {
    const extension = name.split('.').pop()?.toLowerCase();
    if (extension === 'doc' || extension === 'docx') {
        return <img src="/icons/Word.png" alt="" aria-hidden="true" className="h-8 w-8 shrink-0" />;
    }
    if (extension === 'xls' || extension === 'xlsx' || extension === 'csv') {
        return <img src="/icons/Excel.png" alt="" aria-hidden="true" className="h-8 w-8 shrink-0" />;
    }
    if (extension === 'ppt' || extension === 'pptx') {
        return <img src="/icons/Bigger P powerpoint.png" alt="" aria-hidden="true" className="h-8 w-8 shrink-0" />;
    }
    if (extension === 'pdf') {
        return <img src="/icons/pdf.png" alt="" aria-hidden="true" className="h-8 w-8 shrink-0" />;
    }
    return (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <FileText className="h-4 w-4" />
        </span>
    );
};

function escapePreviewHtml(value: unknown) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function cleanPresentationFilename(value: unknown) {
    const raw = String(value || "").trim();
    if (!raw) return "presentation.pptx";
    try {
        const parsed = new URL(raw);
        return decodeURIComponent(parsed.pathname.split("/").pop() || "presentation.pptx");
    } catch {
        return decodeURIComponent(raw.split(/[\\/]/).pop() || "presentation.pptx");
    }
}

function backendUrl(pathOrUrl: string) {
    if (/^(https?:|data:|blob:)/i.test(pathOrUrl)) return pathOrUrl;
    const baseUrl = process.env.NEXT_PUBLIC_IMAGE_URL || "http://localhost:5000";
    return `${baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function escapeHtml(value: unknown) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function textLines(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.flatMap(textLines).filter(Boolean);
    }
    if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        return textLines(obj.text || obj.body || obj.content || obj.title || JSON.stringify(obj));
    }
    return String(value ?? "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function buildPresentationPreviewHtml(entry: any, filename: string) {
    const slides = Array.isArray(entry?.structure?.slides) ? entry.structure.slides : [];
    const title = entry?.title || entry?.structure?.title || "Presentación";
    const category = entry?.category || "business";
    const palette = entry?.colorScheme || entry?.style || "professional";
    const safeTitle = escapePreviewHtml(title);
    const safeFilename = escapePreviewHtml(filename);
    const slideHtml = slides.map((slide: any, index: number) => {
        const slideTitle = escapePreviewHtml(slide?.title || `Slide ${index + 1}`);
        const lines = textLines(slide?.content || slide?.bullets || slide?.body);
        const bullets = lines.length
            ? `<ul>${lines.slice(0, 8).map((line) => `<li>${escapePreviewHtml(line)}</li>`).join("")}</ul>`
            : `<p class="muted">Sin contenido textual. Descarga el PPTX para ver todos los elementos vectoriales.</p>`;
        return `
          <section class="slide-card">
            <div class="slide-number">${String(index + 1).padStart(2, "0")}</div>
            <div>
              <h2>${slideTitle}</h2>
              ${bullets}
            </div>
          </section>`;
    }).join("");

    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light; --ink:#0f172a; --muted:#64748b; --line:rgba(15,23,42,.10); --accent:#2563eb; --cyan:#06b6d4; --pink:#ec4899; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:
      radial-gradient(circle at 18% 8%, rgba(37,99,235,.18), transparent 32%),
      radial-gradient(circle at 88% 20%, rgba(236,72,153,.14), transparent 28%),
      linear-gradient(135deg, #f8fbff 0%, #eef4ff 45%, #ffffff 100%); }
    .wrap { max-width:1180px; margin:0 auto; padding:34px 26px 48px; }
    .hero { position:relative; overflow:hidden; border:1px solid rgba(255,255,255,.7); border-radius:28px; padding:30px; background:rgba(255,255,255,.72); box-shadow:0 30px 90px rgba(15,23,42,.12); backdrop-filter: blur(24px); }
    .hero:after { content:""; position:absolute; inset:-60% -10% auto; height:180px; background:linear-gradient(90deg, transparent, rgba(255,255,255,.85), transparent); transform:rotate(-8deg); animation:sheen 4.8s ease-in-out infinite; }
    @keyframes sheen { 0%, 45% { translate:-70% 0; opacity:0; } 55% { opacity:.9; } 100% { translate:70% 0; opacity:0; } }
    .kicker { display:inline-flex; align-items:center; gap:8px; margin-bottom:16px; border:1px solid rgba(37,99,235,.18); border-radius:999px; padding:7px 12px; color:#1d4ed8; background:rgba(219,234,254,.72); font-size:12px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    h1 { max-width:920px; margin:0; font-size:clamp(32px,5vw,64px); line-height:.98; letter-spacing:-.055em; }
    .meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:22px; color:var(--muted); font-size:13px; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:8px 12px; background:rgba(255,255,255,.75); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:18px; margin-top:24px; }
    .slide-card { position:relative; min-height:250px; display:flex; flex-direction:column; justify-content:space-between; gap:22px; overflow:hidden; border:1px solid rgba(15,23,42,.08); border-radius:26px; padding:24px; background:linear-gradient(145deg,rgba(255,255,255,.86),rgba(248,250,252,.68)); box-shadow:0 24px 70px rgba(15,23,42,.10); }
    .slide-card:before { content:""; position:absolute; width:180px; height:180px; right:-70px; top:-70px; border-radius:999px; background:radial-gradient(circle, rgba(6,182,212,.25), transparent 70%); }
    .slide-number { width:max-content; border-radius:14px; padding:8px 10px; background:#0f172a; color:white; font-weight:900; letter-spacing:.08em; font-size:12px; }
    h2 { margin:0 0 14px; font-size:24px; line-height:1.05; letter-spacing:-.035em; }
    ul { margin:0; padding-left:18px; color:#334155; line-height:1.55; }
    li { margin:7px 0; }
    .muted { color:var(--muted); line-height:1.55; }
    @media (max-width: 720px) { .wrap { padding:18px 12px 32px; } .hero { padding:22px; border-radius:22px; } .slide-card { min-height:auto; } }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div class="kicker">siraGPT deck preview</div>
      <h1>${safeTitle}</h1>
      <div class="meta">
        <span class="pill">${slides.length} slides</span>
        <span class="pill">Archivo: ${safeFilename}</span>
        <span class="pill">Estilo: ${escapePreviewHtml(palette)}</span>
        <span class="pill">Categoría: ${escapePreviewHtml(category)}</span>
      </div>
    </section>
    <section class="grid">${slideHtml || `<section class="slide-card"><h2>No hay slides para mostrar</h2><p class="muted">Descarga el archivo para abrirlo en PowerPoint.</p></section>`}</section>
  </main>
</body>
</html>`;
}

// Chart Display Component
const ChartDisplay = ({ files, fullResponse, onImageClick }: { files: any[], fullResponse?: any[], onImageClick?: (imageUrl: string) => void }) => {
    const chartFile = files.find(f => f.type === 'chart');
    if (!chartFile) return null;

    const { imageUrl, pythonCode } = chartFile;

    const handleDownloadChart = async () => {
        if (!imageUrl) return;
        try {
            const response = await fetch(imageUrl);
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'chart.png';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            toast.success('Chart downloaded successfully!');
        } catch (error) {
            console.error('Error downloading chart:', error);
            toast.error('Failed to download chart.');
        }
    };

    // If there's an image, show only the chart with hover download/edit controls
    if (imageUrl) {
        return (
            <div className="mt-3 relative inline-block w-full group">
                <img
                    src={imageUrl}
                    alt="Generated chart"
                    className="max-w-full h-auto rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                    onClick={() => onImageClick?.(imageUrl)}
                />

                {/* Hover controls */}
                <div className="absolute top-3 right-3 z-20 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-x-2 group-hover:translate-x-0 pointer-events-none">
                    <Button
                        variant="secondary"
                        size="icon"
                        onClick={(e) => {
                            e.stopPropagation();
                            handleDownloadChart();
                        }}
                        className="h-9 w-9 rounded-full bg-white/90 hover:bg-white text-gray-800 shadow-lg hover:scale-105 transition-transform pointer-events-auto"
                        title="Download Chart"
                    >
                        <Download className="h-4 w-4" />
                    </Button>
                </div>

                {pythonCode && (
                    <details className="mt-2">
                        <summary className="text-xs text-muted-foreground cursor-pointer">View Python Code</summary>
                        <pre className="text-xs bg-gray-800 text-white p-2 rounded-md mt-1 overflow-x-auto">
                            <code>{pythonCode}</code>
                        </pre>
                    </details>
                )}
            </div>
        );
    }

    // If no image, but there is a fullResponse, show the message from it.
    const responseText = fullResponse?.[0]?.content?.[0]?.text;
    if (responseText) {
        return (
            <div className="mt-3 p-3 rounded-lg border border-border/20 bg-muted/20">
                <div className="prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed">
                    <p>{responseText}</p>
                </div>
            </div>
        );
    }

    // Fallback if there's no image and no valid fullResponse.
    return null;
};


// Enhanced Message Component with Video Support
/**
 * Document chips under a user message. Click opens UnifiedDocumentViewer
 * — the SAME viewer the composer uses. Skips images (they render inline
 * via FileDisplay) and Gmail-payload entries.
 */
const MessageDocChips = ({ parsedFiles }: { parsedFiles: any[] }) => {
    const [idx, setIdx] = React.useState<number | null>(null);
    const chips = React.useMemo(() => {
        if (!Array.isArray(parsedFiles)) return [];
        return parsedFiles.filter(isDocumentLikeAttachment);
    }, [parsedFiles]);

    const attachments: AttachmentLike[] = React.useMemo(() => chips.map(f => ({
        id: f.id || f.attachmentId,
        name: String(f.longPasteTitle || f.longPasteMeta?.title || f.longPasteMetadata?.title || f.originalName || f.name || 'archivo'),
        mimeType: f.mimeType || f.type || null,
        size: f.size ?? null,
        url: f.url || null,
        file: f.file instanceof File ? f.file : null,
        extractedText: f.extractedText || null,
    })), [chips]);

    if (chips.length === 0) return null;

    return (
        <div className="mb-2 flex flex-wrap justify-end gap-2">
            {attachments.map((att, i) => (
                <button
                    key={att.id || i}
                    type="button"
                    onClick={() => setIdx(i)}
                    className="group/chip inline-flex max-w-[320px] items-center gap-2 rounded-xl border border-gray-200 bg-background px-2 py-1 text-left text-sm shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-foreground/40 hover:shadow-sm dark:border-border/60"
                    aria-label={`Abrir ${att.name}`}
                >
                    {getDocumentChipIcon(att.name)}
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[13px] font-medium leading-tight">{att.name}</span>
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                            {(att.name.split('.').pop() || 'file').slice(0, 4)}
                        </span>
                    </span>
                </button>
            ))}
            <UnifiedDocumentViewer
                open={idx !== null}
                onClose={() => setIdx(null)}
                attachment={idx !== null ? attachments[idx] : null}
                siblings={attachments}
                onNavigate={(next) => {
                    const j = attachments.findIndex(s => s === next);
                    if (j >= 0) setIdx(j);
                }}
            />
        </div>
    );
};

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const GeneratedImageCard = ({
    file,
    src,
    index,
    onOpen,
    onLoad,
    onError,
}: {
    file: any;
    src: string;
    index: number;
    onOpen: (src: string) => void;
    onLoad?: () => void;
    onError?: () => void;
}) => {
    const frameRef = React.useRef<HTMLDivElement | null>(null);
    const [editMode, setEditMode] = React.useState(false);
    const [dragStart, setDragStart] = React.useState<{ x: number; y: number } | null>(null);
    const [selection, setSelection] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);

    const pointFromEvent = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const rect = frameRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return null;
        return {
            x: clampPercent(((event.clientX - rect.left) / rect.width) * 100),
            y: clampPercent(((event.clientY - rect.top) / rect.height) * 100),
        };
    }, []);

    const updateSelection = React.useCallback((start: { x: number; y: number }, current: { x: number; y: number }) => {
        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const width = Math.abs(current.x - start.x);
        const height = Math.abs(current.y - start.y);
        setSelection({ x, y, width, height });
    }, []);

    const beginSelection = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!editMode) return;
        event.preventDefault();
        event.stopPropagation();
        const point = pointFromEvent(event);
        if (!point) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragStart(point);
        setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
    };

    const moveSelection = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!editMode || !dragStart) return;
        const point = pointFromEvent(event);
        if (!point) return;
        updateSelection(dragStart, point);
    };

    const finishSelection = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!editMode || !dragStart) return;
        const point = pointFromEvent(event);
        setDragStart(null);
        if (point) updateSelection(dragStart, point);

        const region = point
            ? {
                x: Math.min(dragStart.x, point.x),
                y: Math.min(dragStart.y, point.y),
                width: Math.abs(point.x - dragStart.x),
                height: Math.abs(point.y - dragStart.y),
            }
            : selection;

        if (!region || region.width < 2 || region.height < 2) {
            toast.error("Marca un área más grande de la imagen.");
            return;
        }

        window.dispatchEvent(new CustomEvent("siragpt:image-region-edit", {
            detail: {
                imageUrl: src,
                fileId: file.fileId || file.id,
                prompt: file.prompt,
                aspectRatio: file.aspectRatio,
                region,
            },
        }));
        setEditMode(false);
        toast.success("Zona marcada. Escribe qué quieres cambiar y envía el mensaje.");
    };

    return (
        <div
            ref={frameRef}
            className={cn(
                "group/image relative inline-block overflow-hidden rounded-xl bg-muted/30 shadow-sm",
                editMode && "cursor-crosshair ring-2 ring-pink-500/60"
            )}
            onPointerDown={beginSelection}
            onPointerMove={moveSelection}
            onPointerUp={finishSelection}
            onPointerCancel={() => setDragStart(null)}
        >
            <img
                src={src}
                alt={`Generated image ${index + 1}`}
                className={cn(
                    "max-w-full h-auto max-h-[250px] sm:max-h-[400px] object-contain transition duration-200",
                    editMode ? "select-none opacity-90" : "cursor-pointer hover:opacity-90"
                )}
                loading="lazy"
                draggable={false}
                onLoad={onLoad}
                onError={onError}
                onClick={() => {
                    if (!editMode) onOpen(src);
                }}
            />

            {selection && (
                <div
                    className="pointer-events-none absolute border-2 border-pink-500 bg-pink-500/20 shadow-[0_0_0_9999px_rgba(15,23,42,0.18)]"
                    style={{
                        left: `${selection.x}%`,
                        top: `${selection.y}%`,
                        width: `${selection.width}%`,
                        height: `${selection.height}%`,
                    }}
                />
            )}

            {editMode && (
                <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/70 px-3 py-1 text-[11px] font-semibold text-white backdrop-blur">
                    Arrastra para marcar la zona
                </div>
            )}

            <div className="absolute right-3 top-3 z-20 flex gap-2 opacity-0 transition-all duration-200 group-hover/image:opacity-100">
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpen(src);
                    }}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-gray-800 shadow-lg transition hover:scale-105 hover:bg-white"
                    title="Ampliar imagen"
                    aria-label="Ampliar imagen"
                >
                    <Maximize2 className="h-4 w-4" />
                </button>
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        setEditMode((value) => !value);
                        setSelection(null);
                    }}
                    className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition hover:scale-105",
                        editMode ? "bg-pink-600 text-white" : "bg-white/90 text-gray-800 hover:bg-white"
                    )}
                    title="Seleccionar zona con pincel"
                    aria-label="Seleccionar zona con pincel"
                >
                    <Brush className="h-4 w-4" />
                </button>
            </div>
        </div>
    );
};

const MessageComponent = ({ message, user, onRegenerate, updateMessageInChat, isStreaming, onToggleSplitView, isGeneratingImage, onDocumentPreview, children }: {
    message: any;
    user: any;
    onRegenerate: (messageId: string) => void;
    updateMessageInChat: (messageId: string, newContent: string, files?: any[]) => void;
    isStreaming?: boolean;
    onToggleSplitView?: (content: any) => void;
    isGeneratingImage?: boolean;
    onDocumentPreview?: (target: DocumentPreviewTarget) => void;
    children?: React.ReactNode;
}) => {
    // Performance monitoring disabled to prevent overhead
    // const renderStartTime = performance.now()
    // const performanceOptimizer = PerformanceOptimizer.getInstance()
    const [isCopied, setIsCopied] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
    const [audioProgress, setAudioProgress] = useState(0);
    const [audioDuration, setAudioDuration] = useState(0);
    const [showAudioPlayer, setShowAudioPlayer] = useState(false);
    const [isLoadingAudio, setIsLoadingAudio] = useState(false);
    const [feedbackSent, setFeedbackSent] = useState(message.feedback || null);
    const [isEditing, setIsEditing] = useState(false);
    const [editedContent, setEditedContent] = useState(message.content);
    const [imageLoading, setImageLoading] = useState<{ [key: string]: boolean }>({});
    const [imageError, setImageError] = useState<{ [key: string]: boolean }>({});
    const [selectedImage, setSelectedImage] = useState<string | null>(null);
    const imageLoadedRef = React.useRef<Set<string>>(new Set());
    const [selectedFile, setSelectedFile] = useState<any>(null);
    const [fileContent, setFileContent] = useState<string>("");
    const [isContentLoading, setIsContentLoading] = useState(false);
    const [isTableExpanded, setIsTableExpanded] = useState(false);
    const [tableData, setTableData] = useState<string[][]>([]);
    const [tableHeaders, setTableHeaders] = useState<string[]>([]);

    const [tableTitle, setTableTitle] = useState<string>('');

    // Code preview states (now memoized for performance)

    const getNodeText = (node: any): string => {
        if (node.type === 'text') {
            return node.value;
        }
        if (node.children) {
            return node.children.map(getNodeText).join('');
        }
        return '';
    };



    // Video-specific states
    const [videoLoading, setVideoLoading] = useState(false);
    const [videoError, setVideoError] = useState(false);
    const [isVideoPlaying, setIsVideoPlaying] = useState(false);
    const [videoProgress, setVideoProgress] = useState(0);
    const [videoDuration, setVideoDuration] = useState(0);

    const videoRef = React.useRef<HTMLVideoElement>(null);
    const { handleTextToSpeech } = useVoiceControls();

    const handleViewFile = async (file: any) => {
        if (!file.id) {
            toast.error("File ID is missing. Cannot fetch content.");
            return;
        }
        setSelectedFile(file);
        setIsContentLoading(true);
        setFileContent("");
        try {
            // This function will need to be created in lib/api.ts
            const content = await apiClient.getFileContent(file.id);
            setFileContent(content);
        } catch (error) {
            console.error("Failed to fetch file content:", error);
            toast.error("Failed to load file content.");
            setFileContent("Error: Could not load file content.");
        } finally {
            setIsContentLoading(false);
        }
    };

    useEffect(() => {
        setEditedContent(message.content);
    }, [message.content]);

    // Handle ESC key to close image modal
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && selectedImage) {
                setSelectedImage(null);
            }
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [selectedImage]);

    // Optimized code detection with memoization to prevent repeated parsing
    const parsedCode = useMemo(() => {
        if (message.content && (message.role === 'assistant' || message.role === 'ASSISTANT')) {
            return parseCodeFromContent(message.content);
        }
        return null;
    }, [message.content, message.role]);

    const canPreviewMessage = useMemo(() => {
        if (!parsedCode) return false;
        if (!parsedCode.hasWebCode) return false;
        if (parsedCode.hasNonWebCode && !parsedCode.combinedCode) return false;
        return !!(parsedCode.combinedCode || parsedCode.html);
    }, [parsedCode]);

    const handlePreview = () => {
        if (!parsedCode || !onToggleSplitView) return;

        const content = {
            htmlCode: parsedCode.html || '',
            cssCode: parsedCode.css || '',
            jsCode: parsedCode.js || '',
            combinedCode: parsedCode.combinedCode || '',
            title: 'Code Preview'
        };

        onToggleSplitView(content);
    };

    // Cleanup audio when component unmounts
    useEffect(() => {
        return () => {
            if (currentAudio) {
                currentAudio.pause();
                setCurrentAudio(null);
            }
        };
    }, [currentAudio]);

    // Video event handlers
    const handleVideoPlay = () => {
        if (videoRef.current) {
            videoRef.current.play();
            setIsVideoPlaying(true);
        }
    };

    const handleVideoPause = () => {
        if (videoRef.current) {
            videoRef.current.pause();
            setIsVideoPlaying(false);
        }
    };

    const handleVideoTimeUpdate = () => {
        if (videoRef.current) {
            const progress = (videoRef.current.currentTime / videoRef.current.duration) * 100;
            setVideoProgress(progress);
        }
    };

    const handleVideoLoadedMetadata = () => {
        if (videoRef.current) {
            setVideoDuration(videoRef.current.duration);
        }
    };

    const downloadVideo = async () => {
        if (message.videoData?.filename) {
            try {
                setVideoLoading(true);
                // apiClient.downloadVideo returns a URL string, not a blob. We need to fetch the file as a blob.
                // const downloadUrl = apiClient.downloadVideo(message.videoData.filename);
                // const response = await fetch(downloadUrl);
                // if (!response.ok) throw new Error('Network response was not ok');
                // const blob = await response.blob();
                const blob = await apiClient.downloadVideo(message.videoData.filename);
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = message.videoData.filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                toast.success('Video downloaded successfully!');
            } catch (error) {
                console.error('Download failed:', error);
                toast.error('Failed to download video');
            } finally {
                setVideoLoading(false);
            }
        }
    };

    const ErrorMessage = ({ onRegenerate }: { onRegenerate: (messageId: string) => void }) => (
        <div className="flex items-center gap-2 text-red-500 py-2 px-4 bg-red-500/10 rounded-md">
            <AlertCircle className="h-4 w-4" />
            <p className="text-sm font-medium">An error occurred.</p>
            <Button onClick={() => onRegenerate(message.id)} variant="ghost" size="sm" className="ml-auto">
                <RefreshCw className="h-4 w-4 mr-1" />
                Try again
            </Button>
        </div>
    );


    const isAssistant = message.role === "ASSISTANT";
    const isUser = message.role === "USER";

    // Ahem Condition: Kya yeh ek khali AI message hai?
    // Also treat messages that carry explicit SSE-driven progress
    // metadata (progressStage / progressPct set by the plan / math /
    // viz dispatchers) as "thinking" so the unified placeholder with
    // the animated SVG bars stays visible for the whole activity.
    const isThinking = isAssistant && !message.error && (
      !message.content || !!(message as any).progressStage
    );
    // const isThinking = isAssistant && message.content === null;

    // For Share Functionality - Individual Message
    const handleShare = async () => {
        try {
            if (!message.id || !message.chatId) {
                throw new Error("Mensaje sin id de chat — no se puede compartir.");
            }
            const response = await apiClient.shareMessage(message.id, message.chatId);
            const shareId = response?.shareableLink;
            if (!shareId) throw new Error("La respuesta del servidor no incluyó el shareableLink.");
            const baseUrl = (typeof window !== "undefined" && window.location?.origin)
                || process.env.NEXT_PUBLIC_URL
                || `http://localhost:${process.env.PORT || 3000}`;
            const url = `${baseUrl}/share/message/${shareId}`;
            // Best-effort copy; if clipboard fails we still show the URL in the toast.
            try {
                if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(url);
                    toast.success("Enlace copiado al portapapeles.");
                } else {
                    toast.success(`Enlace: ${url}`);
                }
            } catch {
                toast.success(`Enlace: ${url}`);
            }
        } catch (err: any) {
            const status = err?.status || err?.statusCode;
            const detail = err?.errorData?.error || err?.message || "error desconocido";
            console.error("[share] failed:", { status, detail, messageId: message.id, chatId: message.chatId });
            if (status === 401) toast.error("Tu sesión expiró. Inicia sesión de nuevo.");
            else if (status === 404) toast.error("Chat o mensaje no encontrado (¿es tuyo?).");
            else toast.error(`No se pudo crear el enlace: ${detail}`);
            throw err;
        }
    };



    const handleEditSave = async () => {
        if (editedContent.trim() === message.content || editedContent.trim() === "") {
            setIsEditing(false);
            return;
        }
        try {
            // We only need to call editAndRegenerate, which now handles the API call.
            // The files are passed from the original message to be preserved.
            updateMessageInChat(message.id, editedContent, message.files);
            toast.success("Message updated and regenerating response...");
            setIsEditing(false);
        } catch (error) {
            toast.error("Failed to update message.");
        }
    };

    // Word-grade copy: write a rich clipboard payload (HTML + plain
    // text, with RTF when the browser allows it) from the markdown
    // source, so pasting into Word keeps headings, lists, tables and
    // emphasis without carrying chat UI borders or buttons.
    const handleGlobalCopy = async () => {
        const source = stripNonCopyableArtifactBlocks(String(message.content || ""));
        if (!source) {
            toast.error("Nada que copiar.");
            throw new Error("empty_content");
        }
        try {
            await copyMarkdownToWordClipboard(source);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
            toast.success("Copiado con formato profesional para Word");
        } catch (err: any) {
            console.error("[copy] failed:", err);
            toast.error(`No se pudo copiar: ${err?.message || "error desconocido"}`);
            throw err;
        }
    };

    const handleFeedback = async (feedbackType: 'liked' | 'disliked') => {
        if (feedbackSent === feedbackType) {
            // Toggling off — for now we keep the local pulse but skip the API
            // call (backend has no DELETE endpoint for feedback).
            return;
        }
        try {
            await apiClient.handleFeedbackLikeDislike(message.id, feedbackType);
            setFeedbackSent(feedbackType);
            toast.success(feedbackType === "liked" ? "¡Gracias por tu feedback!" : "Feedback registrado");
        } catch (err: any) {
            const status = err?.status || err?.statusCode;
            const detail = err?.errorData?.error || err?.message || "error desconocido";
            console.error("[feedback] failed:", { status, detail, messageId: message.id });
            if (status === 401) toast.error("Tu sesión expiró. Inicia sesión de nuevo.");
            else if (status === 404) toast.error("Mensaje no encontrado o no es tuyo.");
            else toast.error(`No se pudo enviar feedback: ${detail}`);
            throw err;
        }
    };

    const handleSpeak = async () => {
        if (isSpeaking && currentAudio) {
            currentAudio.pause();
            setIsSpeaking(false);
            setCurrentAudio(null);
            return;
        }

        const textToSpeak = message.content
            .replace(/```[\s\S]*?```/g, 'Code block')
            .replace(/`[^`]*`/g, 'Code')
            .replace(/([_*#`~]|\\[*#`~])/g, '')
            .replace(/\[(.*?)\]\(.*?\)/g, '$1');

        try {
            setIsLoadingAudio(true);
            setShowAudioPlayer(true);
            // Try ElevenLabs TTS first
            const audio = await handleTextToSpeech(textToSpeak);
            setIsLoadingAudio(false);
            if (audio) {
                setCurrentAudio(audio);

                // Set up audio event listeners
                audio.onloadedmetadata = () => {
                    setAudioDuration(audio.duration);
                };

                audio.ontimeupdate = () => {
                    setAudioProgress((audio.currentTime / audio.duration) * 100);
                };

                audio.onended = () => {
                    setIsSpeaking(false);
                    setAudioProgress(0);
                    setShowAudioPlayer(false);
                    setCurrentAudio(null);
                };

                audio.onerror = () => {
                    setIsSpeaking(false);
                    setAudioProgress(0);
                    setShowAudioPlayer(false);
                    setCurrentAudio(null);
                    setIsLoadingAudio(false);
                    toast.error("Audio playback failed");
                };

                audio.onpause = () => {
                    setIsSpeaking(false);
                };

                audio.onplay = () => {
                    setIsSpeaking(true);
                };
            }
        } catch (error) {
            // Fallback to browser TTS
            console.log('ElevenLabs TTS failed, using browser TTS:', error);
            setIsLoadingAudio(false);
            setShowAudioPlayer(false);
            const utterance = new SpeechSynthesisUtterance(textToSpeak);
            utterance.onend = () => {
                setIsSpeaking(false);
                setCurrentAudio(null);
            };
            window.speechSynthesis.speak(utterance);
        }
    };

    const toggleAudioPlayback = () => {
        if (currentAudio) {
            if (isSpeaking) {
                currentAudio.pause();
            } else {
                currentAudio.play();
            }
        }
    };

    const stopAudio = () => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        setIsSpeaking(false);
        setAudioProgress(0);
        setShowAudioPlayer(false);
        setCurrentAudio(null);
        setIsLoadingAudio(false);
    };

    const formatTime = (seconds: number) => {
        if (isNaN(seconds)) return "0:00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const parsedFiles: any[] = useMemo(() => {
        if (!message.files) return []
        try {
            const parsed = typeof message.files === 'string' ? JSON.parse(message.files) : message.files
            // Ensure we always return an array
            return Array.isArray(parsed) ? parsed : []
        } catch (e) {
            console.error("Failed to parse files:", e)
            return []
        }
    }, [message.files])

    const hasFiles = parsedFiles && parsedFiles.length > 0;
    const hasContent = useMemo(() => message.content && message.content.trim() !== "", [message.content]);

    // Detect if this assistant message includes a structured Gmail payload to avoid duplicate markdown
    const hasGmailEntry = useMemo(() => {
        return Array.isArray(parsedFiles) && parsedFiles.some((f: any) => f?.type === 'gmail_emails' || f?.type === 'gmail_search_results')
    }, [parsedFiles])

    // Optimized CodeBlock component with performance improvements.
    // Meta-AI-style artifact routing: when the code is executable
    // (html with DOCTYPE/html/canvas/svg, or svg/mermaid), mount
    // the ArtifactCard (inline iframe preview + 4-button rail) in
    // place of the plain syntax-highlighted block.
    const CodeBlock = ({ node, inline, className, children, ...props }: any) => {
        const match = /language-([\w-]+)/.exec(className || '');
        if (!inline && match) {
            const language = match[1];
            const codeString = String(children).replace(/\n$/, '');
            if (language === 'agent-task-state') {
                try {
                    const state = JSON.parse(codeString);
                    return <AgenticStepsRenderer state={state} onDocumentPreview={onDocumentPreview} />;
                } catch {
                    return null;
                }
            }
            if (isExecutableArtifact(language, codeString)) {
                return <ArtifactCard code={codeString} language={language} />;
            }
            return (
                <CustomCodeBlock className={className} {...props} canPreview={canPreviewMessage} onPreview={handlePreview}>
                    {children}
                </CustomCodeBlock>
            );
        }
        return (
            <code className="text-sm font-mono  px-[0.4rem] py-[0.2rem] rounded-sm" {...props} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {children}
            </code>
        );
    };

    // Optimized message content rendering with performance safeguards
    const MessageContent = ({ content }: { content: string }) => {
        // ✅ PERFORMANCE FIX: Use simple rendering for streaming messages
        // if (isStreaming) {
        //     return (
        //         <div className="prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed">
        //             <p className="mb-3 text-base whitespace-pre-wrap">{message.content}</p>
        //         </div>
        //     );
        // }


        // Memoize ReactMarkdown components to prevent unnecessary re-renders
        const components = useMemo(() => {
            const commonProps = {
                pre: ({ children }: any) => {
                    const child = React.Children.toArray(children)[0]
                    const childProps = React.isValidElement(child) ? (child.props as any) : null
                    if (
                        typeof childProps?.className === "string" &&
                        childProps.className.includes("language-agent-task-state")
                    ) {
                        return <>{children}</>
                    }
                    return <pre>{children}</pre>
                },
                p: ({ children }: any) => <p className="mb-4 text-base leading-7">{children}</p>,
                ul: ({ children }: any) => <ul className="mb-4 pl-6 text-base leading-7">{children}</ul>,
                ol: ({ children }: any) => <ol className="mb-4 pl-6 text-base leading-7">{children}</ol>,
                li: ({ children }: any) => <li className="mb-1.5 text-base leading-7">{children}</li>,
                h1: ({ children }: any) => <h1 className="mb-4 text-2xl font-semibold leading-8">{children}</h1>,
                h2: ({ children }: any) => <h2 className="mb-3 text-xl font-semibold leading-7">{children}</h2>,
                h3: ({ children }: any) => <h3 className="mb-2 text-lg font-semibold leading-7">{children}</h3>,
                blockquote: ({ children }: any) => <blockquote className="border-l-4 border-muted pl-4 mb-3 italic">{children}</blockquote>,
                table: ({ node, children, ...props }: any) => {
                    // ✅ Performance Optimization: Skip expensive processing during streaming
                    // Only enable table controls and data extraction when streaming is complete
                    if (isStreaming) {
                        // During streaming, render simple table without controls
                        return (
                            <div className="group relative mt-3">
                                <div className="overflow-x-auto w-full min-w-0 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-transparent hover:scrollbar-thumb-gray-600" style={{ WebkitOverflowScrolling: 'touch', maxWidth: '100vw' }}>
                                    <table className="border-collapse border border-muted mb-3 w-full" style={{ minWidth: "520px" }}>{children}</table>
                                </div>
                                <div className="block md:hidden mt-1 text-xs text-muted-foreground text-center select-none">Swipe left/right to view the table</div>
                            </div>
                        );
                    }

                    // After streaming is complete, enable full table functionality
                    let title = '';
                    const parent = node.parent;
                    if (parent) {
                        const tableIndex = parent.children.indexOf(node);
                        for (let i = tableIndex - 1; i >= 0; i--) {
                            const sibling = parent.children[i];
                            if (sibling.tagName === 'h1' || sibling.tagName === 'h2' || sibling.tagName === 'h3') {
                                title = getNodeText(sibling);
                                break;
                            }
                            if (sibling.type !== 'text' || sibling.value.trim() !== '') {
                                break;
                            }
                        }
                    }

                    const handleExpand = () => {
                        const tHead = node.children.find((child: any) => child.tagName === 'thead');
                        const tBody = node.children.find((child: any) => child.tagName === 'tbody');
                        console.log(children);

                        const headers = tHead?.children?.[0]?.children?.map(getNodeText).filter((e: string) => e != "\n") ?? [];
                        const data = tBody?.children?.map((tr: any) => tr.children?.map(getNodeText).filter((e: string) => e !== "\n") ?? []) ?? [];

                        setTableHeaders(headers);
                        setTableData(data);
                        setTableTitle(title);
                        setIsTableExpanded(true);
                    };

                    return (
                        <div className="group relative mt-3">
                            <TableControls content={message.content} messageId={message.id} onExpand={handleExpand} title={title} />
                            <div className="overflow-x-auto w-full min-w-0 scrollbar-thin scrollbar-thumb-gray-400 scrollbar-track-transparent hover:scrollbar-thumb-gray-600" style={{ WebkitOverflowScrolling: 'touch', maxWidth: '100vw' }}>
                                <table className="border-collapse border border-muted mb-3 w-full" style={{ minWidth: "520px" }}>{children}</table>
                            </div>
                            <div className="block md:hidden mt-1 text-xs text-muted-foreground text-center select-none">Swipe left/right to view the table</div>
                        </div>
                    );
                },
                th: ({ children }: any) => <th className="border border-muted px-3 py-2 bg-muted/50 text-left font-medium text-sm whitespace-nowrap">{children}</th>,
                td: ({ children }: any) => <td className="border border-muted px-3 py-2 text-sm whitespace-nowrap">{children}</td>,
                strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
                em: ({ children }: any) => <em className="italic">{children}</em>,
                a: ({ href, children, ...props }: any) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-600 hover:text-sky-800 underline decoration-sky-400 hover:decoration-sky-600"
                        title={href} // Tooltip for full URL
                        {...props}
                    >
                        {truncateUrl(children)}
                    </a>
                )
            };

            if (isStreaming) {
                return {
                    ...commonProps,
                    code: ({ node, inline, className, children, ...props }: any) => {
                        const match = /language-([\w-]+)/.exec(className || '');
                        if (!inline && match) {
                            const lang = (match[1] || '').toLowerCase();
                            const codeString = String(children).replace(/\n$/, '');
                            // Agent task state: rendered as Claude-style step
                            // cards instead of a raw code block. The chat
                            // surface persists agent runs as a fenced JSON
                            // payload so a chat reload can re-hydrate them.
                            if (lang === 'agent-task-state') {
                                try {
                                    const state = JSON.parse(codeString);
                                    return <AgenticStepsRenderer state={state} onDocumentPreview={onDocumentPreview} />;
                                } catch {
                                    return null;
                                }
                            }
                            // Will the block become an artifact once streaming
                            // finishes? Run the same detector we use post-
                            // stream so the header + final card stay aligned.
                            const willBeArtifact = isExecutableArtifact(lang, codeString)
                                || (lang === 'html' && /<!doctype|<html[\s>]/i.test(codeString.slice(0, 200)))
                                || (lang === 'mermaid')
                                || (lang === 'svg');
                            if (willBeArtifact) {
                                // Compact streaming card: capped height so a
                                // long HTML document doesn't take over the
                                // whole viewport while it's being generated.
                                // A fade at the bottom hints at the scroll,
                                // and the "Generando artefacto…" pill sits
                                // on top-right with a pulsing dot.
                                return (
                                    <div className="my-4 overflow-hidden rounded-lg border border-black/[0.06] dark:border-white/[0.06] bg-zinc-950/70">
                                        <div className="flex items-center justify-between px-3.5 py-1.5 border-b border-white/[0.04]">
                                            <span className="text-[11px] font-sans tracking-wide text-zinc-500">{lang}</span>
                                            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400/90">
                                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                                Generando artefacto…
                                            </span>
                                        </div>
                                        <div className="relative">
                                            <pre className="text-[12.5px] leading-[1.55] whitespace-pre-wrap p-3.5 font-mono text-zinc-200 max-h-[280px] overflow-auto"><code>{codeString}</code></pre>
                                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-zinc-950/90 to-transparent" />
                                        </div>
                                    </div>
                                );
                            }
                            // Non-artifact code block during streaming:
                            // same cap + simple header.
                            return (
                                <div className="my-4 overflow-hidden rounded-lg border border-black/[0.06] dark:border-white/[0.06] bg-zinc-950/60">
                                    <div className="px-3.5 py-1.5 border-b border-white/[0.04] text-[11px] font-sans tracking-wide text-zinc-500">{lang}</div>
                                    <pre className="text-[12.5px] leading-[1.55] whitespace-pre-wrap p-3.5 font-mono text-zinc-100 max-h-[280px] overflow-auto"><code>{codeString}</code></pre>
                                </div>
                            );
                        }
                        return (
                            <code className="text-sm font-mono bg-muted px-[0.4rem] py-[0.2rem] rounded-sm" {...props}>{children}</code>
                        );
                    },
                };
            }

            return {
                ...commonProps,
                code: CodeBlock,
            };
        }, [isStreaming, CodeBlock]);

        if (message.role === 'ASSISTANT' && (content === '[GENERATING_IMAGE]' || content === '[PROCESSING_GMAIL]' || content === '[PROCESSING_CALENDAR_ACTION]' || content === '[PROCESSING_DRIVE_ACTION]' || content === '[GENERATING_PPT]' || content === '[GENERATING_VECTOR_PPT]' || content === '[THESIS_GENERATING]' || content.startsWith('[THESIS_GENERATING]'))) {
            return null;
        }
        // Don't render markdown for image-only messages to improve performance
        if (isImageOnlyMessage() || isVideoMessage) {
            return null;
        }

        const handleRenderedCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
            const payload = createWordClipboardPayloadFromSelection(event.currentTarget, content);
            if (!payload) return;

            setClipboardDataForWord(event.clipboardData, payload);
            event.preventDefault();
            toast.success("Selección copiada con formato para Word");
        };

        return (
            // [&_p:last-child]:!mb-0 trims the trailing 1em margin that
            // `prose-sm` adds to the final paragraph — that margin was
            // pushing the action rail visually too far from the message.
            // We keep all other prose typography intact.
            <div className={cn(
                "prose prose-sm dark:prose-invert max-w-none text-current leading-relaxed",
                "[&_p:last-child]:!mb-0 [&_p:first-child]:!mt-0",
                "[&_ul:last-child]:!mb-0 [&_ol:last-child]:!mb-0 [&_pre:last-child]:!mb-0",
            )}
                data-sgpt-rich-copy-root=""
                onCopyCapture={handleRenderedCopy}
            >
                <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex, rehypeRaw]}
                    components={components}
                >
                    {content}
                </ReactMarkdown>
            </div>
        );
    };

    const videoEntry = useMemo(
        () => Array.isArray(parsedFiles) ? parsedFiles.find((f: any) => f?.type === 'video') : null,
        [parsedFiles]
    )
    const isVideoMessage = !!videoEntry

    const pptEntry = useMemo(
        () => Array.isArray(parsedFiles) ? parsedFiles.find((f: any) => f?.type === 'presentation' || f?.type === 'ppt') : null,
        [parsedFiles]
    )
    const isPPTMessage = !!pptEntry

    const displayedContent = useMemo(() => {
        let content = message.content;

        // Check if there's a figma file (diagram)
        const hasFigmaFile = Array.isArray(parsedFiles) && parsedFiles.some((f: any) => f.type === 'figma');

        if (isPPTMessage && pptEntry.structure?.slides?.length > 0) {
            const presentationContent = pptEntry.structure.slides.map((slide: any, index: number) => {
                const title = slide.title || `Slide ${index + 1}`;
                const contentInput = slide.content;
                let content = '';

                // Ensure content is a string before processing
                if (typeof contentInput === 'string') {
                    content = contentInput;
                } else if (Array.isArray(contentInput)) {
                    content = contentInput.join('\n');
                }

                // Check if content is already a list to avoid double-bulleting
                const isAlreadyList = content.trim().startsWith('* ') || content.trim().startsWith('- ') || /^\d+\.\s/.test(content.trim());

                if (content && !isAlreadyList) {
                    content = content
                        .split('\n')
                        .filter((line: string) => line.trim() !== '')
                        .map((line: string) => `* ${line.trim()}`)
                        .join('\n');
                }

                return `### ${title}\n${content}`;
            }).join('\n\n');

            // Replace the placeholder text with the formatted presentation content
            if (message.content && typeof message.content === 'string') {
                const placeholderRegex = /generated presentation.*$/i;
                if (placeholderRegex.test(message.content)) {
                    content = message.content.replace(placeholderRegex, presentationContent);
                }
            } else {
                // Fallback: append if no placeholder is found
                content = `${message.content}\n\n${presentationContent}`;
            }
        }

        // Remove mermaid code blocks if there's a figma diagram file
        if (hasFigmaFile && content && typeof content === 'string') {
            // Remove mermaid code blocks using regex
            content = content.replace(/```mermaid[\s\S]*?```/g, '').trim();
        }

        return content;
    }, [message.content, isPPTMessage, pptEntry, parsedFiles]);

    const hasFigmaDiagram = useMemo(() => {
        return Array.isArray(parsedFiles) && parsedFiles.some((f: any) => f.type === 'figma');
    }, [parsedFiles]);

    // Check for Gmail connection requirement
    const isGmailConnectionRequired = useMemo(() => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                return metadata?.type === 'gmail_connection_required' && metadata?.showConnectionCard;
            }
            return false;
        } catch {
            return false;
        }
    }, [message.metadata]);

    // Check for Google Services connection requirement
    const isGoogleServicesConnectionRequired = useMemo(() => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                return metadata?.type === 'google_services_connection_required' && metadata?.showConnectionCard;
            }
            return false;
        } catch {
            return false;
        }
    }, [message.metadata]);

    const isSpotifyConnectionRequired = useMemo(() => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                return metadata?.type === 'spotify_connection_required' && metadata?.showConnectionCard;
            }
            return false;
        } catch {
            return false;
        }
    }, [message.metadata]);

    // Gmail Connection Component
    const GmailConnectionDisplay = () => {
        if (!isGmailConnectionRequired) return null;

        return (
            <div className="mt-4">
                <GmailConnectionCard
                    onConnect={() => {
                        // Optional: Add any additional handling after connection
                        console.log('Gmail connection initiated');
                    }}
                />
            </div>
        );
    };

    // Google Services Connection Component
    const GoogleServicesConnectionDisplay = () => {
        if (!isGoogleServicesConnectionRequired) return null;

        return (
            <div className="mt-4">
                <GoogleServicesConnectionCard
                    onConnectionChange={(isConnected) => {
                        if (isConnected) {
                            console.log('Google Services connected successfully');
                        }
                    }}
                />
            </div>
        );
    };

    const SpotifyConnectionDisplay = () => {
        if (!isSpotifyConnectionRequired) return null;

        return (
            <div className="mt-4">
                <SpotifyConnectionCard />
            </div>
        );
    };

    const SpotifyResultsDisplay = () => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                if (metadata?.type === 'spotify_results') {
                    return <SpotifyResults data={metadata.data} />;
                }
            }
            return null;
        } catch {
            return null;
        }
    };

    // Computer Use Reasoning Display
    const ComputerUseReasoningDisplay = () => {
        try {
            if (message.metadata) {
                const metadata = typeof message.metadata === 'string'
                    ? JSON.parse(message.metadata)
                    : message.metadata;
                if (metadata?.type === 'computer_use_reasoning') {
                    const step = {
                        text: message.content,
                        timestamp: Date.now(),
                        action: metadata?.action
                    };
                    return <ComputerUseReasoning step={step} stepNumber={metadata?.stepNumber || 1} />;
                }
            }
            return null;
        } catch {
            return null;
        }
    };

    // Check if this is an image-only message
    const isImageOnlyMessage = () => {
        return isImageOnlyMessageForRender(message, parsedFiles);
    };

    // Check if this message contains computer use extracted data
    const getComputerUseData = () => {
        if (!parsedFiles || !Array.isArray(parsedFiles)) return null;

        const computerUseFile = parsedFiles.find((f: any) => f.type === 'computer_use_extraction');
        return computerUseFile || null;
    };

    const getThesisData = () => {
        try {
            // First try to get from metadata
            if (message.metadata) {
                const parsed = typeof message.metadata === 'string' ? JSON.parse(message.metadata) : message.metadata;
                if (parsed.thesisData) return parsed.thesisData;
            }
            
            // Then try direct thesisData field
            if (message.thesisData) return message.thesisData;
            
            // Fallback: detect thesis content by pattern matching
            if (typeof message.content === 'string' && message.role === 'ASSISTANT') {
                const content = message.content;
                
                // Check for thesis-specific content patterns
                const thesisPatterns = [
                    '🔍 Initializing Thesis Generation',
                    '🔍 **Searching Academic Sources**',
                    '📝 **Generating Thesis Document**',
                    '✅ **Thesis Generation Completed**',
                    '❌ **Thesis Generation Error**',
                    'Google Scholar: scholar.google.com',
                    'ResearchGate: www.researchgate.net',
                    'PubMed: pubmed.ncbi.nlm.nih.gov',
                    'ArXiv: arxiv.org/search',
                    'IEEE Xplore: ieeexplore.ieee.org',
                    'Thesis_.*\\.docx',
                    'Topics Covered:.*Research Sources:',
                    'Preparing to research and analyze',
                    'Starting academic source search',
                    'Found \\d+ sources for topic',
                    'Research Materials Saved',
                    'Total Sources Found:',
                    'Your comprehensive thesis has been generated',
                    'Word Document.*Download.*Preview in Chat'
                ];
                
                const isThesisMessage = thesisPatterns.some(pattern => {
                    try {
                        return new RegExp(pattern, 'i').test(content);
                    } catch {
                        return content.toLowerCase().includes(pattern.toLowerCase());
                    }
                });
                
                if (isThesisMessage) {
                    // Extract thesis data from content patterns
                    let status: 'initializing' | 'searching' | 'generating' | 'completed' | 'error' = 'initializing';
                    let progress = 0;
                    let documentFilename = '';
                    let sourcesCount = 0;
                    let topics: string[] = [];
                    
                    // Determine status and extract comprehensive data
                    if (content.includes('Initializing Thesis Generation') || 
                        content.includes('Preparing to research and analyze') ||
                        content.includes('Starting academic source search')) {
                        status = 'initializing';
                        progress = 10;
                    } else if (content.includes('**Searching Academic Sources**') || 
                               content.includes('Found') && content.includes('sources for topic') ||
                               content.includes('Google Scholar:') ||
                               content.includes('ResearchGate:') ||
                               content.includes('PubMed:')) {
                        status = 'searching';
                        progress = 40;
                    } else if (content.includes('**Generating Thesis Document**') ||
                               content.includes('Generating Literature Review') ||
                               content.includes('Generating Introduction') ||
                               content.includes('Generating Methodology') ||
                               content.includes('Generating Analysis') ||
                               content.includes('Generating Conclusion')) {
                        status = 'generating';
                        // Extract progress from backend message like "76.25"
                        const progressMatch = content.match(/(\d+(?:\.\d+)?)%/);
                        if (progressMatch) {
                            progress = Math.round(parseFloat(progressMatch[1]));
                        } else {
                            progress = 70;
                        }
                    } else if (content.includes('Research Materials Saved') ||
                               content.includes('Total Sources Found:')) {
                        status = 'generating';
                        progress = 60;
                    } else if (content.includes('**Thesis Generation Completed**') || 
                               content.includes('Your comprehensive thesis has been generated') ||
                               content.includes('Thesis_') ||
                               (content.includes('Word Document') && content.includes('Download') && content.includes('Preview'))) {
                        status = 'completed';
                        progress = 100;
                    } else if (content.includes('**Thesis Generation Error**')) {
                        status = 'error';
                        progress = 0;
                    }
                    
                    // For completed status, show full summary including sources from previous steps
                    if (status === 'completed') {
                        // Extract comprehensive data for completed state
                        const topicsMatch = content.match(/Topics Covered:\s*(\d+)/);
                        if (topicsMatch) {
                            const topicCount = parseInt(topicsMatch[1]);
                            // Add common research topics as fallback
                            topics = ['Artificial Intelligence in Healthcare']; // This should ideally come from the actual topic
                        }
                        
                        const sourcesMatch = content.match(/Research Sources:\s*(\d+)/);
                        if (sourcesMatch) {
                            sourcesCount = parseInt(sourcesMatch[1]);
                        }
                    }
                    
                    // Extract document filename
                    const docMatch = content.match(/Thesis_[^.\s]+\.docx/);
                    if (docMatch) {
                        documentFilename = docMatch[0];
                    } else {
                        // Also check for Word Document line format
                        const wordDocMatch = content.match(/Word\s+Document[^\n]*\n([^\n]+\.docx)/i);
                        if (wordDocMatch) {
                            documentFilename = wordDocMatch[1].trim();
                        }
                    }
                    
                    // Extract sources count
                    const sourcesMatch = content.match(/Research Sources:\s*(\d+)/);
                    if (sourcesMatch) {
                        sourcesCount = parseInt(sourcesMatch[1]);
                    } else {
                        const foundMatch = content.match(/Found (\d+) sources/);
                        if (foundMatch) {
                            sourcesCount = parseInt(foundMatch[1]);
                        } else {
                            const totalMatch = content.match(/Total Sources Found:\s*(\d+)/);
                            if (totalMatch) {
                                sourcesCount = parseInt(totalMatch[1]);
                            }
                        }
                    }
                    
                    // Extract topics
                    const topicsMatch = content.match(/Topics Covered:\s*(\d+)/);
                    if (topicsMatch) {
                        // Try to extract actual topic names
                        const topicLines = content.match(/(\w+):\s*\d+\s*sources/g);
                        if (topicLines) {
                            topics = topicLines.map((line: string) => line.split(':')[0].trim());
                        }
                    } else {
                        // Look for "for topic: xxx" pattern
                        const forTopicMatch = content.match(/for topic:\s*["""]([^"""]+)["""]/);
                        if (forTopicMatch) {
                            topics = [forTopicMatch[1].trim()];
                        } else if (content.toLowerCase().includes('robotics')) {
                            topics = ['robotics'];
                        }
                    }
                    
                    return {
                        sessionId: '', // Unknown from content
                        status,
                        progress,
                        message: content, // Use full content as message - the UI will extract what it needs
                        topics,
                        sourcesCount: sourcesCount || undefined,
                        documentFilename: documentFilename || undefined,
                        documentPath: documentFilename ? `/uploads/documents/${documentFilename}` : undefined
                    };
                }
            }
            
            return null;
        } catch (error) {
            console.error('Error parsing thesis data:', error);
            return null;
        }
    };
    const getWatchUrl = (filename: string) => apiClient.getVideoFile(filename)

    const PPTDisplay = () => {
        if (!isPPTMessage) return null;

        const filename = cleanPresentationFilename(pptEntry.filename || pptEntry.path || pptEntry.downloadUrl);
        const presentationData = {
            title: pptEntry.title || 'AI Presentation',
            slides: pptEntry.structure?.slides || [],
            filename,
        };

        const getPPTUrl = () => {
            if (pptEntry.downloadUrl) return backendUrl(String(pptEntry.downloadUrl));
            return backendUrl(`/uploads/presentations/${encodeURIComponent(presentationData.filename)}`);
        };

        const getPPTDownloadUrl = () => {
            return backendUrl(`/uploads/presentations/${encodeURIComponent(presentationData.filename)}/download`);
        };

        const previewPPT = () => {
            if (!onDocumentPreview) return;
            const html = buildPresentationPreviewHtml(pptEntry, presentationData.filename);
            onDocumentPreview({
                url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
                downloadUrl: getPPTDownloadUrl(),
                filename: presentationData.filename,
            });
        };

        const downloadPPT = async () => {
            try {
                const url = getPPTDownloadUrl();
                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = await response.blob();
                const objectUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = objectUrl;
                a.download = presentationData.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
                toast.success('Descarga iniciada');
            } catch (error) {
                console.error('Download failed:', error);
                try {
                    const a = document.createElement('a');
                    a.href = getPPTUrl();
                    a.download = presentationData.filename;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                } catch {
                    toast.error('No se pudo descargar la presentación');
                }
            }
        };

        return (
            <div className="flex gap-2 mt-4">
                <Button size="sm" variant="default" onClick={previewPPT} className="bg-blue-600 hover:bg-blue-700">
                    <Eye className="h-4 w-4 mr-2" />
                    Preview
                </Button>
                <Button size="sm" variant="outline" onClick={downloadPPT}>
                    <Download className="h-4 w-4 mr-2" />
                    Download
                </Button>
            </div>
        );
    };

    const VideoDisplay = () => {
        if (!isVideoMessage) return null

        const status = String(videoEntry.status || '').toLowerCase()
        const filename = videoEntry.filename

        return (
            <div className="mt-3 p-3 rounded-lg border border-border/20 bg-muted/20">
                <div className="flex items-center gap-2 text-sm">
                    <VideoIcon className="h-4 w-4" />
                    <span className="font-medium">AI Video</span>
                </div>

                {status === 'processing' || status === 'in_progress' ? (
                    <div className="mt-2 flex items-center gap-2 text-muted-foreground">
                        <ThinkingIndicator size="sm" />
                        <span>Generating video… This may take 2–5 minutes.</span>
                    </div>
                ) : null}

                {status === 'failed' ? (
                    <div className="mt-2 text-red-500 text-sm">
                        Generation failed. Please try again with a shorter prompt.
                    </div>
                ) : null}

                {status === 'completed' && filename ? (
                    <div className="mt-3 space-y-2">
                        <video
                            key={filename}             // don’t remount unless the file changes
                            ref={videoRef}
                            className="w-full rounded-md"
                            controls
                            preload="auto"
                            playsInline
                            src={getWatchUrl(filename)}
                            // Removed onTimeUpdate/onLoadedMetadata to avoid frequent re-renders
                            onError={(e) => {
                                console.error('Video error', e)
                                toast.error('Failed to play video inline. Try “Open in new tab”.')
                            }}
                        />
                        <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={downloadVideo}>
                                <Download className="h-4 w-4 mr-1" />
                                Download
                            </Button>
                            <Button size="sm" variant="outline" asChild>
                                <a href={getWatchUrl(filename)} target="_blank" rel="noopener noreferrer">
                                    Open in new tab
                                </a>
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>
        )
    }

    const ThesisDisplay = () => {
        const thesisData = getThesisData();
        if (!thesisData) return null;

        return (
            <div className="mt-3">
                <ThesisProgressDisplay 
                    thesisData={thesisData}
                    onPreview={(documentUrl) => {
                        // Use existing document preview system
                        if (onDocumentPreview) {
                            onDocumentPreview(documentUrl);
                        }
                    }}
                />
            </div>
        );
    };

    const GmailSummary = ({ message }: { message: any }) => {
        try {
            const rawContent: string = typeof message.content === 'string' ? message.content : '';
            // Remove the embedded JSON block
            const withoutJson = rawContent.replace(/<EMAILS_JSON>[\s\S]*?<\/EMAILS_JSON>/g, '').trim();

            if (!withoutJson) return null;

            // If we also have a structured emails payload, trim out detailed per-email bullets/links
            const hasStructuredEmails = Array.isArray(parsedFiles) && parsedFiles.some((f: any) => f?.type === 'gmail_emails' || f?.type === 'gmail_search_results')
                || /https:\/\/mail\.google\.com\/mail\//i.test(rawContent);

            let cleaned = withoutJson;
            if (hasStructuredEmails) {
                // Strategy: keep narrative paragraphs and totals; drop paragraphs that look like
                // per-email bullets or contain direct Gmail links (to avoid duplication with the list below)
                const paras = withoutJson.split(/\n\n+/);
                const keep: string[] = [];
                for (const p of paras) {
                    const pTrim = p.trim();
                    const hasGmailLink = /https:\/\/mail\.google\.com\/mail\//i.test(pTrim) || /\bOpen in Gmail\b/i.test(pTrim) || /\bView:\b/i.test(pTrim);
                    const looksLikeEmailBullet = /^[-•]/.test(pTrim) && (/(From:|To:|Ref:|Consumer:|Amount|PKR|USD|View:)/i.test(pTrim));
                    const isNumberedList = /^\d+\s*[\.)]/.test(pTrim);
                    if (hasGmailLink || looksLikeEmailBullet || isNumberedList) {
                        continue; // drop
                    }
                    keep.push(pTrim);
                }
                // Ensure we don't return empty; if everything was dropped, fall back to the first few lines
                cleaned = keep.join('\n\n').trim() || withoutJson.split('\n').slice(0, 6).join('\n');
            }

            return (
                <div className="mb-2 text-md text-foreground/90 prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeRaw]}>
                        {cleaned}
                    </ReactMarkdown>
                </div>
            );
        } catch {
            return null;
        }
    };

    // Gmail emails/search display with inline actions
    const GmailEmailsDisplay = () => {
        // Find gmail emails or search results payload
        const gmailEntry = Array.isArray(parsedFiles)
            ? parsedFiles.find((f: any) => f?.type === 'gmail_emails' || f?.type === 'gmail_search_results')
            : null;
        const initialEmails: any[] = gmailEntry?.emails || [];
        const [emails, setEmails] = useState<any[]>(initialEmails);
        const [replyForId, setReplyForId] = useState<string | null>(null);
        const [replyBody, setReplyBody] = useState<string>("");
        const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});

        // Sync local state when payload changes
        useEffect(() => {
            setEmails(initialEmails);
        }, [gmailEntry, gmailEntry?.emails?.length]);

        if (!gmailEntry) return null;

        const extractEmailsJsonBlock = (text: string) => {
            const m = text.match(/<EMAILS_JSON>([\s\S]*?)<\/EMAILS_JSON>/);
            if (!m) return { jsonText: null as string | null, start: -1, end: -1 };
            return { jsonText: m[1], start: m.index ?? -1, end: (m.index ?? 0) + m[0].length };
        };

        const { jsonText } = extractEmailsJsonBlock(typeof message.content === 'string' ? message.content : '');

        const updateLabelIds = (labelIds: any, label: string, present: boolean) => {
            const base: string[] = Array.isArray(labelIds) ? labelIds : [];
            if (present) {
                return base.includes(label) ? base : [...base, label];
            }
            return base.filter((l) => l !== label);
        };

        const title = gmailEntry.type === 'gmail_search_results' && gmailEntry.query
            ? `Search: ${gmailEntry.query}`
            : (gmailEntry.filters?.unreadOnly ? 'Unread emails' : (gmailEntry.filters?.readOnly ? 'Read emails' : 'Latest emails'));

        const toggleRead = async (em: any) => {
            const id = em.id || em.messageId;
            if (!id) return;
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                // markGmailEmail(messageId, read: boolean)
                await apiClient.markGmailEmail(id, em.isUnread ? true : false);
                setEmails((prev) => prev.map((e) => e.id === id ? { ...e, isUnread: !em.isUnread } : e));
                toast.success(em.isUnread ? 'Marked as read' : 'Marked as unread');
            } catch (e) {
                console.error(e);
                toast.error('Failed to update read state');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        const toggleStar = async (em: any) => {
            const id = em.id || em.messageId;
            if (!id) return;
            const isStarred = !!(em.isStarred ?? (em.labelIds?.includes?.('STARRED')));
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                await apiClient.starGmailEmail(id, !isStarred);
                setEmails((prev) => prev.map((e) => e.id === id ? { ...e, isStarred: !isStarred, labelIds: updateLabelIds(e.labelIds, 'STARRED', !isStarred) } : e));
                toast.success(!isStarred ? 'Starred' : 'Unstarred');
            } catch (e) {
                console.error(e);
                toast.error('Failed to update star');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        const toggleArchive = async (em: any) => {
            const id = em.id || em.messageId;
            if (!id) return;
            const inInbox = !!(em.labelIds?.includes?.('INBOX'));
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                // archive = true removes INBOX
                await apiClient.archiveGmailEmail(id, inInbox);
                setEmails((prev) => prev.map((e) => e.id === id ? { ...e, labelIds: updateLabelIds(e.labelIds, 'INBOX', !inInbox) } : e));
                toast.success(inInbox ? 'Archived' : 'Moved to inbox');
            } catch (e) {
                console.error(e);
                toast.error('Failed to update archive state');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        const deleteEmail = async (em: any) => {
            const id = em.id || em.messageId;
            if (!id) return;
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                await apiClient.deleteGmailEmail(id);
                setEmails((prev) => prev.filter((e) => (e.id || e.messageId) !== id));
                toast.success('Deleted');
            } catch (e) {
                console.error(e);
                toast.error('Failed to delete');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        const openReply = (em: any) => {
            setReplyForId(em.id || em.messageId);
            setReplyBody("");
        };

        const sendReply = async () => {
            const id = replyForId;
            if (!id) return;
            const em = emails.find((e) => (e.id || e.messageId) === id);
            if (!em) return;
            try {
                setBusyMap((m) => ({ ...m, [id]: true }));
                await apiClient.replyGmail({ threadId: em.threadId, messageId: id, body: replyBody });
                toast.success('Reply sent');
                setReplyForId(null);
                setReplyBody("");
            } catch (e) {
                console.error(e);
                toast.error('Failed to send reply');
            } finally {
                setBusyMap((m) => ({ ...m, [id]: false }));
            }
        };

        // Detect a Gmail compose link in assistant content
        const rawContent: string = typeof message.content === 'string' ? message.content : '';
        const composeMatch = rawContent.match(/https:\/\/mail\.google\.com\/mail\/?[^\s)]+view=cm[^\s)]+/i);
        const composeUrl = composeMatch ? composeMatch[0] : null;

        return (
            <div className="mt-3 p-4 rounded-lg border border-border/40 bg-muted/10">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        <Mail className="h-4 w-4" />
                        <span>Gmail • {title} ({emails.length})</span>
                    </div>
                    {/* {composeUrl && (
                        <a
                            href={composeUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground hover:opacity-90"
                        >
                            Compose in Gmail
                        </a>
                    )} */}
                </div>

                <div className="space-y-3">
                    {emails.map((em, idx) => {
                        const dt = em.date ? new Date(em.date) : null;
                        const dateStr = dt ? `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}` : '';
                        const threadLink = em.threadId ? `https://mail.google.com/mail/u/0/#inbox/${em.threadId}` : em.link;
                        const preview = em.body?.trim()?.slice(0, 220) || em.snippet || '';
                        const id = em.id || em.messageId;
                        const busy = !!busyMap[id];
                        const isUnread = (typeof em.isUnread === 'boolean')
                            ? em.isUnread
                            : (Array.isArray(em.labelIds) ? em.labelIds.includes('UNREAD') : false);
                        const isStarred = (typeof em.isStarred === 'boolean') ? em.isStarred : (Array.isArray(em.labelIds) ? em.labelIds.includes('STARRED') : false);
                        const inInbox = Array.isArray(em.labelIds) ? em.labelIds.includes('INBOX') : true;
                        const senderInitial = (em.from || '?').trim().charAt(0).toUpperCase();
                        return (
                            <div key={`${id}-${idx}`} className="p-3 rounded-md border border-border/30 bg-background/40">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <Avatar className="h-6 w-6">
                                                <AvatarFallback className="text-[10px]">{senderInitial || 'S'}</AvatarFallback>
                                            </Avatar>
                                            <div className="font-semibold text-sm line-clamp-1">{em.subject || '(No subject)'}</div>
                                            {isUnread && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">Unread</span>}
                                            {isStarred && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200">Starred</span>}
                                        </div>
                                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{em.from || 'Unknown sender'} • {dateStr}</div>
                                        {preview && <div className="text-sm mt-1 text-foreground/80 line-clamp-2">{preview}</div>}
                                        <div className="mt-2 flex items-center gap-3 flex-wrap">
                                            {threadLink && (
                                                <a
                                                    className="text-xs underline text-primary hover:opacity-80"
                                                    href={threadLink}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                                                        if (isMobile) {
                                                            window.location.href = `mailto:?body=${encodeURIComponent(threadLink)}`;
                                                        } else {
                                                            window.open(threadLink, '_blank');
                                                        }
                                                    }}
                                                >
                                                    Open in Gmail
                                                </a>
                                            )}
                                            <button
                                                disabled={busy}
                                                onClick={() => toggleRead({ ...em, isUnread })}
                                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                            >
                                                {isUnread ? 'Mark as read' : 'Mark as unread'}
                                            </button>
                                            {/* <button
                                                disabled={busy}
                                                onClick={() => toggleStar({ ...em, isStarred })}
                                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                            >
                                                {isStarred ? 'Unstar' : 'Star'}
                                            </button>
                                            <button
                                                disabled={busy}
                                                onClick={() => toggleArchive({ ...em })}
                                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                            >
                                                {inInbox ? 'Archive' : 'Move to inbox'}
                                            </button>
                                            <button
                                                disabled={busy}
                                                onClick={() => deleteEmail({ ...em })}
                                                className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50"
                                            >
                                                Delete
                                            </button> */}
                                            {/* <button
                                                disabled={busy}
                                                onClick={() => openReply(em)}
                                                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                            >
                                                Reply
                                            </button> */}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <Dialog open={!!replyForId} onOpenChange={(isOpen) => { if (!isOpen) setReplyForId(null) }}>
                    <DialogContent className="max-w-lg">
                        <DialogHeader>
                            <DialogTitle>Reply to email</DialogTitle>
                        </DialogHeader>
                        <Textarea
                            value={replyBody}
                            onChange={(e) => setReplyBody(e.target.value)}
                            placeholder="Write your reply..."
                            className="min-h-[120px]"
                        />
                        <DialogFooter>
                            <DialogClose asChild>
                                <Button variant="outline">Cancel</Button>
                            </DialogClose>
                            <Button onClick={sendReply} disabled={!replyBody.trim()}>Send reply</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        );
    }
    // File display logic - optimized for images
    const FileDisplay = () => {
        if (message.role === 'ASSISTANT' && message.content === '[GENERATING_IMAGE]') {
            let meta: any = {};
            try {
                meta = typeof message.metadata === "string" ? JSON.parse(message.metadata) : (message.metadata || {});
            } catch {
                meta = {};
            }
            return <ImageGenerationEffect aspectRatio={meta.aspectRatio || "1:1"} count={meta.imageCount || 1} />;
        }

        if (message.role === 'ASSISTANT' && (message.content === '[GENERATING_PPT]' || message.content === '[GENERATING_VECTOR_PPT]')) {
            return (
                <div className="mt-3 p-3 rounded-lg border border-border/20 bg-muted/20">
                    <div className="flex items-center gap-2 text-sm">
                        <ThinkingIndicator size="sm" />
                        <span className="font-medium">Generating Presentation...</span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                        Your presentation is being created. This may take a moment.
                    </div>
                </div>
            );
        }

        if (message.role === "ASSISTANT" && message.content === "[PROCESSING_GMAIL]") {
            return <ProcessingGmailCard />;
        }

        if (message.role === "ASSISTANT" && message.content === "[PROCESSING_CALENDAR_ACTION]") {
            return <ProcessingGoogleServicesCard action="calendar" />;
        }

        if (message.role === "ASSISTANT" && message.content === "[PROCESSING_DRIVE_ACTION]") {
            return <ProcessingGoogleServicesCard action="drive" />;
        }


        return (
            <>
                {Array.isArray(parsedFiles) && parsedFiles.length > 0 && message.role === "ASSISTANT" && 
                    parsedFiles.some(f => f.type === 'document' && !(f.name && f.name.match(/Thesis_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.docx/))) && (
                    <div className="mt-3 space-y-3">
                        {parsedFiles
                            .filter((file: any) => {
                                // Filter out thesis files - they're handled by ThesisDisplay
                                if (file.type === 'document' && file.name && file.name.match(/Thesis_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.docx/)) {
                                    return false;
                                }
                                return file.type === 'document';
                            })
                            .map((file: any, index: number) => {
                                const fileName = String(file.name || file.filename || 'documento');
                                const fileNameLower = fileName.toLowerCase();
                                const extension = fileNameLower.split('.').pop() || '';
                                const isPowerPoint = extension === 'pptx' || extension === 'ppt' || file.format === 'pptx';
                                const rawDownloadUrl = String(file.dataUrl || file.downloadUrl || file.url || '');
                                const resolvedDownloadUrl = rawDownloadUrl ? backendUrl(rawDownloadUrl) : '';
                                const fallbackPresentationPreview = isPowerPoint
                                    ? `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(fileName)}</title><style>body{margin:0;background:linear-gradient(135deg,#fff7ed,#f8fafc);font-family:Aptos,Inter,system-ui,sans-serif;color:#111827}.wrap{max-width:980px;margin:auto;padding:32px}.card{border:1px solid #e5e7eb;background:white;border-radius:24px;padding:28px;box-shadow:0 20px 60px rgba(15,23,42,.1)}.eyebrow{color:#ea580c;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:800}h1{font-size:42px;line-height:1;margin:10px 0}.muted{color:#6b7280;line-height:1.6}.content{white-space:pre-wrap;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:18px}</style></head><body><main class="wrap"><section class="card"><span class="eyebrow">siraGPT Rendering Agent</span><h1>${escapeHtml(fileName)}</h1><p class="muted">Preview reconstruido para abrir el panel dividido. Las nuevas presentaciones se renderizan desde código con preview HTML estructurado y descarga PPTX nativa.</p><div class="content">${escapeHtml(String(message.content || '').slice(0, 1800))}</div></section></main></body></html>`
                                    : null;
                                const htmlPreview = typeof file.htmlPreview === 'string' && file.htmlPreview.length > 0
                                    ? file.htmlPreview
                                    : fallbackPresentationPreview;
                                const previewUrl = htmlPreview
                                    ? `data:text/html;charset=utf-8,${encodeURIComponent(htmlPreview)}`
                                    : resolvedDownloadUrl;
                                const canPreviewFile = !!onDocumentPreview && !!previewUrl && (
                                    Boolean(htmlPreview) ||
                                    ['docx', 'doc', 'pdf', 'html', 'htm'].includes(extension)
                                );
                                const getFileIcon = () => {
                                    if (fileNameLower.endsWith('.pdf')) {
                                        return <img src="/icons/pdf.png" alt="PDF" className="h-10 w-10" />;
                                    } else if (fileNameLower.endsWith('.docx') || fileNameLower.endsWith('.doc')) {
                                        return <img src="/icons/Word.png" alt="Word" className="h-10 w-10" />;
                                    } else if (isPowerPoint) {
                                        return <PresentationIcon className="h-10 w-10 text-orange-600" />;
                                    }
                                    return <FileText className="h-10 w-10 text-primary" />;
                                };

                                const getFileTypeLabel = () => {
                                    if (fileNameLower.endsWith('.pdf')) return 'PDF';
                                    if (fileNameLower.endsWith('.docx') || fileNameLower.endsWith('.doc')) return 'Word';
                                    if (isPowerPoint) return 'PowerPoint';
                                    return 'Documento';
                                };

                                const formatFileSize = (bytes: number) => {
                                    if (!bytes) return '';
                                    const kb = bytes / 1024;
                                    if (kb < 1024) return `${kb.toFixed(1)} KB`;
                                    return `${(kb / 1024).toFixed(1)} MB`;
                                };

                                return (
                                    <Card key={index} className="p-5 hover:shadow-lg transition-all duration-200 border-2 border-border/50 hover:border-primary/30 bg-gradient-to-br from-card to-card/50">
                                        <div className="flex items-start gap-4">
                                            <div className="flex-shrink-0 p-3 rounded-xl bg-primary/5">
                                                {getFileIcon()}
                                            </div>
                                            <div className="flex-1 min-w-0 space-y-3">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <h4 className="font-semibold text-base truncate">{fileName}</h4>
                                                        <Badge variant="secondary" className="text-xs font-medium">
                                                            {getFileTypeLabel()}
                                                        </Badge>
                                                    </div>
                                                    {file.size && (
                                                        <p className="text-xs text-muted-foreground font-medium">
                                                            {formatFileSize(file.size)}
                                                        </p>
                                                    )}
                                                </div>

                                                <div className="flex flex-wrap gap-2">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={async () => {
                                                            try {
                                                                if (!resolvedDownloadUrl) throw new Error('Missing download URL');
                                                                const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null;
                                                                await downloadUrlAsFile(resolvedDownloadUrl, fileName, {
                                                                    credentials: 'include',
                                                                    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                                                                });
                                                                toast.success('Descarga iniciada');
                                                            } catch (error) {
                                                                console.error('Download error:', error);
                                                                if (resolvedDownloadUrl) {
                                                                    downloadHref(resolvedDownloadUrl, fileName);
                                                                } else {
                                                                    toast.error('No se pudo descargar');
                                                                }
                                                            }
                                                        }}
                                                        className="h-9 px-4 font-medium hover:bg-primary/10"
                                                    >
                                                        <Download className="h-4 w-4 mr-2" />
                                                        Descargar
                                                    </Button>

                                                    {canPreviewFile && (
                                                        <Button
                                                            variant="default"
                                                            size="sm"
                                                            onClick={() => onDocumentPreview && onDocumentPreview({
                                                                url: previewUrl,
                                                                downloadUrl: resolvedDownloadUrl || undefined,
                                                                filename: fileName,
                                                            })}
                                                            className="h-9 px-4 font-medium shadow-sm hover:shadow-md"
                                                        >
                                                            <Eye className="h-4 w-4 mr-2" />
                                                            Previsualizar
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </Card>
                                );
                            })
                        }
                    </div>
                )}
                {/* Image gallery - ASSISTANT-only. USER messages render
                    their image attachments via the dedicated block below
                    (which already handles file.path -> backend URL). Running
                    BOTH for USER caused a duplicate render that surfaced
                    "Failed to load image" because this branch did not have
                    the file.path fallback. */}
                {((message.role === "ASSISTANT" && Array.isArray(parsedFiles) && parsedFiles.length > 0 && parsedFiles.some(isRenderableImageAttachment)) ||
                    (message.role === "ASSISTANT" && message.content.startsWith('http') &&
                        (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle') || message.content.includes('/api/images/')))) && (
                        <div className="mt-4 flex flex-wrap items-start gap-3">
                            {Array.isArray(parsedFiles) && parsedFiles.filter(isRenderableImageAttachment).map((file: any, index: number) => {
                                const src = resolveImageAttachmentUrl(file, process.env.NEXT_PUBLIC_IMAGE_URL);

                                const handleDownloadImage = () => {
                                    try {
                                        const a = document.createElement('a');
                                        a.href = src;
                                        a.download = file.name || `image-${index}.png`;
                                        document.body.appendChild(a);
                                        a.click();
                                        document.body.removeChild(a);
                                        toast.success('Image downloaded successfully!');
                                    } catch (error) {
                                        console.error('Image download failed:', error);
                                        toast.error('Failed to download image');
                                    }
                                };

                                return (
                                    <div key={index} className="relative inline-block group">
                                        {imageLoading[`file-${index}`] && (
                                            <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg">
                                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                                            </div>
                                        )}
                                        {imageError[`file-${index}`] ? (
                                            <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 text-center">
                                                <p className="text-sm text-gray-500">Failed to load image</p>
                                            </div>
                                        ) : (
                                            <>
                                                <GeneratedImageCard
                                                    file={file}
                                                    src={src}
                                                    index={index}
                                                    onOpen={setSelectedImage}
                                                    onLoad={() => {
                                                        const imgKey = `file-${index}`;
                                                        if (!imageLoadedRef.current.has(imgKey)) {
                                                            imageLoadedRef.current.add(imgKey);
                                                            setImageLoading(prev => prev[imgKey] !== false ? { ...prev, [imgKey]: false } : prev);
                                                        }
                                                    }}
                                                    onError={() => {
                                                        const imgKey = `file-${index}`;
                                                        setImageLoading(prev => ({ ...prev, [imgKey]: false }));
                                                        setImageError(prev => ({ ...prev, [imgKey]: true }));
                                                    }}
                                                />

                                                {/* Hover download button */}
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleDownloadImage();
                                                    }}
                                                    className="absolute bottom-3 right-3 z-20 h-9 w-9 rounded-full bg-white/90 text-gray-800 shadow-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 translate-x-2 group-hover:translate-x-0 hover:bg-white hover:scale-105"
                                                    title="Download image"
                                                >
                                                    <Download className="h-4 w-4" />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                            {/* Handle direct image URLs in content - don't show base64 or long URLs */}
                            {message.role === "ASSISTANT" && message.content.startsWith('http') &&
                                (message.content.includes('oaidalleapiprodscus') || message.content.includes('dalle') || message.content.includes('/api/images/')) && (
                                    <div className="relative inline-block group">
                                        {imageLoading['content-image'] && (
                                            <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg">
                                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                                            </div>
                                        )}
                                        {imageError['content-image'] ? (
                                            <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 text-center">
                                                <p className="text-sm text-gray-500">Failed to load image</p>
                                            </div>
                                        ) : (
                                            <img
                                                src={message.content}
                                                alt="Generated image"
                                                className="max-w-full h-auto rounded-lg max-h-[250px] sm:max-h-[400px] object-contain cursor-pointer hover:opacity-90 transition-opacity"
                                                loading="lazy"
                                                onClick={() => setSelectedImage(message.content)}
                                                onLoad={(e) => {
                                                    const imgKey = 'content-image';
                                                    // Only update state if image wasn't already loaded
                                                    if (!imageLoadedRef.current.has(imgKey)) {
                                                        imageLoadedRef.current.add(imgKey);
                                                        setImageLoading(prev => {
                                                            // Only update if state actually changed
                                                            if (prev[imgKey] !== false) {
                                                                return { ...prev, [imgKey]: false };
                                                            }
                                                            return prev;
                                                        });
                                                    }
                                                }}
                                                onError={() => {
                                                    setImageLoading(prev => ({ ...prev, 'content-image': false }));
                                                    setImageError(prev => ({ ...prev, 'content-image': true }));
                                                }}
                                            />
                                        )}
                                    </div>
                                )}
                        </div>
                    )}
                {/*
                  * USER-side attachment rendering.
                  *   Images  → rendered inline here (they are visual content,
                  *             not a clickable chip).
                  *   Non-images (docs, spreadsheets, PDFs, etc.) → rendered
                  *             by <MessageDocChips /> below (clickable chip
                  *             that opens UnifiedDocumentViewer).
                  *
                  * Previously this block ALSO rendered a non-image chip
                  * with a Word/PDF/Excel icon, which visually duplicated
                  * the MessageDocChips output — every uploaded .docx
                  * appeared twice in the user bubble. Removed.
                  */}
                {Array.isArray(parsedFiles) && parsedFiles.length > 0 && message.role === "USER" && (
                    <div className="flex flex-col items-end gap-2">
                        <div className="flex flex-wrap justify-end gap-2">
                            {parsedFiles
                                .filter(isRenderableImageAttachment)
                                .map((file: any, index: number) => {
                                    const imageUrl = resolveImageAttachmentUrl(file, process.env.NEXT_PUBLIC_IMAGE_URL);
                                    return (
                                        <img
                                            key={`img-${index}`}
                                            src={imageUrl}
                                            alt={file.name || file.originalName || "Image"}
                                            className="max-w-full h-auto rounded-lg max-h-[350px] object-cover cursor-pointer hover:opacity-90 transition-opacity"
                                            onClick={() => setSelectedImage(imageUrl)}
                                        />
                                    );
                                })}
                        </div>
                    </div>
                )}

            </>
        )
    };


    return (
        <div className="flex  ">
            {/* {message.role === "ASSISTANT" && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs">AI</AvatarFallback>
                </Avatar>
            )} */}

            <div className={`group flex flex-col flex-1 ${message.role === 'USER' ? 'items-end' : 'items-start'}`}>
                {message.role === 'USER' && (
                    <>
                        {hasFiles && (
                            <div className="w-full max-w-[85%] md:max-w-2xl mb-2">
                                <FileDisplay />
                            </div>
                        )}
                        {/* Document chips — clickable, open the same
                            UnifiedDocumentViewer as the composer. Filters
                            out images (FileDisplay renders them inline). */}
                        <MessageDocChips parsedFiles={parsedFiles} />

                        {hasContent && (
                            // User-message bubble — tight to content.
                            //   `w-fit`            shrinks to the natural text width
                            //   max-w[min(70%,…)]  caps at 70% of conv width / 32rem
                            //   px-3 py-1.5        snug padding (12px / 6px)
                            //   [&_p]:m-0          KILLS the `prose` <p> margins
                            //                      that were ballooning the bubble
                            //                      around short text like "hola".
                            //   rounded-br-[6px]   subtle "tail" toward sender side
                            <Card className={cn(
                                "relative w-fit max-w-[min(70%,32rem)] rounded-[16px] rounded-br-[6px]",
                                "px-3 py-1.5",
                                "bg-[#F4F4F4] text-primary dark:bg-[#1E1E1E] dark:text-white",
                                "border border-transparent shadow-none",
                                "text-[14.5px] leading-[1.5]",
                                // Wrap long tokens (pasted URLs, code strings, or
                                // long sentences in narrow split-view) instead of
                                // pushing the bubble past the pane edge.
                                "[overflow-wrap:anywhere] [word-break:break-word]",
                                // Strip prose margins so the bubble hugs the
                                // text on every line of content.
                                "[&_.prose]:!m-0 [&_p]:!my-0 [&_p:first-child]:!mt-0 [&_p:last-child]:!mb-0",
                                "[&_ul]:!my-1 [&_ol]:!my-1 [&_pre]:!my-1.5",
                            )}>
                                {isEditing ? (
                                    <div className="space-y-2 w-full min-w-[300px] md:min-w-[500px]">
                                        <Textarea
                                            value={editedContent}
                                            onChange={(e) => setEditedContent(e.target.value)}
                                            className="min-h-[80px]"
                                        />
                                        <div className="flex gap-2 justify-end">
                                            <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>Cancel</Button>
                                            <Button size="sm" onClick={handleEditSave}>Save</Button>
                                        </div>
                                    </div>
                                ) : (
                                    <MessageContent content={formatAgentTaskUserContent(message.content)} />
                                )}
                            </Card>
                        )}
                        {hasContent && !isEditing && (
                            <div className="mt-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    onClick={() => {
                                        copyMarkdownToWordClipboard(formatAgentTaskUserContent(message.content))
                                            .then(() => toast.success("Copiado con formato para Word"))
                                            .catch((err) => {
                                                console.error("[copy] failed:", err)
                                                toast.error("No se pudo copiar")
                                            })
                                    }}
                                    title="Copy"
                                >
                                    <Copy size={14} />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    onClick={() => setIsEditing(true)}
                                    title="Edit"
                                >
                                    <Pencil size={14} />
                                </Button>
                            </div>
                        )}
                    </>
                )}

                {message.role === 'ASSISTANT' && (
                    <div className="w-full max-w-[90%] md:max-w-3xl">
                        {message.error ? (
                            <ErrorMessage onRegenerate={onRegenerate} />
                        ) : isThinking ? (
                            <ThinkingPlaceholder
                                stage={(message as any).progressStage || null}
                                pct={(message as any).progressPct ?? null}
                            />
                        ) : (
                            <>
                                {hasGmailEntry ? (
                                    <>
                                        <GmailSummary message={message} />
                                        <GmailEmailsDisplay />
                                    </>
                                ) : (
                                    // For diagram (figma) responses, only show the diagram block, no text
                                    // For thesis responses, only show the thesis display, no text
                                    !hasFigmaDiagram && !getThesisData() && (() => {
                                        // If the content carries an artifact block, render the
                                        // "before" prose, then the interactive viewer, then the
                                        // "after" prose. Otherwise fall back to plain text.
                                        const parsed = extractArtifact(displayedContent || '');
                                        if (!parsed) return <MessageContent content={displayedContent} />;
                                        return (
                                            <>
                                                {parsed.before && <MessageContent content={parsed.before} />}
                                                <InteractiveArtifact
                                                    html={parsed.artifact.html}
                                                    title={parsed.artifact.title}
                                                    description={parsed.artifact.description}
                                                />
                                                {parsed.after && <MessageContent content={parsed.after} />}
                                            </>
                                        );
                                    })()
                                )}
                                <PPTDisplay />
                                <VideoDisplay />
                                <ThesisDisplay />
                                <FileDisplay />
                                <ChartDisplay files={Array.isArray(parsedFiles) ? parsedFiles : []} fullResponse={message.fullResponse} onImageClick={(url) => setSelectedImage(url)} />
                                <FigmaDiagramDisplay files={Array.isArray(parsedFiles) ? parsedFiles : []} />
                                <PlanArtifactDisplay files={Array.isArray(parsedFiles) ? parsedFiles : []} />
                                <VizArtifactDisplay files={Array.isArray(parsedFiles) ? parsedFiles : []} />
                                <DocArtifactDisplay
                                    files={Array.isArray(parsedFiles) ? parsedFiles : []}
                                    onDocumentPreview={onDocumentPreview}
                                />
                                <InteractiveArtifactDisplay files={Array.isArray(parsedFiles) ? parsedFiles : []} />
                                <GmailConnectionDisplay />
                                <GoogleServicesConnectionDisplay />
                                <SpotifyConnectionDisplay />
                                {/* Computer Use Extracted Data Display */}
                                {getComputerUseData() && (
                                    <ExtractedDataDownload
                                        extractedData={getComputerUseData()}
                                        finalUrl={getComputerUseData()?.url}
                                    />
                                )}
                                <SpotifyResultsDisplay />
                                <ComputerUseReasoningDisplay />
                                {children}
                            </>
                        )}


                        {/* Premium message action rail — every button is
                            a real, instrumented action. Visibility is
                            contextual (Copy hides on empty; Speak hides
                            on pure-code; everything hides during
                            streaming-only state). See MessageActionRail
                            for telemetry contract. */}
                        {!isVideoMessage && (
                            <MessageActionRail
                                messageId={message.id}
                                chatId={message.chatId}
                                model={(message as any).model}
                                content={stripNonCopyableArtifactBlocks(message.content || "")}
                                hasError={!!message.error}
                                isStreaming={isStreaming}
                                feedback={feedbackSent}
                                isSpeaking={isSpeaking}
                                isLoadingAudio={isLoadingAudio}
                                onCopy={handleGlobalCopy}
                                onSpeak={handleSpeak}
                                onFeedback={async (kind) => { await handleFeedback(kind) }}
                                onRegenerate={() => onRegenerate(message.id)}
                                onShare={handleShare}
                            />
                        )}
                    </div>
                )}
            </div>

            {/* {message.role === "USER" && !isImageOnlyMessage() && !isVideoMessage && (
                <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarFallback className="bg-muted text-muted-foreground text-xs">
                        {user?.name?.[0]?.toUpperCase() || 'U'}
                    </AvatarFallback>
                </Avatar>
            )} */}

            <Dialog open={!!selectedFile} onOpenChange={(isOpen) => { if (!isOpen) setSelectedFile(null) }}>
                <DialogContent className="max-w-3xl h-[80vh] flex flex-col">
                    <DialogHeader>
                        <DialogTitle>{selectedFile?.originalName || 'File Content'}</DialogTitle>
                    </DialogHeader>
                    <div className="flex-grow overflow-y-auto p-1">
                        {isContentLoading ? (
                            <div className="flex items-center justify-center h-full">
                                <ThinkingIndicator size="lg" />
                            </div>
                        ) : (
                            <pre className="text-sm whitespace-pre-wrap bg-muted p-4 rounded-md"><code>{fileContent}</code></pre>
                        )}
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button variant="outline">Close</Button>
                        </DialogClose>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!selectedFile} onOpenChange={(isOpen) => { if (!isOpen) setSelectedFile(null) }}>
                <DialogContent className="max-w-3xl h-[80vh] flex flex-col">
                    <DialogHeader>
                        <DialogTitle>{selectedFile?.originalName || 'File Content'}</DialogTitle>
                    </DialogHeader>
                    <div className="flex-grow overflow-y-auto p-1">
                        {isContentLoading ? (
                            <div className="flex items-center justify-center h-full">
                                <ThinkingIndicator size="lg" />
                            </div>
                        ) : (
                            <pre className="text-sm whitespace-pre-wrap bg-muted p-4 rounded-md"><code>{fileContent}</code></pre>
                        )}
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button variant="outline">Close</Button>
                        </DialogClose>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {isTableExpanded && (
                <div className="fixed inset-0 bg-background z-50 p-4 flex flex-col">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-bold">{tableTitle || 'Expanded Table View'}</h2>
                        <Button variant="outline" onClick={() => setIsTableExpanded(false)}>Close</Button>
                    </div>
                    <div className="flex-grow overflow-auto border rounded-md">
                        <div className="overflow-x-auto overflow-y-auto h-full">
                            <table className="w-full border-collapse border border-muted" style={{ minWidth: 'max-content' }}>
                                <thead className="sticky top-0 bg-background">
                                    <tr>
                                        {tableHeaders.map((header, index) => (
                                            <th key={index} className="border border-muted px-4 py-3 bg-muted/50 text-left font-medium text-sm whitespace-nowrap min-w-[120px]">{header}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {tableData.map((row, rowIndex) => (
                                        <tr key={rowIndex} className="hover:bg-muted/20">
                                            {row.map((cell, cellIndex) => (
                                                <td key={cellIndex} className="border border-muted px-4 py-3 text-sm whitespace-nowrap min-w-[120px]">{cell}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* Image Lightbox Modal - ChatGPT style */}
            {selectedImage && (
                <div 
                    className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4"
                    onClick={() => setSelectedImage(null)}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                            setSelectedImage(null);
                        }
                    }}
                >
                    <button
                        onClick={() => setSelectedImage(null)}
                        className="absolute top-4 right-4 z-10 text-white hover:text-gray-300 transition-colors bg-black/50 rounded-full p-2 hover:bg-black/70"
                        aria-label="Close image viewer"
                    >
                        <X className="h-6 w-6" />
                    </button>
                    <div 
                        className="max-w-[90vw] max-h-[90vh] flex items-center justify-center"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <img
                            src={selectedImage}
                            alt="Full size image"
                            className="max-w-full max-h-[90vh] object-contain rounded-lg"
                            onClick={(e) => e.stopPropagation()}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};
const areMessagePropsEqual = (prev: any, next: any) => {
    const a = prev.message
    const b = next.message
    if (a.id !== b.id) return false
    if (a.content !== b.content) return false

    const af = typeof a.files === 'string' ? a.files : JSON.stringify(a.files || [])
    const bf = typeof b.files === 'string' ? b.files : JSON.stringify(b.files || [])
    if (af !== bf) return false

    // Ignore parent re-renders from user, callbacks (they’re stable from context)
    return true
}

export default React.memo(MessageComponent, areMessagePropsEqual)
