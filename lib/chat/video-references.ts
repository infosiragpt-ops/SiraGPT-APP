import { parseMessageFiles } from "./composer-files";

type ImageFile = { id?: string; fileId?: string; url?: string; imageUrl?: string; filename?: string; name?: string; userId?: string; mimeType?: string; type?: string };

function isImage(file: ImageFile): boolean {
  return file.type === 'image' || String(file.mimeType || file.type || '').startsWith('image/')
    || /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(file.filename || file.name || file.url || '');
}

export async function resolveVideoReferenceUrls(options: {
  fileIds?: string[];
  sourceImageUrls?: string[];
  sourceImageFiles?: ImageFile[];
  uploadedFiles?: ImageFile[];
  backendBaseUrl: string;
  getFile: (id: string) => Promise<unknown>;
}): Promise<string[]> {
  const urls: string[] = [];
  const resolvedIds = new Set<string>();
  const urlsById = new Map<string, string>();
  const explicitUrls: string[] = [];
  const add = (value?: string) => {
    const raw = String(value || '').trim();
    if (!raw) return false;
    // Browser blob previews are not accessible to a cloud provider. Resolve
    // their persisted File id below rather than sending a fictitious URL.
    if (raw.startsWith('blob:')) return false;
    if (!/^(https?:\/\/|data:image\/(?:png|jpeg|webp);base64,|\/uploads\/|\/api\/agent\/artifact\/)/i.test(raw)) {
      throw new Error('La imagen de referencia no tiene una dirección válida. Vuelve a adjuntarla.');
    }
    const url = raw.startsWith('/') ? `${options.backendBaseUrl.replace(/\/$/, '')}${raw}` : raw;
    if (!urls.includes(url)) urls.push(url);
    return url;
  };
  for (const url of options.sourceImageUrls || []) {
    const resolved = add(url);
    if (!resolved) throw new Error('La imagen de referencia aún no está guardada. Espera a que termine la carga.');
    explicitUrls.push(resolved);
  }
  const selectedIds = new Set([...(options.fileIds || []), ...(options.sourceImageFiles || []).map((file) => file.id || file.fileId).filter((id): id is string => Boolean(id))]);
  const candidates = [
    ...(options.sourceImageFiles || []),
    ...(options.uploadedFiles || []).filter((file) => selectedIds.has(String(file.id || file.fileId || ''))),
  ];
  for (const file of candidates) {
    if (!isImage(file)) continue;
    const id = file.id || file.fileId;
    const url = file.url || file.imageUrl || (file.filename && file.userId ? `/uploads/${file.userId}/${file.filename}` : undefined);
    const resolved = add(url);
    if (resolved) { if (id) { resolvedIds.add(id); urlsById.set(id, resolved); } }
    else if (!id) throw new Error('La imagen de referencia aún no está guardada. Vuelve a adjuntarla.');
  }
  for (const id of selectedIds) {
    if (resolvedIds.has(id)) continue;
    let result: unknown;
    try { result = await options.getFile(id); }
    catch { throw new Error('No se pudo recuperar una imagen o archivo adjunto. Vuelve a adjuntarlo antes de generar el vídeo.'); }
    const file = ((result as { file?: ImageFile })?.file || result) as ImageFile | null;
    if (!file) throw new Error('No se encontró uno de los archivos adjuntos. Vuelve a adjuntarlo.');
    if (!isImage(file)) continue;
    const url = file.url || file.imageUrl || (file.filename && file.userId ? `/uploads/${file.userId}/${file.filename}` : undefined);
    const resolved = add(url);
    if (!resolved) throw new Error('No se pudo recuperar la imagen de referencia. Vuelve a adjuntarla.');
    urlsById.set(id, resolved);
  }
  // A blob requiring asynchronous lookup must keep its original position
  // relative to references that already had persisted URLs.
  const orderedIds = selectedIds.size ? [...selectedIds] : candidates.map((file) => file.id || file.fileId || '');
  return [...new Set([...explicitUrls, ...orderedIds.map((id) => urlsById.get(id)).filter((url): url is string => Boolean(url)), ...urls])];
}

// Reuse the latest visible image-bearing turn (uploaded or generated), keeping
// the complete ordered set. Capacity checks belong to the selected model.
export function collectLatestVideoReferenceUrls(messages: readonly unknown[], resolveUrl: (file: unknown) => string): string[] {
  for (const entry of [...messages].reverse()) {
    const message = entry as { deletedAt?: unknown; files?: unknown; content?: unknown };
    if (!message || message.deletedAt) continue;
    const allFiles = parseMessageFiles(message.files);
    const files = allFiles.filter((value) => {
      const file = value as ImageFile & { deletedAt?: unknown };
      return file && !file.deletedAt && isImage(file);
    });
    const urls = files.map(resolveUrl).map((url) => String(url || '').trim()).filter(Boolean);
    if (urls.length) return [...new Set(urls)];
    // A removed attachment may still leave its URL in legacy message text.
    // Do not resurrect hidden pixels through that fallback.
    if (allFiles.some((value) => (value as { deletedAt?: unknown })?.deletedAt)) continue;
    const content = String(message.content || '').trim();
    if (/^https?:\/\//i.test(content) && /\.(?:png|jpe?g|webp|gif|avif)(?:\?|#|$)/i.test(content)) return [content];
  }
  return [];
}
