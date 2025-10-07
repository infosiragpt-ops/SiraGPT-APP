// Code detection and parsing utilities for live preview functionality

export interface ParsedCode {
  html: string
  css: string
  js: string
  hasWebCode: boolean
  combinedCode?: string
  files: Array<{
    name: string
    content: string
    language: string
  }>
}

// Regular expressions for code block detection
const CODE_BLOCK_REGEX = /```(\w+)?\n?([\s\S]*?)```/g
const HTML_INDICATORS = /<!DOCTYPE|<html|<head|<body|<div|<span|<p>|<p |<h[1-6]|<nav|<header|<footer|<main|<section|<article|<button|<input|<form|<img|<a |<ul|<ol|<li/i
const CSS_INDICATORS = /\{[^}]*\}|@media|@import|@keyframes|body\s*\{|\.[\w-]+\s*\{|#[\w-]+\s*\{/
const JS_INDICATORS = /function\s*\(|=>\s*{|document\.|window\.|console\.|addEventListener|querySelector|getElementById/

// Enhanced detection for various code patterns
const FRAMEWORK_PATTERNS = {
  react: /import\s+React|from\s+['"]react['"]|useState|useEffect|jsx/i,
  vue: /<template>|<script>|Vue\.|createApp/i,
  angular: /import.*@angular|@Component|ngOnInit/i,
  vanilla: /document\.|window\.|addEventListener|querySelector/i
}

/**
 * Detect the type of code in a given string
 * @param code - The code string to analyze
 * @returns The detected language type
 */
export function detectCodeType(code: string): string {
  if (!code) return 'text'
  
  const lowerCode = code.toLowerCase().trim()
  
  // Check for HTML indicators
  if (HTML_INDICATORS.test(code) || lowerCode.includes('<!doctype') || lowerCode.startsWith('<html')) {
    return 'html'
  }
  
  // Check for CSS indicators
  if (CSS_INDICATORS.test(code) || lowerCode.includes('@media') || lowerCode.includes('body {')) {
    return 'css'
  }
  
  // Check for JavaScript indicators
  if (JS_INDICATORS.test(code) || lowerCode.includes('function') || lowerCode.includes('const ') || lowerCode.includes('let ')) {
    return 'javascript'
  }
  
  // Check framework patterns
  for (const [framework, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
    if (pattern.test(code)) {
      return framework === 'react' ? 'jsx' : framework
    }
  }
  
  return 'text'
}

/**
 * Parse AI response content to extract code blocks and detect web technologies
 */
// Cache for parsed content to prevent re-processing
const parseCache = new Map<string, ParsedCode>()
const MAX_CACHE_SIZE = 50 // Limit cache size to prevent memory issues

// Clean cache when it gets too large
function cleanCache() {
  if (parseCache.size > MAX_CACHE_SIZE) {
    const keysToDelete = Array.from(parseCache.keys()).slice(0, parseCache.size - MAX_CACHE_SIZE + 10)
    keysToDelete.forEach(key => parseCache.delete(key))
  }
}

export function parseCodeFromContent(content: string): ParsedCode {
  // Quick cache check to prevent re-parsing
  const cacheKey = content.slice(0, 100) + content.length
  if (parseCache.has(cacheKey)) {
    return parseCache.get(cacheKey)!
  }
  
  // Quick early exit if no code patterns detected
  if (!content.includes('```') && !content.includes('<') && !content.includes('{')) {
      const emptyResult: ParsedCode = {
      html: '',
      css: '',
      js: '',
      hasWebCode: false,
      combinedCode: '',
      files: []
    }
    parseCache.set(cacheKey, emptyResult)
    return emptyResult
  }
  
  const result: ParsedCode = {
    html: '',
    css: '',
    js: '',
    hasWebCode: false,
    files: []
  }

  // Simple check - if content contains HTML-like tags and code blocks, enable preview
  const hasHtmlTags = /<[a-zA-Z][^>]*>/.test(content);
  const hasCodeBlocks = /```/.test(content);
  
  if (hasHtmlTags && hasCodeBlocks) {
    console.log('Quick detection: HTML tags and code blocks found');
    result.hasWebCode = true;
  }

  const codeBlocks: Array<{ language: string; content: string; filename?: string }> = []
  
  // Extract all code blocks
  let match
  CODE_BLOCK_REGEX.lastIndex = 0
  
  while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {
    const language = (match[1] || 'text').toLowerCase()
    const codeContent = match[2].trim()
    
    // Processing code block
    
    if (codeContent) {
      // Try to detect filename from content or context
      const filename = detectFilename(codeContent, language)
      
      codeBlocks.push({
        language,
        content: codeContent,
        filename
      })
      
      result.files.push({
        name: filename || `code.${language}`,
        content: codeContent,
        language
      })
    }
  }
  
  // Code blocks processed

  // Process code blocks and categorize them
  for (const block of codeBlocks) {
    const { language, content } = block
    // Categorizing code block by language
    
    // Detect and categorize by language
    if (language === 'html' || isHtmlContent(content)) {
      result.html += content + '\n'
      result.hasWebCode = true
    } else if (language === 'css' || isCssContent(content)) {
      result.css += content + '\n'
      result.hasWebCode = true
    } else if (['javascript', 'js'].includes(language) || isJavaScriptContent(content)) {
      result.js += content + '\n'
      result.hasWebCode = true
    } else if (isCompleteHtmlDocument(content)) {
      // If it's a complete HTML document, use it as combined code
      result.combinedCode = content
      result.hasWebCode = true
    } else if (language === 'text' || !language) {
      // Fallback: try to detect content type for unlabeled code blocks
      if (isHtmlContent(content)) {
        result.html += content + '\n'
        result.hasWebCode = true
      } else if (isCssContent(content)) {
        result.css += content + '\n'
        result.hasWebCode = true
      } else if (isJavaScriptContent(content)) {
        result.js += content + '\n'
        result.hasWebCode = true
      }
    }
  }
  
  // Parsing completed

  // Clean up extracted code
  result.html = result.html.trim()
  result.css = result.css.trim()
  result.js = result.js.trim()

  // If we have HTML but no CSS/JS, try to extract inline styles and scripts
  if (result.html && !result.css && !result.js) {
    const extracted = extractInlineCode(result.html)
    result.css += extracted.css
    result.js += extracted.js
  }

  // Cache the result and clean cache if needed
  parseCache.set(cacheKey, result)
  cleanCache()

  return result
}

/**
 * Check if content appears to be HTML
 */
function isHtmlContent(content: string): boolean {
  return HTML_INDICATORS.test(content);
}

/**
 * Check if content appears to be CSS
 */
function isCssContent(content: string): boolean {
  return CSS_INDICATORS.test(content)
}

/**
 * Check if content appears to be JavaScript
 */
function isJavaScriptContent(content: string): boolean {
  return JS_INDICATORS.test(content)
}

/**
 * Check if content is a complete HTML document
 */
function isCompleteHtmlDocument(content: string): boolean {
  return /<!DOCTYPE\s+html/i.test(content) && 
         /<html/i.test(content) && 
         /<\/html>/i.test(content)
}

/**
 * Extract inline CSS and JavaScript from HTML content
 */
function extractInlineCode(html: string): { css: string; js: string } {
  const result = { css: '', js: '' }
  
  // Extract CSS from <style> tags
  const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi)
  if (styleMatches) {
    styleMatches.forEach(match => {
      const cssContent = match.replace(/<\/?style[^>]*>/gi, '').trim()
      result.css += cssContent + '\n'
    })
  }
  
  // Extract JavaScript from <script> tags
  const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi)
  if (scriptMatches) {
    scriptMatches.forEach(match => {
      const jsContent = match.replace(/<\/?script[^>]*>/gi, '').trim()
      if (jsContent && !match.includes('src=')) { // Only inline scripts
        result.js += jsContent + '\n'
      }
    })
  }
  
  return result
}

/**
 * Detect filename from code content or generate appropriate filename
 */
function detectFilename(content: string, language: string): string {
  // Look for filename hints in comments
  const filenameHints = [
    /\/\/\s*(?:filename|file):\s*([^\n\r]+)/i,
    /\/\*\s*(?:filename|file):\s*([^*]+)\*\//i,
    /<!--\s*(?:filename|file):\s*([^>]+)-->/i
  ]
  
  for (const regex of filenameHints) {
    const match = content.match(regex)
    if (match) {
      return match[1].trim()
    }
  }
  
  // Generate filename based on content and language
  const extensions: Record<string, string> = {
    html: 'html',
    css: 'css',
    javascript: 'js',
    js: 'js',
    typescript: 'ts',
    jsx: 'jsx',
    tsx: 'tsx',
    vue: 'vue',
    python: 'py',
    java: 'java',
    cpp: 'cpp',
    c: 'c'
  }
  
  const extension = extensions[language] || 'txt'
  
  // Try to detect specific filenames based on content
  if (language === 'html' && isCompleteHtmlDocument(content)) {
    return 'index.html'
  } else if (language === 'css') {
    if (content.includes('@import') || content.includes('normalize') || content.includes('reset')) {
      return 'styles.css'
    }
    return 'style.css'
  } else if (['javascript', 'js'].includes(language)) {
    if (content.includes('document.addEventListener') || content.includes('DOMContentLoaded')) {
      return 'script.js'
    }
    return 'main.js'
  }
  
  return `code.${extension}`
}

/**
 * Check if the message content likely contains web development code
 */
export function hasWebDevelopmentCode(content: string): boolean {
  const parsed = parseCodeFromContent(content)
  return parsed.hasWebCode
}

/**
 * Generate a complete HTML document from separate HTML, CSS, and JS
 */
export function combineWebCode(html: string, css: string, js: string, title = "Generated Website"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        /* Reset and base styles */
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            line-height: 1.6;
            color: #333;
        }
        
        ${css}
    </style>
</head>
<body>
    ${html}
    
    <script>
        // Error handling for preview
        window.onerror = function(msg, url, line, col, error) {
            console.error('Preview Error:', msg, 'at line', line);
            return false;
        };
        
        ${js}
    </script>
</body>
</html>`
}

/**
 * Detect framework/library being used
 */
export function detectFramework(content: string): string | null {
  for (const [framework, pattern] of Object.entries(FRAMEWORK_PATTERNS)) {
    if (pattern.test(content)) {
      return framework
    }
  }
  return null
}