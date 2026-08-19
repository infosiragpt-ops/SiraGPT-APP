import { describe, it, expect } from 'vitest';
import {
  routePaste,
  extractUrls,
  isOnlyUrls,
  isRichHtml,
  type RoutedAction,
} from '../../lib/attachments/paste-router';

function makeFile(name: string, type: string, bytes: number[] = [1, 2, 3]): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('routePaste — plain text', () => {
  it('routes short text to a single insert-text action', () => {
    const actions = routePaste({ text: 'hola mundo' });
    expect(actions).toEqual([{ type: 'insert-text', text: 'hola mundo' }]);
  });

  it('keeps text of exactly 1500 chars inline (threshold boundary)', () => {
    const text = 'a'.repeat(1500);
    const actions = routePaste({ text });
    expect(actions).toEqual([{ type: 'insert-text', text }]);
  });

  it('routes 1501-char text to a snippet chip with a deterministic name', () => {
    const text = 'a'.repeat(1501);
    const actions = routePaste({ text });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: 'text-snippet-chip',
      text,
      suggestedName: 'pegado-1501-caracteres.txt',
    });
  });

  it('respects a custom longTextThreshold', () => {
    const text = 'b'.repeat(101);
    const actions = routePaste({ text }, { longTextThreshold: 100 });
    expect(actions[0]?.type).toBe('text-snippet-chip');
    const inline = routePaste({ text: 'b'.repeat(100) }, { longTextThreshold: 100 });
    expect(inline[0]?.type).toBe('insert-text');
  });

  it('returns [] for empty and whitespace-only input', () => {
    expect(routePaste({})).toEqual([]);
    expect(routePaste({ text: '   \n\t ' })).toEqual([]);
    expect(routePaste({ text: null, html: null, uriList: null, files: [] })).toEqual([]);
  });
});

describe('routePaste — URLs', () => {
  it('routes a bare URL to a single link-chip', () => {
    const actions = routePaste({ text: '  https://example.com/docs  ' });
    expect(actions).toEqual([{ type: 'link-chip', url: 'https://example.com/docs' }]);
  });

  it('routes two whitespace-separated URLs to two link-chips', () => {
    const actions = routePaste({ text: 'https://a.com/x\nhttp://b.org/y' });
    expect(actions).toEqual([
      { type: 'link-chip', url: 'https://a.com/x' },
      { type: 'link-chip', url: 'http://b.org/y' },
    ]);
  });

  it('routes URL mixed with prose to insert-text, NOT link chips', () => {
    const text = 'mira esto https://example.com está genial';
    const actions = routePaste({ text });
    expect(actions).toEqual([{ type: 'insert-text', text }]);
  });

  it('dedupes a repeated URL into a single link-chip', () => {
    const actions = routePaste({ text: 'https://a.com\nhttps://a.com  https://a.com' });
    expect(actions).toEqual([{ type: 'link-chip', url: 'https://a.com' }]);
  });

  it('routes a uriList payload (with comments) to link-chips', () => {
    const actions = routePaste({
      uriList: '# dragged links\r\nhttps://one.dev\r\nhttps://two.dev\r\n',
    });
    expect(actions).toEqual([
      { type: 'link-chip', url: 'https://one.dev' },
      { type: 'link-chip', url: 'https://two.dev' },
    ]);
  });

  it('falls through to text rules when URLs exceed maxLinkChips', () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://site${i}.com`);
    const text = urls.join('\n');
    const actions = routePaste({ text });
    expect(actions).toEqual([{ type: 'insert-text', text }]);
    // With a higher cap they become chips again.
    const chips = routePaste({ text }, { maxLinkChips: 10 });
    expect(chips).toHaveLength(6);
    expect(chips.every((a: RoutedAction) => a.type === 'link-chip')).toBe(true);
  });
});

