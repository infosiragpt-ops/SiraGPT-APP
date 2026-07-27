"use client"

import React from 'react'
import { Download, ExternalLink, FileText, Code, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getNormalizedApiBaseUrl } from '@/lib/api'
import { authenticatedFetch } from '@/lib/authenticated-fetch'
import { devLog, devWarn } from '@/lib/dev-log'

interface ExtractedDataDownloadProps {
  extractedData: {
    success: boolean
    url: string
    title: string
    extractedInfo: string
    rawContent?: string
    metaData?: any
    timestamp: string
    userQuery: string
    error?: string
  }
  finalUrl?: string
}

const ExtractedDataDownload: React.FC<ExtractedDataDownloadProps> = ({ 
  extractedData, 
  finalUrl 
}) => {
const downloadAsHtml = async () => {
    let htmlContent;
    
    try {
      // Try to get AI-generated HTML from backend
      const backendUrl = getNormalizedApiBaseUrl();
      const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null;
      const response = await authenticatedFetch(`${backendUrl}/computer-use/generate-html`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ 
          extractedData: {
            ...extractedData,
            userQuery: extractedData.userQuery || 'Computer Use Task'
          }
        })
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          htmlContent = result.htmlContent;
          devLog('Using AI-generated HTML report');
        } else {
          devWarn('Backend API failed, using fallback');
          htmlContent = generateHtmlReport(extractedData);
        }
      } else {
        devWarn('Backend API error, using fallback');
        htmlContent = generateHtmlReport(extractedData);
      }
    } catch (error) {
      console.warn('⚠️ Failed to connect to backend, using fallback:', error);
      htmlContent = generateHtmlReport(extractedData);
    }

    downloadFile(htmlContent, `computer-use-report-${Date.now()}.html`, 'text/html');
  }

  const downloadFile = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const generateHtmlReport = (data: any) => {
    // Enhanced content parsing to create interactive HTML structure
    const content = data.extractedInfo || data.rawContent || 'No content extracted';
    
    // Advanced content detection and structuring
    let structuredContent = content;
    
    // Enhanced detection for different content types
    if (content.includes('Price:') || content.includes('Features:') || content.includes('$') || 
        content.includes('Job:') || content.includes('Company:') || content.includes('Salary:') ||
        content.includes('Location:') || content.includes('Experience:') || content.includes('LinkedIn')) {
      
      const lines = content.split('\n').filter((line: string) => line.trim());
      let htmlContent = '<div class="content-grid">';
      let currentItem = '';
      let itemType = 'product';
      
      // Detect content type for appropriate styling
      if (content.toLowerCase().includes('job') || content.toLowerCase().includes('linkedin') || 
          content.toLowerCase().includes('career') || content.toLowerCase().includes('developer') ||
          content.toLowerCase().includes('position') || content.toLowerCase().includes('remote')) {
        itemType = 'job';
      }
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && trimmedLine.length > 3) {
          // Enhanced parsing for different data types
          if (trimmedLine.includes('Price:') || trimmedLine.includes('$')) {
            if (currentItem) {
              htmlContent += `<div class="item-card ${itemType}-card">${currentItem}</div>`;
              currentItem = '';
            }
            currentItem += `<div class="price-tag">💰 ${trimmedLine}</div>`;
          } 
          else if (trimmedLine.includes('Job:') || trimmedLine.includes('Position:') || trimmedLine.includes('Title:')) {
            if (currentItem) {
              htmlContent += `<div class="item-card ${itemType}-card">${currentItem}</div>`;
              currentItem = '';
            }
            currentItem += `<div class="job-title">💼 ${trimmedLine}</div>`;
          }
          else if (trimmedLine.includes('Company:') || trimmedLine.includes('Employer:')) {
            currentItem += `<div class="company">🏢 ${trimmedLine}</div>`;
          }
          else if (trimmedLine.includes('Location:') || trimmedLine.includes('Remote') || trimmedLine.includes('Hybrid')) {
            currentItem += `<div class="location">📍 ${trimmedLine}</div>`;
          }
          else if (trimmedLine.includes('Salary:') || trimmedLine.includes('Pay:') || trimmedLine.includes('/year') || 
                   trimmedLine.includes('/hour') || trimmedLine.includes('compensation')) {
            currentItem += `<div class="salary">💵 ${trimmedLine}</div>`;
          }
          else if (trimmedLine.includes('Experience:') || trimmedLine.includes('Level:') || 
                   trimmedLine.includes('years') || trimmedLine.includes('Senior') || trimmedLine.includes('Junior')) {
            currentItem += `<div class="experience">📈 ${trimmedLine}</div>`;
          }
          else if (trimmedLine.includes('Features:') || trimmedLine.includes('Specifications:') || 
                   trimmedLine.includes('Requirements:') || trimmedLine.includes('Skills:')) {
            currentItem += `<div class="features">✨ ${trimmedLine}</div>`;
          } 
          else if (trimmedLine.includes('Rating:') || trimmedLine.includes('⭐') || trimmedLine.includes('Reviews:')) {
            currentItem += `<div class="rating">⭐ ${trimmedLine}</div>`;
          } 
          else if (trimmedLine.startsWith('http') || trimmedLine.includes('.com') || trimmedLine.includes('linkedin.com')) {
            const displayUrl = trimmedLine.length > 60 ? trimmedLine.substring(0, 60) + '...' : trimmedLine;
            currentItem += `<div class="action-link">
              <a href="${trimmedLine}" target="_blank" class="interactive-btn">
                🔗 ${displayUrl}
                <span class="btn-text">Click to Open</span>
              </a>
            </div>`;
          } 
          else if (trimmedLine.length > 5) {
            currentItem += `<div class="item-description">${trimmedLine}</div>`;
          }
        }
      }
      
      if (currentItem) {
        htmlContent += `<div class="item-card ${itemType}-card">${currentItem}</div>`;
      }
      htmlContent += '</div>';
      
      if (htmlContent.includes('<div class="item-card')) {
        structuredContent = htmlContent;
      }
    } else {
      // Enhanced regular content formatting
      structuredContent = content
        .split('\n')
        .map((line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return '<br>';
          
          // Enhanced URL handling
          if (trimmed.startsWith('http') || trimmed.includes('.com')) {
            const displayUrl = trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
            return `<div class="url-section">
              <a href="${trimmed}" target="_blank" class="interactive-btn">
                🔗 ${displayUrl}
                <span class="btn-text">Visit Link</span>
              </a>
            </div>`;
          }
          
          // Format section headers
          if (trimmed.includes(':') && trimmed.length < 100 && !trimmed.includes('http')) {
            return `<h3 class="content-header">${trimmed}</h3>`;
          }
          
          return `<p class="content-text">${trimmed}</p>`;
        })
        .join('');
    }
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Computer Use Extraction Report - ${data.userQuery}</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            max-width: 1200px; 
            margin: 0 auto; 
            padding: 20px; 
            line-height: 1.6; 
            background: #f8f9fa; 
            color: #333;
        }
        .container { 
            background: white; 
            padding: 40px; 
            border-radius: 12px; 
            box-shadow: 0 4px 20px rgba(0,0,0,0.1); 
        }
        .header { 
            border-bottom: 3px solid #007bff; 
            padding-bottom: 25px; 
            margin-bottom: 35px; 
            text-align: center;
        }
        .meta-info { 
            background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
            padding: 25px; 
            border-radius: 10px; 
            margin: 25px 0; 
            border-left: 5px solid #2196f3;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
        }
        .content { 
            margin: 35px 0; 
            min-height: 200px;
        }
        .content-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 24px;
            margin: 25px 0;
        }
        .item-card {
            background: linear-gradient(135deg, #ffffff 0%, #f8f9ff 100%);
            border: 2px solid #e3e8ff;
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.08);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }
        .item-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 8px 30px rgba(0,0,0,0.12);
            border-color: #1976d2;
        }
        .job-card {
            border-color: #e8f5e8;
            background: linear-gradient(135deg, #ffffff 0%, #f0fff0 100%);
        }
        .job-card:hover {
            border-color: #4caf50;
        }
        .item-description, .item-name {
            font-weight: 600;
            font-size: 1.15em;
            margin-bottom: 12px;
            color: #2c3e50;
            line-height: 1.4;
        }
        .job-title {
            background: linear-gradient(135deg, #1976d2 0%, #42a5f5 100%);
            color: white;
            font-size: 1.2em;
            font-weight: 700;
            margin: -10px -10px 15px -10px;
            padding: 15px 20px;
            border-radius: 12px 12px 0 0;
            text-shadow: 0 1px 2px rgba(0,0,0,0.2);
        }
        .price-tag {
            background: linear-gradient(135deg, #d32f2f 0%, #f44336 100%);
            color: white;
            font-size: 1.25em;
            font-weight: 700;
            margin: -10px -10px 15px -10px;
            padding: 15px 20px;
            border-radius: 12px 12px 0 0;
            text-shadow: 0 1px 2px rgba(0,0,0,0.2);
        }
        .company {
            color: #1565c0;
            margin: 12px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
            border-radius: 8px;
            font-weight: 500;
            border-left: 4px solid #1976d2;
        }
        .location {
            color: #2e7d32;
            margin: 12px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #e8f5e8 0%, #f1f8e9 100%);
            border-radius: 8px;
            font-weight: 500;
            border-left: 4px solid #4caf50;
        }
        .salary {
            color: #f57c00;
            margin: 12px 0;
            padding: 12px 15px;
            background: linear-gradient(135deg, #fff3e0 0%, #ffe8cc 100%);
            border-radius: 8px;
            font-weight: 600;
            font-size: 1.05em;
            border-left: 4px solid #ff9800;
        }
        .experience {
            color: #7b1fa2;
            margin: 12px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #f3e5f5 0%, #fce4ec 100%);
            border-radius: 8px;
            font-weight: 500;
            border-left: 4px solid #9c27b0;
        }
        .features {
            color: #1976d2;
            margin: 12px 0;
            padding: 12px 15px;
            background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
            border-radius: 8px;
            font-size: 0.95em;
            line-height: 1.5;
            border-left: 4px solid #2196f3;
        }
        .rating {
            color: #f57c00;
            margin: 12px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #fff8e1 0%, #ffecb3 100%);
            border-radius: 8px;
            font-weight: 600;
            border-left: 4px solid #ffc107;
        }
        .action-link, .url-section {
            margin: 15px 0;
            padding: 0;
        }
        .interactive-btn {
            display: inline-block;
            background: linear-gradient(135deg, #1976d2 0%, #42a5f5 100%);
            color: white !important;
            text-decoration: none;
            padding: 12px 20px;
            border-radius: 25px;
            font-weight: 600;
            font-size: 0.95em;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(25, 118, 210, 0.3);
            position: relative;
            overflow: hidden;
            min-width: 160px;
            text-align: center;
            word-break: break-word;
        }
        .interactive-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(25, 118, 210, 0.4);
            background: linear-gradient(135deg, #1565c0 0%, #1976d2 100%);
            text-decoration: none;
        }
        .interactive-btn .btn-text {
            display: block;
            font-size: 0.8em;
            opacity: 0.9;
            margin-top: 2px;
        }
        .content-header {
            color: #1976d2;
            font-size: 1.3em;
            font-weight: 600;
            margin: 20px 0 15px 0;
            padding-bottom: 8px;
            border-bottom: 2px solid #e3f2fd;
        }
        .content-text {
            margin: 12px 0;
            line-height: 1.6;
            text-align: justify;
        }
        .footer { 
            margin-top: 50px; 
            text-align: center;
            font-size: 0.9em; 
            color: #666; 
            padding-top: 25px;
            border-top: 1px solid #eee;
        }
        h1 { color: #1976d2; margin: 0; font-size: 2.2em; }
        h2, h3 { color: #333; }
        .timestamp { color: #666; font-size: 0.95em; margin: 15px 0; }
        .url-link { 
            color: #1976d2; 
            text-decoration: none; 
            word-break: break-all;
        }
        .url-link:hover { text-decoration: underline; }
        .badge { 
            background: #4caf50; 
            color: white; 
            padding: 8px 16px; 
            border-radius: 25px; 
            font-size: 0.9em;
            margin: 15px 0;
            display: inline-block;
            font-weight: 500;
        }
        p {
            margin: 10px 0;
            text-align: justify;
        }
        @media (max-width: 768px) {
            .meta-info {
                grid-template-columns: 1fr;
            }
            .products-grid {
                grid-template-columns: 1fr;
            }
            .container {
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Computer Use Extraction Report</h1>
            <div class="badge">✅ Task Completed Successfully</div>
            <p class="timestamp">📅 Generated on: ${new Date(data.timestamp).toLocaleString()}</p>
        </div>
        
        <div class="meta-info">
            <div>
                <h3>🎯 Original Query</h3>
                <p><strong>${data.userQuery}</strong></p>
            </div>
            <div>
                <h3>📄 Page Title</h3>
                <p>${data.title}</p>
            </div>
            <div style="grid-column: 1 / -1;">
                <h3>🌐 Source URL</h3>
                <p><a href="${data.url}" target="_blank" class="url-link">${data.url}</a></p>
            </div>
        </div>
        
        <div class="content">
            <h2>📊 Extracted Information</h2>
            ${structuredContent}
        </div>
        
        <div class="footer">
            <p>🚀 This report was automatically generated by the Computer Use Agent</p>
            <p>Generated at: ${new Date(data.timestamp).toLocaleString()} | Format: HTML</p>
        </div>
    </div>
</body>
</html>`
  }

  if (!extractedData || !extractedData.success) {
    return null
  }

  return (
    <div className="mt-3 space-y-3">
      <Card className="p-5 hover:shadow-lg transition-all duration-200 border-2 border-border/50 hover:border-primary/30 bg-gradient-to-br from-card to-card/50">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 p-3 rounded-xl bg-primary/5">
            <FileText className="h-10 w-10 text-primary" />
          </div>
          <div className="flex-1 min-w-0 space-y-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h4 className="font-semibold text-base">Reporte de extracción de Computer Use</h4>
                <Badge variant="secondary" className="text-xs font-medium">
                  Reporte HTML
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground font-medium mb-2">
                Generado: {new Date(extractedData.timestamp).toLocaleString()}
              </p>
              <p className="text-sm text-muted-foreground mb-2">
                <strong>Consulta:</strong> {extractedData.userQuery}
              </p>
              <p className="text-sm text-muted-foreground">
                <strong>Fuente:</strong> {extractedData.title}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={downloadAsHtml}
                className="h-9 px-4 font-medium hover:bg-primary/10"
              >
                <Download className="h-4 w-4 mr-2" />
                Descargar HTML
              </Button>

              <Button
                variant="default"
                size="sm"
                onClick={() => window.open(extractedData.url, '_blank')}
                className="h-9 px-4 font-medium shadow-sm hover:shadow-md"
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Ver fuente
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}

export default ExtractedDataDownload
