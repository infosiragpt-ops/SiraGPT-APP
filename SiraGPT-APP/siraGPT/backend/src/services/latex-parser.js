'use strict';

/**
 * LaTeX parser — extracts readable text from .tex files.
 *
 * Strips LaTeX commands and environments while preserving
 * section structure, captions, and body text. Handles:
 *   - Sectioning commands (section, subsection, etc.)
 *   - Common formatting (textbf, textit, etc.)
 *   - Environments (itemize, enumerate, table, figure)
 *   - Math mode (stripped or marked)
 *   - Comments
 *   - \input / \include references (not resolved)
 *
 * Pure JS — zero dependencies.
 */

function parseLatex(raw) {
  if (!raw || typeof raw !== 'string') return '';

  let text = raw;

  // Remove comments (lines starting with %)
  text = text.replace(/(?<!\\)%.*$/gm, '');

  // Remove preamble (everything before \begin{document})
  const docStart = text.search(/\\begin\{document\}/);
  if (docStart >= 0) {
    text = text.slice(docStart + '\\begin{document}'.length);
  }
  const docEnd = text.search(/\\end\{document\}/);
  if (docEnd >= 0) {
    text = text.slice(0, docEnd);
  }

  // Convert sectioning commands to markdown headings
  text = text.replace(/\\chapter\*?\s*\{([^}]*)\}/g, '\n\n# $1\n\n');
  text = text.replace(/\\section\*?\s*\{([^}]*)\}/g, '\n\n## $1\n\n');
  text = text.replace(/\\subsection\*?\s*\{([^}]*)\}/g, '\n\n### $1\n\n');
  text = text.replace(/\\subsubsection\*?\s*\{([^}]*)\}/g, '\n\n#### $1\n\n');
  text = text.replace(/\\paragraph\*?\s*\{([^}]*)\}/g, '\n\n**$1**  \n');

  // Convert formatting commands
  text = text.replace(/\\textbf\{([^}]*)\}/g, '**$1**');
  text = text.replace(/\\textit\{([^}]*)\}/g, '*$1*');
  text = text.replace(/\\texttt\{([^}]*)\}/g, '`$1`');
  text = text.replace(/\\emph\{([^}]*)\}/g, '*$1*');
  text = text.replace(/\\underline\{([^}]*)\}/g, '__$1__');
  text = text.replace(/\\textbf\s*\{/g, '**');
  text = text.replace(/\\textit\s*\{/g, '*');

  // Convert captions
  text = text.replace(/\\caption\{([^}]*)\}/g, '\n*$1*\n');

  // Handle itemize/enumerate environments
  text = text.replace(/\\begin\{itemize\}/g, '');
  text = text.replace(/\\end\{itemize\}/g, '');
  text = text.replace(/\\begin\{enumerate\}/g, '');
  text = text.replace(/\\end\{enumerate\}/g, '');
  text = text.replace(/\\item\s*(\[[^\]]*\])?\s*/g, '\n- ');
  text = text.replace(/\\item\s*\{?/g, '\n- ');

  // Handle description environment
  text = text.replace(/\\begin\{description\}/g, '');
  text = text.replace(/\\end\{description\}/g, '');

  // Strip table/figure environments (keep captions, drop content)
  text = text.replace(/\\begin\{table\}[\s\S]*?\\end\{table\}/g, '');
  text = text.replace(/\\begin\{figure\}[\s\S]*?\\end\{figure\}/g, '');
  text = text.replace(/\\begin\{tabular\}[\s\S]*?\\end\{tabular\}/g, '[tabular data]');
  text = text.replace(/\\begin\{longtable\}[\s\S]*?\\end\{longtable\}/g, '[long table]');
  text = text.replace(/\\begin\{center\}[\s\S]*?\\end\{center\}/g, '');

  // Strip other common environments (keep their content)
  text = text.replace(/\\begin\{(quote|quotation|verse|abstract|proof)\}/g, '');
  text = text.replace(/\\end\{(quote|quotation|verse|abstract|proof)\}/g, '');

  // Strip math mode (inline and display)
  text = text.replace(/\$\$[\s\S]*?\$\$/g, ' [equation] ');
  text = text.replace(/\$[^$]+\$/g, ' [math] ');
  text = text.replace(/\\\[[\s\S]*?\\\]/g, ' [equation] ');
  text = text.replace(/\\\([\s\S]*?\\\)/g, ' [math] ');
  text = text.replace(/\\begin\{equation\*?\}[\s\S]*?\\end\{equation\*?\}/g, ' [equation] ');
  text = text.replace(/\\begin\{align\*?\}[\s\S]*?\\end\{align\*?\}/g, ' [aligned equations] ');

  // Convert labels and references
  text = text.replace(/\\label\{[^}]*\}/g, '');
  text = text.replace(/\\ref\{([^}]*)\}/g, '[ref:$1]');
  text = text.replace(/\\cite\{([^}]*)\}/g, '[cite:$1]');
  text = text.replace(/\\footnote\{([^}]*)\}/g, ' [$1] ');

  // Handle common inline commands
  text = text.replace(/\\href\{([^}]*)\}\{([^}]*)\}/g, '[$2]($1)');
  text = text.replace(/\\url\{([^}]*)\}/g, '$1');
  text = text.replace(/\\Includesvg\{([^}]*)\}/g, '[image: $1]');
  text = text.replace(/\\includegraphics(\[[^\]]*\])?\{([^}]*)\}/g, '[image: $2]');

  // Handle special characters
  text = text.replace(/\\#/g, '#');
  text = text.replace(/\\\$/g, '$');
  text = text.replace(/\\%/g, '%');
  text = text.replace(/\\&/g, '&');
  text = text.replace(/\\_/g, '_');
  text = text.replace(/\\\{/g, '{');
  text = text.replace(/\\\}/g, '}');
  text = text.replace(/\\textbackslash\s*/g, '\\');
  text = text.replace(/\\textasciitilde\s*/g, '~');
  text = text.replace(/\\textasciicircum\s*/g, '^');

  // Line breaks
  text = text.replace(/\\\\\s*(\[[^\]]*\])?\s*/g, '\n');
  text = text.replace(/\\newline\b/g, '\n');
  text = text.replace(/\\newpage\b/g, '\n---\n');
  text = text.replace(/\\clearpage\b/g, '\n---\n');
  text = text.replace(/\\pagebreak\b/g, '\n---\n');
  text = text.replace(/\\hfill\b/g, ' ');
  text = text.replace(/\\hspace\{[^}]*\}/g, ' ');
  text = text.replace(/\\vspace\{[^}]*\}/g, '\n');
  text = text.replace(/\\bigskip\b/g, '\n');
  text = text.replace(/\\medskip\b/g, '\n');
  text = text.replace(/\\smallskip\b/g, '\n');

  // Strip remaining commands (generic \command{arg} or \command[opt]{arg})
  text = text.replace(/\\[a-zA-Z@]+\s*(\[[^\]]*\])?\s*\{/g, (match) => {
    // Commands that produce visible text — keep their arguments
    const textualCommands = /\\text(?:bf|it|tt|sc|sf|rm|up|md|normal)/;
    if (textualCommands.test(match)) return match;
    return '';
  });
  text = text.replace(/\\[a-zA-Z@]+\s*/g, ' ');
  // Remove orphaned closing braces from stripped commands
  text = text.replace(/\}/g, '');

  // Clean up
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/^[ \t]+/gm, '');
  text = text.trim();

  if (!text || text.length < 10) {
    throw new Error('LaTeX parsing produced minimal text. The document may be mostly math or figures.');
  }

  return text;
}

module.exports = { parseLatex };