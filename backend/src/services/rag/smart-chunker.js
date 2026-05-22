'use strict';

/**
 * smart-chunker — auto-selects the best chunking strategy based on
 * document type, content characteristics, and length.
 *
 * Strategy selection logic:
 *   - Code files: code-chunker (AST-aware splitting)
 *   - Short docs (<5K chars): standard chunker (paragraph-join)
 *   - Long structured (>50K, headings): hierarchical chunker
 *   - Medium docs (5K-50K): recursive splitter
 *   - Very long docs (>200K): sentence-window or parent-child
 *   - Spreadsheets / tabular data: row-aware chunker
 */

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 200;

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.rb', '.php', '.swift', '.kt',
  '.scala', '.r', '.m', '.sql', '.sh', '.bash', '.zsh', '.pl',
  '.cs', '.fs', '.lua', '.ex', '.exs',
]);

const CODE_LANGUAGES = {
  '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust',
  '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
  '.scala': 'scala', '.r': 'r', '.m': 'objectivec',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.pl': 'perl', '.cs': 'csharp', '.fs': 'fsharp',
  '.lua': 'lua', '.ex': 'elixir', '.exs': 'elixir',
};

function hasHeadings(text) {
  return /^#{1,6}\s+/m.test(String(text || '').slice(0, 20000));
}

function isCodeFile(filename) {
  if (!filename) return false;
  const ext = String(filename).toLowerCase().split('.').pop();
  return CODE_EXTENSIONS.has(`.${ext}`);
}

function isTabular(text) {
  if (!text) return false;
  const head = text.slice(0, 10000);
  const lines = head.split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) return false;
  const pipeLines = lines.filter(l => l.includes('|')).length;
  const tabLines = lines.filter(l => l.includes('\t')).length;
  return pipeLines > lines.length * 0.5 || tabLines > lines.length * 0.5;
}

/**
 * Recommend a chunking strategy based on file metadata and content.
 *
 * @param {object} doc — { text, title, filename, mimeType, ... }
 * @returns {string} — strategy name: 'code', 'hierarchical', 'recursive', 'sentence-window', 'standard'
 */
function recommendStrategy(doc = {}) {
  const text = doc.text || '';
  const filename = doc.filename || doc.title || doc.originalName || '';
  const len = text.length;

  if (isCodeFile(filename)) return 'code';

  if (len < 5000) return 'standard';

  if (len > 200000) return 'sentence-window';

  if (len > 50000 && hasHeadings(text)) return 'hierarchical';

  if (len > 10000) return 'recursive';

  return 'standard';
}

/**
 * Chunk text using the recommended strategy.
 *
 * @param {object} doc — { text, title, filename, ... }
 * @param {object} [opts] — { size, overlap, ... }
 * @returns {Promise<{ chunks: string[], strategy: string }>}
 */
async function chunkWithStrategy(doc = {}, opts = {}) {
  const strategy = opts.strategy || recommendStrategy(doc);
  const text = doc.text || '';
  const title = doc.title || doc.filename || doc.originalName || '';

  if (!text || text.length === 0) return { chunks: [], strategy: 'none' };

  const size = opts.size || DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap || DEFAULT_CHUNK_OVERLAP;

  switch (strategy) {
    case 'code': {
      try {
        const codeChunker = require('./code-chunker');
        const ext = String(title || '').toLowerCase().split('.').pop() || '';
        const language = CODE_LANGUAGES[`.${ext}`] || null;
        const chunked = codeChunker.chunk(text, { language, size: size * 4, overlap: overlap * 4 });
        return { chunks: chunked, strategy: 'code' };
      } catch {
        // Fall through to recursive
      }
    }
    // falls through
    case 'recursive': {
      try {
        const recursiveSplitter = require('./recursive-splitter');
        const chunked = recursiveSplitter.splitText(text, {
          chunkSize: size * 4,
          chunkOverlap: overlap * 4,
        });
        return { chunks: chunked, strategy: 'recursive' };
      } catch {
        // Fall through to standard
      }
    }
    // falls through
    case 'hierarchical': {
      try {
        const hierarchical = require('../document/hierarchical-document-chunker');
        const result = hierarchical.createHierarchicalChunks(text, {
          docTitle: title,
          maxChunkSize: size * 4,
        });
        const chunks = result?.chunks || result?.map(c => c.text).filter(Boolean) || [];
        return { chunks, strategy: 'hierarchical' };
      } catch {
        // Fall through to standard
      }
    }
    // falls through
    case 'sentence-window': {
      try {
        const advanced = require('./rag/advanced-chunking');
        const chunks = String(text)
          .replace(/\r\n/g, '\n')
          .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/)
          .filter(s => s.trim());
        const windows = [];
        const windowSize = opts.sentenceWindowSize || 5;
        for (let i = 0; i < chunks.length; i += 1) {
          const start = Math.max(0, i - Math.floor(windowSize / 2));
          const end = Math.min(chunks.length, i + Math.ceil(windowSize / 2));
          windows.push(chunks.slice(start, end).join(' '));
        }
        return { chunks: windows, strategy: 'sentence-window' };
      } catch {
        // Fall through to standard
      }
    }
    // falls through
    default: {
      const rag = require('./rag-service');
      const chunks = rag.chunk(text, { size: size * 4, overlap: overlap * 4 });
      return { chunks, strategy: 'standard' };
    }
  }
}

module.exports = {
  recommendStrategy,
  chunkWithStrategy,
  isCodeFile,
  hasHeadings,
  isTabular,
  CODE_EXTENSIONS,
  CODE_LANGUAGES,
};