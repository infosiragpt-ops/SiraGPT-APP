'use strict';

/**
 * Stdlib-ish OOXML helpers used by AgentRunner's optional high-level path.
 * The model can still do the same job with execute_python; this exists so
 * "agrega una lámina de gracias" is reliable without python-pptx.
 */

const PizZip = require('pizzip');

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slideNumbers(zip) {
  return Object.keys(zip.files)
    .map((n) => {
      const m = n.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      return m ? Number(m[1]) : null;
    })
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function appendTextSlide({ buffer, title = 'Gracias' } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('appendTextSlide: buffer is required');
  }
  const zip = new PizZip(buffer);
  const nums = slideNumbers(zip);
  if (!nums.length) throw new Error('appendTextSlide: pptx has no slides');
  const lastN = nums[nums.length - 1];
  const newN = lastN + 1;
  const lastXml = zip.file(`ppt/slides/slide${lastN}.xml`)?.asText();
  if (!lastXml) throw new Error('appendTextSlide: last slide missing');

  let newXml = lastXml.replace(/(<a:t[^>]*>)([^<]*)(<\/a:t>)/, `$1${xmlEscape(title)}$3`);
  if (newXml === lastXml) {
    throw new Error('appendTextSlide: no text run to rewrite');
  }
  zip.file(`ppt/slides/slide${newN}.xml`, newXml);

  const lastRels = zip.file(`ppt/slides/_rels/slide${lastN}.xml.rels`);
  if (lastRels) {
    zip.file(`ppt/slides/_rels/slide${newN}.xml.rels`, lastRels.asText());
  }

  let ct = zip.file('[Content_Types].xml')?.asText() || '';
  if (!ct.includes(`slide${newN}.xml`)) {
    ct = ct.replace(
      '</Types>',
      `<Override PartName="/ppt/slides/slide${newN}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    );
    zip.file('[Content_Types].xml', ct);
  }

  let rels = zip.file('ppt/_rels/presentation.xml.rels')?.asText() || '';
  const rids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const newRid = (rids.length ? Math.max(...rids) : 10) + 1;
  if (!rels.includes(`slide${newN}.xml`)) {
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="rId${newRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${newN}.xml"/></Relationships>`,
    );
    zip.file('ppt/_rels/presentation.xml.rels', rels);
  }

  let pres = zip.file('ppt/presentation.xml')?.asText() || '';
  const sids = [...pres.matchAll(/<p:sldId[^>]*id="(\d+)"/g)].map((m) => Number(m[1]));
  const newSid = (sids.length ? Math.max(...sids) : 255) + 1;
  if (!pres.includes(`rId${newRid}"`)) {
    if (!pres.includes('</p:sldIdLst>')) {
      throw new Error('appendTextSlide: presentation.xml has no sldIdLst');
    }
    pres = pres.replace(
      '</p:sldIdLst>',
      `<p:sldId id="${newSid}" r:id="rId${newRid}"/></p:sldIdLst>`,
    );
    zip.file('ppt/presentation.xml', pres);
  }

  return {
    buffer: zip.generate({ type: 'nodebuffer' }),
    slideNumber: newN,
    title: String(title),
  };
}

module.exports = { appendTextSlide, slideNumbers };
