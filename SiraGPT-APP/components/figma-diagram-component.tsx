"use client"

import * as React from "react"
import { ExternalLink, Edit, Copy, Check, ZoomIn, Download } from "lucide-react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
// Mermaid is ~600KB. Load it on demand only when we actually need to
// render a diagram client-side (image fallback path doesn't need it).
import { ImageModal } from "@/components/ui/image-modal"

let _mermaidPromise: Promise<typeof import("mermaid").default> | null = null
function loadMermaid() {
    if (!_mermaidPromise) {
        _mermaidPromise = import("mermaid").then((m) => m.default)
    }
    return _mermaidPromise
}

interface FigmaDiagramProps {
    mermaidCode?: string
    imageUrl?: string
    figmaFile?: {
        fileKey?: string
        fileUrl?: string
        editUrl?: string
    }
    embedUrl?: string
    title?: string
}

export function FigmaDiagramComponent({
    mermaidCode,
    imageUrl,
    figmaFile,
    embedUrl,
    title = "Flowchart Diagram"
}: FigmaDiagramProps) {
    const [displayMode, setDisplayMode] = React.useState<'image' | 'mermaid'>('image')
    const [mermaidSvg, setMermaidSvg] = React.useState<string | null>(null)
    const [isLoading, setIsLoading] = React.useState(true)
    const [isModalOpen, setIsModalOpen] = React.useState(false)
    const mermaidContainerRef = React.useRef<HTMLDivElement>(null)


    const handleDownload = async () => {
        if (!imageUrl) {
            toast.error("No image available to download.")
            return
        }
        try {
            const response = await fetch(imageUrl)
            const blob = await response.blob()
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = `${title.replace(/[^a-zA-Z0-9]/g, '_') || 'diagram'}.png`
            document.body.appendChild(a)
            a.click()
            window.URL.revokeObjectURL(url)
            document.body.removeChild(a)
            toast.success("Diagrama descargado")
        } catch (error) {
            console.error("Error downloading image:", error)
            toast.error("No se pudo descargar el diagrama.")
        }
    }

    // Initialize Mermaid only once — and only on the client, lazily.
    React.useEffect(() => {
        let cancelled = false
        // Only pay the mermaid chunk cost when we don't have an
        // image URL ready to render (image path bypasses mermaid).
        if (imageUrl) return
        loadMermaid().then((mermaid) => {
            if (cancelled) return
            mermaid.initialize({
                startOnLoad: false, // We'll render manually
                theme: 'default',
                securityLevel: 'loose',
                flowchart: {
                    useMaxWidth: true,
                    htmlLabels: true,
                    curve: 'basis'
                }
            })
        }).catch(() => { /* mermaid optional */ })
        return () => { cancelled = true }
    }, [imageUrl])

    // Try to render Mermaid if code is available, but prefer image
    React.useEffect(() => {
        // Prefer image URL if available (safer and faster)
        if (imageUrl) {
            setDisplayMode('image')
            setIsLoading(false)
            return
        }

        // If no image but we have Mermaid code, try to render it
        if (mermaidCode && !imageUrl) {
            setDisplayMode('mermaid')
            const renderMermaid = async () => {
                try {
                    setIsLoading(true)
                    const mermaid = await loadMermaid()
                    const uniqueId = `mermaid-diagram-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
                    const { svg } = await mermaid.render(uniqueId, mermaidCode)
                    setMermaidSvg(svg)
                    setIsLoading(false)
                } catch (error) {
                    console.error('Error rendering Mermaid:', error)
                    setIsLoading(false)
                    // If Mermaid fails, we'll show nothing (or could show error message)
                }
            }
            renderMermaid()
        } else {
            setIsLoading(false)
        }
    }, [mermaidCode, imageUrl])



    const openInFigma = () => {
        if (figmaFile?.editUrl) {
            window.open(figmaFile.editUrl, '_blank')
        } else if (figmaFile?.fileUrl) {
            window.open(figmaFile.fileUrl, '_blank')
        }
    }

    const openMermaidEditor = () => {
        if (mermaidCode) {
            const payload = {
                code: mermaidCode,
                mermaid: { theme: 'default' },
            };
            const encodedPayload = btoa(JSON.stringify(payload));
            const url = `https://mermaid.live/edit#base64:${encodedPayload}`;
            window.open(url, '_blank');
        }
    }

    return (
        <Card className="w-full my-4 overflow-hidden border-2 border-gray-200 dark:border-gray-800 shadow-lg rounded-xl">
            <CardHeader className="bg-gray-50 dark:bg-gray-900/50 p-4 border-b border-gray-200 dark:border-gray-800">
                <div className="flex items-center justify-between">
                    <div>
                        <CardTitle className="text-xl font-bold tracking-tight">{title}</CardTitle>
                        <CardDescription className="text-gray-500 dark:text-gray-400">
                            Interactive Diagram
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="p-0 relative group bg-gray-50 dark:bg-gray-900/30">
                {/* Hover buttons - positioned top right */}
                <div className="absolute top-3 right-3 z-20 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-x-2 group-hover:translate-x-0 pointer-events-none">
                    {imageUrl && (
                        <Button
                            variant="secondary"
                            size="icon"
                            onClick={(e) => {
                                e.stopPropagation()
                                handleDownload()
                            }}
                            className="h-9 w-9 rounded-full bg-white/90 dark:bg-zinc-800/90 hover:bg-white dark:hover:bg-zinc-700 text-gray-800 dark:text-zinc-200 shadow-lg hover:scale-105 transition-transform pointer-events-auto"
                            title="Download Diagram"
                        >
                            <Download className="h-4 w-4" />
                        </Button>
                    )}
                    {embedUrl && (
                        <Button
                            variant="secondary"
                            size="icon"
                            onClick={(e) => {
                                e.stopPropagation()
                                openMermaidEditor()
                            }}
                            className="h-9 w-9 rounded-full bg-white/90 dark:bg-zinc-800/90 hover:bg-white dark:hover:bg-zinc-700 text-gray-800 dark:text-zinc-200 shadow-lg hover:scale-105 transition-transform pointer-events-auto"
                            title="Edit Diagram"
                        >
                            <Edit className="h-4 w-4" />
                        </Button>
                    )}
                    {figmaFile && (
                        <Button
                            variant="secondary"
                            size="icon"
                            onClick={(e) => {
                                e.stopPropagation()
                                openInFigma()
                            }}
                            className="h-9 w-9 rounded-full bg-white/90 dark:bg-zinc-800/90 hover:bg-white dark:hover:bg-zinc-700 text-gray-800 dark:text-zinc-200 shadow-lg hover:scale-105 transition-transform pointer-events-auto"
                            title="Open in Figma"
                        >
                            <ExternalLink className="h-4 w-4" />
                        </Button>
                    )}
                </div>

                <div className="relative w-full flex justify-center items-center min-h-[200px] bg-white dark:bg-gray-800/50 p-4">
                    {isLoading ? (
                        <div className="flex flex-col items-center gap-2 text-gray-500 dark:text-gray-400 min-h-[400px]">
                            <ThinkingIndicator size="lg" label="Renderizando diagrama…" />
                            <span>Renderizando diagrama…</span>
                        </div>
                    ) : displayMode === 'image' && imageUrl ? (
                        <>
                            <button
                                onClick={() => setIsModalOpen(true)}
                                className="w-full flex justify-center cursor-zoom-in hover:opacity-95 transition-opacity"
                            >
                                {/* eslint-disable-next-line @next/next/no-img-element -- diagram URL comes from mermaid.ink or user backend; project uses images.unoptimized=true. */}
                                <img
                                    src={imageUrl}
                                    alt="Flowchart Diagram"
                                    className="w-full h-auto rounded-lg object-contain"
                                    style={{ minHeight: '300px', maxHeight: '800px' }}
                                    onError={() => {
                                        if (mermaidCode && displayMode === 'image') {
                                            setDisplayMode('mermaid')
                                        }
                                    }}
                                />
                            </button>
                            <ImageModal
                                isOpen={isModalOpen}
                                onClose={() => setIsModalOpen(false)}
                                imageUrl={imageUrl}
                                altText="Flowchart Diagram"
                            />
                        </>
                    ) : displayMode === 'mermaid' && mermaidSvg ? (
                        <div
                            ref={mermaidContainerRef}
                            className="mermaid-container w-full [&>svg]:w-full"
                            style={{ maxHeight: '700px' }}
                            dangerouslySetInnerHTML={{ __html: mermaidSvg }}
                        />
                    ) : (
                        <div className="text-gray-500 dark:text-gray-400">No diagram available</div>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

// Component to display Figma diagram from message files
// Memoized — `files` array reference is stable per message so we can
// skip re-rendering the (heavy) FigmaDiagramComponent on unrelated
// parent updates.
function FigmaDiagramDisplayImpl({ files }: { files: any[] }) {
    const figmaFile = React.useMemo(
        () => (Array.isArray(files) ? files.find(f => f?.type === 'figma') : null),
        [files]
    )

    if (!figmaFile) return null

    return (
        <FigmaDiagramComponent
            mermaidCode={figmaFile.mermaidCode}
            imageUrl={figmaFile.imageUrl}
            figmaFile={figmaFile.figmaFile}
            embedUrl={figmaFile.embedUrl}
            title={figmaFile.title || "Flowchart Diagram"}
        />
    )
}

export const FigmaDiagramDisplay = React.memo(FigmaDiagramDisplayImpl)