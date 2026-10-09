/** Explicit conversions use the original file bytes, not a new generated scene or speech. */
export function fileConversionTarget(prompt = ''): 'docx' | 'pdf' | 'mp3' | 'mp4' | null {
  let text = String(prompt).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|«[^»\n]*»/g, ' ')
    .trim().replace(/^[¿¡]\s*/, '');
  if (/^(?:como|que|por que|explica|explicame|describe|dime si|se puede|es posible)\b/.test(text)
    || /\b(?:no|sin)\s+(?:conviert\w*|convert\w*|transform\w*|extra\w*)\b/.test(text)) return null;
  text = text.replace(/^(?:(?:por favor|ahora|quiero que|necesito que|te pido que|quiero|necesito|puedes|podrias|me puedes|me podrias|please)\s*[, :]?\s*)+/, '');
  const aliases: Record<string, 'docx' | 'pdf' | 'mp3' | 'mp4'> = { word: 'docx', docx: 'docx', pdf: 'pdf', mp3: 'mp3', mp4: 'mp4' };
  if (/^(?:extrae\w*|extraig\w*|extraer|extract\w*)\b[^.;\n]{0,90}\baudio\b[^.;\n]{0,90}\b(?:a|en|como|to|as)\s+(?:formato\s+)?mp3\b/.test(text)) return 'mp3';
  if (!/^(?:conviert\w*|convert\w*|transcod\w*|pasa\w*|transform\w*|export\w*|cambia\w*)\b/.test(text)) return null;
  if (/^cambia\w*\b/.test(text) && !/\bformato\b/.test(text)) return null;
  const target = text.match(/\b(?:a|al|en|to|into)\s+(?:(?:un|una|el|archivo|formato|formato de)\s+)*(word|docx|pdf|mp3|mp4)\b/);
  return target ? aliases[target[1]] : null;
}