describe('routePaste — rich HTML', () => {
  it('routes Word-style HTML to a single rich-html action carrying plainText', () => {
    const html =
      '<p class=MsoNormal><b>x</b></p><table><tr><td>celda</td></tr></table>';
    const actions = routePaste({ html, text: 'x celda' });
    expect(actions).toEqual([{ type: 'rich-html', html, plainText: 'x celda' }]);
  });

  it('derives plainText from the HTML when no text is provided', () => {
    const html = '<ul><li>uno</li><li>dos</li></ul>';
    const actions = routePaste({ html });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'rich-html', html });
    if (actions[0]?.type === 'rich-html') {
      expect(actions[0].plainText).toContain('uno');
      expect(actions[0].plainText).toContain('dos');
    }
  });

  it('ignores bare-wrapper HTML and falls through to text routing', () => {
    const actions = routePaste({
      html: '<div><span>hola</span></div><p>mundo</p>',
      text: 'hola mundo',
    });
    expect(actions).toEqual([{ type: 'insert-text', text: 'hola mundo' }]);
  });
});

describe('routePaste — files', () => {
  it('routes an image File to a file-chip with kind image', () => {
    const file = makeFile('foto.png', 'image/png');
    const actions = routePaste({ files: [file] });
    expect(actions).toEqual([{ type: 'file-chip', file, kind: 'image' }]);
  });

  it('routes a binary pdf File to a file-chip with kind document', () => {
    const file = makeFile('informe.pdf', 'application/pdf');
    const actions = routePaste({ files: [file] });
    expect(actions).toEqual([{ type: 'file-chip', file, kind: 'document' }]);
  });

  it('maps video and audio mime prefixes to their kinds', () => {
    const video = makeFile('clip.mp4', 'video/mp4');
    const audio = makeFile('nota.mp3', 'audio/mpeg');
    const actions = routePaste({ files: [video, audio] });
    expect(actions).toEqual([
      { type: 'file-chip', file: video, kind: 'video' },
      { type: 'file-chip', file: audio, kind: 'audio' },
    ]);
  });

  it('appends insert-text when an image and text are pasted together', () => {
    const file = makeFile('captura.jpg', 'image/jpeg');
    const actions = routePaste({ files: [file], text: 'mira esta captura' });
    expect(actions).toEqual([
      { type: 'file-chip', file, kind: 'image' },
      { type: 'insert-text', text: 'mira esta captura' },
    ]);
  });

  it('ignores html when files are present (files + html + text)', () => {
    const a = makeFile('a.png', 'image/png');
    const b = makeFile('b.csv', 'text/csv');
    const actions = routePaste({
      files: [a, b],
      html: '<table><tr><td>1</td></tr></table>',
      text: 'datos adjuntos',
    });
    expect(actions).toEqual([
      { type: 'file-chip', file: a, kind: 'image' },
      { type: 'file-chip', file: b, kind: 'document' },
      { type: 'insert-text', text: 'datos adjuntos' },
    ]);
    expect(actions.some((action: RoutedAction) => action.type === 'rich-html')).toBe(false);
  });

  it('uses opts.resolveKind when provided', () => {
    const file = makeFile('datos.csv', 'text/csv');
    const actions = routePaste(
      { files: [file] },
      { resolveKind: (mime, name) => (name.endsWith('.csv') ? 'spreadsheet' : mime) },
    );
    expect(actions).toEqual([{ type: 'file-chip', file, kind: 'spreadsheet' }]);
  });
});

describe('helpers', () => {
  it('extractUrls finds URLs embedded in prose and dedupes them', () => {
    const urls = extractUrls(
      'ver https://a.com/x, luego https://b.org. y otra vez https://a.com/x',
    );
    expect(urls).toEqual(['https://a.com/x', 'https://b.org']);
    expect(extractUrls('sin enlaces aquí')).toEqual([]);
  });

  it('isOnlyUrls distinguishes URL-only content from mixed prose', () => {
    expect(isOnlyUrls('https://a.com  https://b.com')).toBe(true);
    expect(isOnlyUrls('hola https://a.com')).toBe(false);
    expect(isOnlyUrls('   ')).toBe(false);
    expect(isOnlyUrls('ftp://a.com')).toBe(false);
  });

  it('isRichHtml detects formatting tags but not bare wrappers or <br>', () => {
    expect(isRichHtml('<p><b>negrita</b></p>')).toBe(true);
    expect(isRichHtml('<h2>Título</h2>')).toBe(true);
    expect(isRichHtml('<a href="https://a.com">link</a>')).toBe(true);
    expect(isRichHtml('<div><span>plano</span></div>')).toBe(false);
    expect(isRichHtml('línea<br>otra<br/>más')).toBe(false);
    expect(isRichHtml('')).toBe(false);
  });
});
