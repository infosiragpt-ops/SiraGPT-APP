"use client"

import { useState } from 'react';
import { ChevronLeft, ChevronRight, Download, X, Loader2, FileText } from 'lucide-react';
import { Button } from './ui/button';

// Define the structure of a slide and presentation
interface Slide {
    title: string;
    content?: string[];
    subtitle?: string;
    layout?: string;
    type?: string;
    leftContent?: string[];
    rightContent?: string[];
    imagePrompt?: string;
    imageUrl?: string;
}

interface Presentation {
    title: string;
    slides: Slide[];
    filename: string;
}

interface PresentationViewProps {
    presentation?: Presentation | null;
    onClose: () => void;
    isLoading: boolean;
}

export function PresentationView({ presentation, onClose, isLoading }: PresentationViewProps) {
    const [currentSlide, setCurrentSlide] = useState(0);
    const [isDownloading, setIsDownloading] = useState(false);

    if (isLoading) {
        return (
            <div className="w-full h-full bg-background flex flex-col items-center justify-center">
                <Loader2 className="w-12 h-12 animate-spin text-primary mb-4" />
                <h2 className="text-2xl font-semibold mb-2">Generating Presentation...</h2>
                <p className="text-muted-foreground">Please wait while we create your slides.</p>
            </div>
        );
    }

    if (!presentation) {
        return (
            <div className="w-full h-full bg-background flex flex-col items-center justify-center">
                <FileText className="w-12 h-12 text-muted-foreground mb-4" />
                <h2 className="text-2xl font-semibold mb-2">No Presentation Loaded</h2>
                <p className="text-muted-foreground">The presentation data is not available.</p>
                <Button onClick={onClose} className="mt-4">Close</Button>
            </div>
        );
    }

    const totalSlides = presentation.slides.length;

    const nextSlide = () => {
        if (currentSlide < totalSlides - 1) {
            setCurrentSlide(currentSlide + 1);
        }
    };

    const prevSlide = () => {
        if (currentSlide > 0) {
            setCurrentSlide(currentSlide - 1);
        }
    };

    const handleDownloadPPT = async () => {
        setIsDownloading(true);
        try {
            const baseUrl = process.env.NEXT_PUBLIC_IMAGE_URL || 'http://localhost:5000';
            const url = `${baseUrl}/uploads/presentations/${presentation.filename}`;
            const a = document.createElement('a');
            a.href = url;
            a.download = presentation.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (error) {
            console.error('Error downloading presentation:', error);
            alert('Failed to download presentation. Please try again.');
        } finally {
            setIsDownloading(false);
        }
    };

    const downloadAsHTML = () => {
        const baseUrl = process.env.NEXT_PUBLIC_IMAGE_URL || 'http://localhost:5000';
        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${presentation.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', 'Calibri', 'Helvetica Neue', sans-serif; background-color: #f0f0f0; }
    .slide {
      width: 960px;
      height: 540px;
      margin: 20px auto;
      background-color: white;
      border: 1px solid #ccc;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      padding: 40px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .title-slide { text-align: center; }
    h1 { font-size: 38px; color: #1e3a8a; margin-bottom: 12px; }
    h2 { font-size: 24px; color: #1e3a8a; margin-bottom: 18px; padding-bottom: 6px; border-bottom: 2px solid #dbeafe; }
    ul { list-style: none; padding-left: 0; }
    li { font-size: 14px; color: #334155; margin-bottom: 8px; padding-left: 22px; position: relative; line-height: 1.2; }
    li:before { content: "▪"; position: absolute; left: 0; font-size: 20px; color: #3b82f6; }
    .two-column .columns { display: flex; justify-content: space-between; gap: 20px; }
    .two-column .column { flex: 1; }
  </style>
</head>
<body>
  <div class="slide title-slide">
    <h1>${presentation.title}</h1>
    <p style="font-size: 18px; color: #64748b;">AI Generated Professional Presentation</p>
  </div>
  ${presentation.slides.map(slide => {
            if (slide.type === 'two-column') {
                return `
      <div class="slide two-column">
        <h2>${slide.title}</h2>
        <div class="columns">
          <div class="column">
            <ul>${(slide.leftContent || []).map(point => `<li>${point}</li>`).join('')}</ul>
          </div>
          <div class="column">
            <ul>${(slide.rightContent || []).map(point => `<li>${point}</li>`).join('')}</ul>
          </div>
        </div>
      </div>`;
            } else if (slide.type === 'content-with-image') {
                return `
      <div class="slide two-column">
        <h2>${slide.title}</h2>
        <div class="columns">
          <div class="column">
            <ul>${(slide.content || []).map(point => `<li>${point}</li>`).join('')}</ul>
          </div>
          <div class="column">
            ${slide.imageUrl ? `<img src="${baseUrl}${slide.imageUrl}" style="max-width: 100%; max-height: 100%; object-fit: contain;">` : ''}
          </div>
        </div>
      </div>`;
            }
            return `
    <div class="slide">
      <h2>${slide.title}</h2>
      <ul>
        ${(slide.content || []).map(point => `<li>${point}</li>`).join('')}
      </ul>
    </div>`;
        }).join('')}
</body>
</html>`;

        const blob = new Blob([htmlContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${presentation.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const slide = presentation.slides[currentSlide];
    const titleSlide = presentation.slides.find(s => s.layout === 'title-slide' || s.type === 'title');

    return (
        <div className="w-full h-full bg-background flex flex-col">
            {/* Header */}
            <div className="bg-slate-800/80 backdrop-blur-lg border-b border-slate-700 px-4 py-3 flex items-center justify-between text-white">
                <h1 className="text-lg font-bold truncate">{presentation.title}</h1>
                <div className="flex items-center gap-2">
                    <Button onClick={handleDownloadPPT} disabled={isDownloading} size="sm" variant="secondary">
                        <Download className="w-4 h-4 mr-2" />
                        PowerPoint
                    </Button>
                    <Button onClick={downloadAsHTML} size="sm" variant="secondary">
                        <Download className="w-4 h-4 mr-2" />
                        HTML
                    </Button>
                    <Button onClick={onClose} size="icon" variant="ghost">
                        <X className="w-5 h-5" />
                    </Button>
                </div>
            </div>

            {/* Slide Content */}
            <div className="flex-1 flex items-center justify-center p-4">
                <div className="w-full max-w-5xl aspect-video bg-white rounded-lg shadow-2xl overflow-hidden flex flex-col">
                    {currentSlide === 0 && titleSlide ? (
                        <div className="h-full flex flex-col justify-center items-center text-center p-8">
                            <h1 className="text-4xl font-bold text-blue-900 mb-3">{titleSlide.title}</h1>
                            {titleSlide.subtitle && (
                                <p className="text-xl text-slate-500">{titleSlide.subtitle}</p>
                            )}
                        </div>
                    ) : (
                        <div className="h-full flex flex-col p-6 text-slate-800">
                            <h2 className="text-2xl font-bold mb-3 text-blue-900 pb-2 border-b-2 border-blue-100 flex-shrink-0">{slide.title}</h2>
                            <div className="flex-1 overflow-hidden">
                                {slide.type === 'two-column' ? (
                                    <div className="grid grid-cols-2 gap-4 h-full">
                                        <div>
                                            <ul className="space-y-1">
                                                {slide.leftContent?.map((point, idx) => (
                                                    <li key={`left-${idx}`} className="flex items-start gap-2">
                                                        <span className="text-blue-500 font-bold text-base mt-1">▪</span>
                                                        <span className="text-sm text-slate-700 leading-normal">{point}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                        <div>
                                            <ul className="space-y-1">
                                                {slide.rightContent?.map((point, idx) => (
                                                    <li key={`right-${idx}`} className="flex items-start gap-2">
                                                        <span className="text-blue-500 font-bold text-base mt-1">▪</span>
                                                        <span className="text-sm text-slate-700 leading-normal">{point}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    </div>
                                ) : slide.type === 'content-with-image' ? (
                                    <div className="grid grid-cols-2 gap-4 h-full">
                                        <div>
                                            <ul className="space-y-1">
                                                {slide.content?.map((point, idx) => (
                                                    <li key={`content-${idx}`} className="flex items-start gap-2">
                                                        <span className="text-blue-500 font-bold text-base mt-1">▪</span>
                                                        <span className="text-sm text-slate-700 leading-normal">{point}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                        <div className="flex items-start justify-center bg-slate-100 rounded-lg pt-4">
                                            {slide.imageUrl ? (
                                                <img src={`${process.env.NEXT_PUBLIC_IMAGE_URL || 'http://localhost:5000'}${slide.imageUrl}`} alt={slide.title} className="max-h-full max-w-full object-contain rounded-lg" />
                                            ) : (
                                                <div className="text-slate-400">Image loading...</div>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <ul className="space-y-2">
                                        {slide.content?.map((point, idx) => (
                                            <li key={idx} className="flex items-start gap-2">
                                                <span className="text-blue-500 font-bold text-base mt-1">▪</span>
                                                <span className="text-sm text-slate-700 leading-normal">{point}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Footer / Navigation */}
            <div className="bg-slate-800/80 backdrop-blur-lg border-t border-slate-700 px-6 py-4 flex items-center justify-between">
                <Button onClick={prevSlide} disabled={currentSlide === 0}>
                    <ChevronLeft className="w-5 h-5 mr-2" />
                    Previous
                </Button>
                <div className="text-slate-300 font-medium">
                    Slide {currentSlide + 1} of {totalSlides}
                </div>
                <Button onClick={nextSlide} disabled={currentSlide >= totalSlides - 1}>
                    Next
                    <ChevronRight className="w-5 h-5 ml-2" />
                </Button>
            </div>
        </div>
    );
}
