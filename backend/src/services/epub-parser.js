'use strict';

/**
 * EPUB parser — extracts text from EPUB files.
 *
 * EPUB is a ZIP archive containing XHTML/HTML content files,
 * a container.xml, and an OPF manifest. This parser extracts
 * all text from the content documents, preserving chapter
 * structure and basic formatting.
 *
 * Uses Python's built-in zipfile + xml to avoid adding
 * heavy JS dependencies.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

async function parseEpub(filePath) {
  return new Promise((resolve, reject) => {
    execFile('python3', [
      '-c', `
import zipfile, sys, re, xml.etree.ElementTree as ET
from io import BytesIO

def strip_tags(html):
    # Simple tag stripping: remove scripts, styles, then all tags
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<[^>]+>', ' ', html)
    # Decode common entities
    html = html.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    html = html.replace('&quot;', '"').replace('&apos;', "'").replace('&nbsp;', ' ')
    html = html.replace('&#160;', ' ').replace('&#x2019;', "'").replace('&#x201c;', '"').replace('&#x201d;', '"')
    # Collapse whitespace
    html = re.sub(r'\\n{3,}', '\\n\\n', html)
    html = re.sub(r'[ \\t]{2,}', ' ', html)
    lines = [l.strip() for l in html.split('\\n')]
    return '\\n'.join(l for l in lines if l)

with zipfile.ZipFile(sys.argv[1]) as zf:
    names = zf.namelist()

    # Find OPF file from container.xml
    opf_path = None
    if 'META-INF/container.xml' in names:
        container = zf.read('META-INF/container.xml')
        root = ET.fromstring(container)
        ns = {'c': 'urn:oasis:names:tc:opendocument:xmlns:container'}
        rootfile = root.find('.//c:rootfile', ns)
        if rootfile is not None:
            opf_path = rootfile.get('full-path', '')

    # Find content files from OPF manifest
    content_files = []
    if opf_path and opf_path in names:
        opf_xml = zf.read(opf_path)
        opf_root = ET.fromstring(opf_xml)
        opf_ns = {
            'opf': 'http://www.idpf.org/2007/opf',
            'dc': 'http://purl.org/dc/elements/1.1/',
        }
        for item in opf_root.iter():
            if item.tag.endswith('}item') or item.tag == 'item':
                href = item.get('href', '')
                mtype = item.get('media-type', '')
                if 'html' in mtype or 'xhtml' in mtype or 'xml' in mtype:
                    # Resolve relative path
                    base = opf_path.rsplit('/', 1)[0] if '/' in opf_path else ''
                    full = (base + '/' + href).lstrip('/') if base else href
                    if full in names:
                        content_files.append(full)

    # Fallback: find all HTML/XHTML files
    if not content_files:
        for name in names:
            if name.lower().endswith(('.html', '.xhtml', '.htm', '.xml')) and 'META-INF' not in name:
                content_files.append(name)

    # Extract text from content files in order
    parts = []
    for cf in content_files:
        try:
            html = zf.read(cf).decode('utf-8', errors='replace')
            text = strip_tags(html)
            if text.strip():
                # Extract chapter title from filename
                chapter = cf.rsplit('/', 1)[-1].rsplit('.', 1)[0]
                parts.append(f'\\n## {chapter}\\n{text.strip()}')
        except:
            pass

    # Fallback: try all text-containing files
    if not parts:
        for name in sorted(names):
            if name.lower().endswith(('.html', '.xhtml', '.htm', '.xml', '.txt', '.md')):
                try:
                    content = zf.read(name).decode('utf-8', errors='replace')
                    text = strip_tags(content)
                    if text.strip():
                        parts.append(text.strip())
                except:
                    pass

    result = '\\n'.join(parts)
    print(result[:1000000])  # Cap at 1MB for safety
      `.trim(), filePath,
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // Fallback: try with Node's built-in zlib (no Python)
        tryNodeFallback(filePath).then(resolve).catch(reject);
        return;
      }
      const text = (stdout || '').trim();
      if (!text || text.length < 20) {
        tryNodeFallback(filePath).then(resolve).catch(reject);
        return;
      }
      const header = `EPUB document — ${text.length} characters extracted\n---\n`;
      resolve(header + text);
    });
  });
}

/**
 * Node.js fallback using built-in zlib + manual XML extraction.
 * Works when Python is not available.
 */
async function tryNodeFallback(filePath) {
  const { createReadStream } = require('fs');
  const { pipeline } = require('stream');
  const zlib = require('zlib');
  const tmp = require('os').tmpdir();
  const crypto = require('crypto');

  return new Promise((resolve, reject) => {
    // Use unzip command if available
    const dest = `${tmp}/epub-extract-${crypto.randomUUID()}`;
    const { spawn } = require('child_process');
    const child = spawn('unzip', ['-o', filePath, '-d', dest], { stdio: 'ignore' });

    // Wall-clock cap: a malformed/zip-bomb EPUB can make `unzip` hang forever,
    // which would never settle this Promise and would leak a zombie child.
    // Mirror the SIGKILL-on-timeout pattern used in legacy-format-converter.js
    // and documentRenderer.js.
    const timeoutMs = Number(process.env.EPUB_UNZIP_TIMEOUT_MS) || 60000;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error('EPUB extraction timed out.'));
    }, timeoutMs);

    child.on('exit', async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('EPUB extraction failed. Install Python3 for best EPUB support.'));
        return;
      }
      try {
        const parts = [];
        await collectXhtmlFiles(dest, parts);
        const text = parts.join('\n');
        const { rm } = require('fs/promises');
        await rm(dest, { recursive: true, force: true }).catch(() => {});

        if (!text || text.trim().length < 20) {
          reject(new Error('EPUB parsing produced minimal text.'));
          return;
        }
        const header = `EPUB document — ${text.length} characters extracted\n---\n`;
        resolve(header + text.trim());
      } catch (e) {
        reject(e);
      }
    });

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function collectXhtmlFiles(dir, parts) {
  const { readdir, readFile } = require('fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== '__MACOSX') {
      await collectXhtmlFiles(full, parts);
    } else if (/\.(x?html?|xml)$/i.test(entry.name) && !entry.name.startsWith('.')) {
      const content = await readFile(full, 'utf-8');
      const text = content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (text.length > 20) {
        parts.push(text);
      }
    }
  }
}

module.exports = { parseEpub };