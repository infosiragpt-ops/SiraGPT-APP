const cheerio = require('cheerio');

const URL_ATTRS = new Set(['href', 'src', 'xlink:href']);
const BLOCKED_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'link',
  'meta',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
];

function isSafeUrl(value, { image = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (raw.startsWith('#')) return true;
  if (/^https?:\/\//i.test(raw)) return !image;
  if (/^mailto:/i.test(raw)) return !image;
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(raw)) return image;
  return false;
}

function sanitizeCss(css) {
  return String(css || '')
    .replace(/@import[^;]+;?/gi, '')
    .replace(/url\s*\([^)]*\)/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

function sanitizePreviewHtml(html) {
  const $ = cheerio.load(String(html || ''), {
    decodeEntities: false,
    scriptingEnabled: false,
  });

  $(BLOCKED_TAGS.join(',')).remove();

  $('style').each((_, el) => {
    const safeCss = sanitizeCss($(el).html());
    $(el).html(safeCss);
  });

  $('*').each((_, el) => {
    const attribs = { ...(el.attribs || {}) };
    for (const [name, value] of Object.entries(attribs)) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || lower === 'srcdoc') {
        $(el).removeAttr(name);
        continue;
      }
      if (lower === 'style') {
        $(el).removeAttr(name);
        continue;
      }
      if (URL_ATTRS.has(lower)) {
        const tagName = String(el.tagName || '').toLowerCase();
        const safe = isSafeUrl(value, { image: tagName === 'img' });
        if (!safe) $(el).removeAttr(name);
      }
    }
  });

  return $.html();
}

module.exports = {
  sanitizeCss,
  sanitizePreviewHtml,
};
