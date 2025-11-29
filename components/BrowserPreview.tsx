"use client";

import React, { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalLink, Eye, EyeOff, Monitor } from 'lucide-react';

interface Screenshot {
  source: string;
  filename: string;
  url: string;
  timestamp: string;
}

interface BrowserPreviewProps {
  sessionId: string;
  currentSource?: string;
  currentUrl?: string;
  currentScreenshot?: string;
  screenshots: Screenshot[];
}

export default function BrowserPreview({
  sessionId,
  currentSource,
  currentUrl,
  currentScreenshot,
  screenshots = []
}: BrowserPreviewProps) {
  const [showPreview, setShowPreview] = useState(true);
  const [selectedScreenshot, setSelectedScreenshot] = useState<Screenshot | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());

  // Auto-select the latest screenshot
  useEffect(() => {
    if (currentScreenshot && screenshots.length > 0) {
      const latest = screenshots.find(s => s.filename === currentScreenshot);
      if (latest) {
        setSelectedScreenshot(latest);
      }
    } else if (screenshots.length > 0 && !selectedScreenshot) {
      // Select first screenshot if none selected
      setSelectedScreenshot(screenshots[screenshots.length - 1]);
    }
  }, [currentScreenshot, screenshots, selectedScreenshot]);

  if (!showPreview && screenshots.length === 0 && !currentSource) {
    return null;
  }

  const getScreenshotUrl = (filename: string) => {
    const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
    return `${backendUrl}/thesis/screenshots/${sessionId}/${filename}`;
  };

  const handleImageError = (filename: string) => {
    setImageErrors(prev => new Set([...prev, filename]));
  };

  // Debug information
  console.log('BrowserPreview Debug:', { 
    sessionId, 
    currentSource, 
    screenshots: screenshots.length, 
    selectedScreenshot: selectedScreenshot?.source,
    showPreview,
    sampleUrl: screenshots.length > 0 ? getScreenshotUrl(screenshots[0].filename) : 'N/A'
  });

  return (
    <div className="mb-4 space-y-3">
      {/* Browser Activity Header */}
      <div className="flex items-center justify-between p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-blue-600" />
          <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
            Browser Activity
          </span>
          {currentSource && (
            <Badge variant="outline" className="text-xs">
              Searching {currentSource}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowPreview(!showPreview)}
          className="h-8 w-8 p-0"
        >
          {showPreview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>

      {/* Current Activity */}
      {currentSource && showPreview && (
        <div className="text-sm text-gray-600 dark:text-gray-400 px-3">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            Currently searching: <strong>{currentSource}</strong>
          </div>
          {currentUrl && (
            <div className="mt-1 flex items-center gap-1">
              <ExternalLink className="h-3 w-3" />
              <a 
                href={currentUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-xs truncate max-w-md"
              >
                {currentUrl}
              </a>
            </div>
          )}
        </div>
      )}

      {/* Screenshot Preview */}
      {showPreview && selectedScreenshot && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="relative">
              {!imageErrors.has(selectedScreenshot.filename) ? (
                <img
                  src={getScreenshotUrl(selectedScreenshot.filename)}
                  alt={`Screenshot of ${selectedScreenshot.source}`}
                  className="w-full h-48 object-cover object-top"
                  onError={() => handleImageError(selectedScreenshot.filename)}
                />
              ) : (
                <div className="w-full h-48 bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                  <div className="text-center">
                    <Monitor className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">Screenshot not available</p>
                    <p className="text-xs text-gray-400">{selectedScreenshot.source}</p>
                  </div>
                </div>
              )}
              <div className="absolute top-2 left-2 bg-black/70 text-white px-2 py-1 rounded text-xs">
                {selectedScreenshot.source}
              </div>
              <div className="absolute top-2 right-2 flex gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const url = getScreenshotUrl(selectedScreenshot.filename);
                    console.log('Testing screenshot URL:', url);
                    window.open(url, '_blank');
                  }}
                  className="h-8 px-2"
                  title="Test screenshot URL"
                >
                  🔗
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.open(selectedScreenshot.url, '_blank')}
                  className="h-8 px-2"
                  title="Open source website"
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Screenshot History */}
      {showPreview && screenshots.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300 px-3">
            Search History ({screenshots.length} sources)
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2 px-3">
            {screenshots.map((screenshot, index) => (
              <button
                key={screenshot.filename}
                onClick={() => setSelectedScreenshot(screenshot)}
                className={`flex-shrink-0 p-2 rounded-lg border transition-colors text-xs ${
                  selectedScreenshot?.filename === screenshot.filename
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <span className="whitespace-nowrap">{screenshot.source}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {new Date(screenshot.timestamp).toLocaleTimeString()}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}