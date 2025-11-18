"use client"

import * as React from "react"
import { ExternalLink, Edit, Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import mermaid from "mermaid"

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
    const mermaidContainerRef = React.useRef<HTMLDivElement>(null)
   

    // Initialize Mermaid only once
    React.useEffect(() => {
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
    }, [])

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
                    <div className="flex gap-2">
                         
                        {embedUrl && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={openMermaidEditor}
                                className="gap-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                                <Edit className="h-5 w-5" />
                                <span>Edit</span>
                            </Button>
                        )}
                        {figmaFile && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={openInFigma}
                                className="gap-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                                <ExternalLink className="h-5 w-5" />
                                <span>Open in Figma</span>
                            </Button>
                        )}
                    </div>
                </div>
            </CardHeader>
            <CardContent className="p-0">
               
               
                    <div className="relative w-full flex justify-center items-center min-h-[400px] bg-gray-100 dark:bg-gray-900/50 p-6">
                        {isLoading ? (
                            <div className="flex flex-col items-center gap-2 text-gray-500 dark:text-gray-400">
                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-gray-100"></div>
                                <span>Rendering diagram...</span>
                            </div>
                        ) : displayMode === 'image' && imageUrl ? (
                            <div className="w-full flex justify-center">
                                <img
                                    src={imageUrl}
                                    alt="Flowchart Diagram"
                                    className="max-w-full w-auto h-auto rounded-lg object-contain shadow-md"
                                    style={{ maxHeight: '700px' }}
                                    onError={() => {
                                        if (mermaidCode && displayMode === 'image') {
                                            setDisplayMode('mermaid')
                                        }
                                    }}
                                />
                            </div>
                        ) : displayMode === 'mermaid' && mermaidSvg ? (
                            <div
                                ref={mermaidContainerRef}
                                className="mermaid-container w-full"
                                style={{ display: 'flex', justifyContent: 'center' }}
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
export function FigmaDiagramDisplay({ files }: { files: any[] }) {
    const figmaFile = files.find(f => f.type === 'figma')
    
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
