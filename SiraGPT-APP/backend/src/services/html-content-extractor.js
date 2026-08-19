'use strict';

/**
 * html-content-extractor — extracts the main textual content from HTML
 * documents, stripping boilerplate (nav, header, footer, sidebar, ads,
 * scripts, styles) to produce clean text for RAG indexing.
 *
 * Strategy:
 *   1. Strip <script>, <style>, <nav>, <noscript> tags and their content.
 *   2. Identify the main content block using heuristics:
 *      - Looks for <main>, <article>, [role="main"], or largest text block.
 *   3. Convert remaining HTML to plain text.
 *   4. Preserve headings, paragraphs, lists, and links as markdown-like text.
 */

const BOILERPLATE_TAGS = new Set([
  'script', 'style', 'noscript', 'nav', 'template', 'iframe',
]);

const BOILERPLATE_SELECTORS = [
  'header', 'footer', 'nav', 'aside', '.sidebar', '.nav',
  '.navigation', '.menu', '.footer', '.header', '#header',
  '#footer', '#nav', '#menu', '#sidebar', '.advertisement',
  '.ads', '.cookie-banner', '.banner', '.popup', '.modal',
  '.comment', '.comments', '.related', '.share', '.social',
];

/**
 * Strip boilerplate from HTML and extract the main content.
 * Pure regex-based (no DOM parser) — fast, memory-efficient, no dependencies.
 *
 * @param {string} html — raw HTML string
 * @returns {{ title: string|null, text: string, charCount: number, wordCount: number }}
 */
function extractMainContent(html) {
  if (!html || typeof html !== 'string') {
    return { title: null, text: '', charCount: 0, wordCount: 0 };
  }

  let cleaned = html;

  // Extract title before stripping
  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.trim()?.replace(/\s+/g, ' ') || null;

  // Strip script, style, noscript, and template content
  for (const tag of BOILERPLATE_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\/${tag}>`, 'gi'), '');
  }

  // Strip common boilerplate containers by matching opening + closing tags
  // Use regex on common patterns
  cleaned = cleaned.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  cleaned = cleaned.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  cleaned = cleaned.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  cleaned = cleaned.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

  // Strip HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // Find main content area if present
  let mainContent = '';
  const mainMatch = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/gi);
  const articleMatch = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/gi);
  const roleMain = cleaned.match(/<[^>]+role="main"[^>]*>([\s\S]*?)(?=<\/div>|<\/section>)/gi);

  if (mainMatch) {
    mainContent = mainMatch.join(' ');
  } else if (articleMatch) {
    mainContent = articleMatch.join(' ');
  } else if (roleMain) {
    mainContent = roleMain.join(' ');
  } else {
    // Fall back to body content minus the stripped parts
    const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    mainContent = bodyMatch?.[1] || cleaned;
  }

  // Remove remaining HTML tags but preserve headings and list items
  let text = mainContent;
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, content) => `${'#'.repeat(Number(lvl))} ${content.trim()}\n\n`);
  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, content) => `## ${content.trim()}\n\n`);
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => `${content.trim()}\n\n`);
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => `- ${content.trim()}\n`);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');
  text = text.replace(/<\/?(ul|ol|dl|div|section|span|table|thead|tbody|tr|td|th)[^>]*>/gi, '\n');
  text = text.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    if (href && content && content.trim()) return `[${content.trim()}](${href})`;
    return content?.trim() || '';
  });
  text = text.replace(/<(strong|b)>([\s\S]*?)<\/(strong|b)>/gi, '**$2**');
  text = text.replace(/<(em|i)>([\s\S]*?)<\/(em|i)>/gi, '*$2*');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&[a-z]+;/gi, '');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return { title, text, charCount: text.length, wordCount };
}

/**
 * Extract plain text from an HTML file path.
 * Reads the file, extracts main content, returns clean text.
 *
 * @param {string} filePath — path to HTML file
 * @returns {Promise<{ title: string|null, text: string, charCount: number, wordCount: number }>}
 */
async function extractFromFile(filePath) {
  const fs = require('fs').promises;
  const raw = await fs.readFile(filePath, 'utf8');
  return extractMainContent(raw);
}

module.exports = {
  extractMainContent,
  extractFromFile,
};