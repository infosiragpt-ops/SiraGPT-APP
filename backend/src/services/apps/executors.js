'use strict';

function jsonHeaders(accessToken, extra = {}) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  };
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

async function githubListRepos({ accessToken, args, fetchImpl }) {
  const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 30));
  const response = await fetchImpl('https://api.github.com/user/repos?per_page=' + limit + '&sort=updated&affiliation=owner,collaborator,organization_member', {
    headers: jsonHeaders(accessToken, {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'siraGPT-apps',
    }),
  });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'github_list_failed', status: parsed.status };
  const items = (Array.isArray(parsed.body) ? parsed.body : []).map((repo) => ({
    fullName: repo.full_name,
    private: Boolean(repo.private),
    htmlUrl: repo.html_url || null,
    description: repo.description || null,
    language: repo.language || null,
    updatedAt: repo.updated_at || null,
  }));
  return { count: items.length, items };
}

async function githubCreateIssue({ accessToken, args, fetchImpl, approved }) {
  if (!approved) {
    return { error: 'approval_required', message: 'Crear un issue en GitHub requiere confirmación.' };
  }
  const owner = String(args?.owner || '').trim();
  const repo = String(args?.repo || '').trim();
  const title = String(args?.title || '').trim();
  const body = String(args?.body || '').trim();
  if (!owner || !repo || !title) return { error: 'missing_fields', message: 'owner, repo y title son obligatorios.' };
  const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
    method: 'POST',
    headers: jsonHeaders(accessToken, {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'siraGPT-apps',
    }),
    body: JSON.stringify({ title: title.slice(0, 256), body: body.slice(0, 65000) }),
  });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'github_create_issue_failed', status: parsed.status };
  return {
    number: parsed.body.number,
    title: parsed.body.title,
    htmlUrl: parsed.body.html_url || null,
    state: parsed.body.state || 'open',
  };
}

async function linkedinReadProfile({ accessToken, fetchImpl }) {
  const response = await fetchImpl('https://api.linkedin.com/v2/userinfo', {
    headers: jsonHeaders(accessToken),
  });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'linkedin_profile_failed', status: parsed.status };
  return {
    name: parsed.body.name || null,
    email: parsed.body.email || null,
    locale: parsed.body.locale || null,
    picture: parsed.body.picture || null,
  };
}

async function linkedinPublishPost({ connectionRow, accessToken, args, approved, env, fetchImpl, vault, prisma }) {
  if (!approved) {
    return { error: 'approval_required', message: 'Publicar en LinkedIn requiere confirmación.' };
  }
  const commentary = String(args?.text || args?.commentary || '').trim();
  if (!commentary) return { error: 'missing_fields', message: 'text es obligatorio.' };
  // eslint-disable-next-line global-require
  const { publishPostToPlatform } = require('../social-company/publisher');
  const result = await publishPostToPlatform({
    platform: 'linkedin',
    connection: connectionRow,
    post: { caption: commentary.slice(0, 3000) },
    env,
    fetchImpl,
    vault,
    prisma,
  });
  return { externalId: result.externalId || null, media: result.media || 'text' };
}

async function xListMentions({ accessToken, connectionRow, args, fetchImpl }) {
  const accountId = String(connectionRow?.accountId || '').trim();
  if (!accountId) return { error: 'missing_account', message: 'La cuenta de X no tiene id.' };
  const limit = Math.max(5, Math.min(Number(args?.limit) || 10, 20));
  const url = new URL(`https://api.x.com/2/users/${encodeURIComponent(accountId)}/mentions`);
  url.searchParams.set('max_results', String(limit));
  url.searchParams.set('tweet.fields', 'author_id,created_at');
  const response = await fetchImpl(url, { headers: jsonHeaders(accessToken) });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'x_mentions_failed', status: parsed.status };
  const items = (Array.isArray(parsed.body.data) ? parsed.body.data : []).map((post) => ({
    id: post.id,
    text: post.text || '',
    authorId: post.author_id || null,
    createdAt: post.created_at || null,
  }));
  return { count: items.length, items };
}

async function xPublishPost({ connectionRow, args, approved, env, fetchImpl, vault, prisma }) {
  if (!approved) {
    return { error: 'approval_required', message: 'Publicar en X requiere confirmación.' };
  }
  const text = String(args?.text || '').trim();
  if (!text) return { error: 'missing_fields', message: 'text es obligatorio.' };
  // eslint-disable-next-line global-require
  const { publishPostToPlatform } = require('../social-company/publisher');
  const result = await publishPostToPlatform({
    platform: 'x',
    connection: connectionRow,
    post: { caption: text.slice(0, 280) },
    env,
    fetchImpl,
    vault,
    prisma,
  });
  return { externalId: result.externalId || null, media: result.media || 'text' };
}

const TEXT_MAX_BYTES = 100_000;
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

function clampLimit(value, fallback, max) {
  return Math.max(1, Math.min(Number(value) || fallback, max));
}

function isProbablyText(mime, name) {
  const type = String(mime || '').toLowerCase();
  const file = String(name || '').toLowerCase();
  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml') return true;
  return /\.(txt|md|csv|json|xml|html|css|js|ts|py|log)$/.test(file);
}

async function readTextBody(response, maxBytes = TEXT_MAX_BYTES) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    return { error: 'file_too_large', message: 'El archivo supera el límite de lectura.' };
  }
  return { text: buffer.toString('utf8'), bytes: buffer.length };
}

function mapOneDriveItem(item) {
  return {
    id: item.id || null,
    name: item.name || null,
    folder: Boolean(item.folder),
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
    webUrl: item.webUrl || null,
    lastModified: item.lastModifiedDateTime || null,
  };
}

function mapDriveFile(file) {
  return {
    id: file.id || null,
    name: file.name || null,
    mimeType: file.mimeType || null,
    size: file.size != null ? Number(file.size) : null,
    webViewLink: file.webViewLink || null,
    modifiedTime: file.modifiedTime || null,
  };
}

async function onedriveList({ accessToken, args, fetchImpl }) {
  const limit = clampLimit(args?.limit, 20, 50);
  const folderId = String(args?.folderId || args?.itemId || '').trim();
  const path = folderId
    ? `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId)}/children`
    : 'https://graph.microsoft.com/v1.0/me/drive/root/children';
  const url = `${path}?$top=${limit}&$select=id,name,size,webUrl,folder,file,lastModifiedDateTime`;
  const response = await fetchImpl(url, { headers: jsonHeaders(accessToken) });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'onedrive_list_failed', status: parsed.status };
  const items = (Array.isArray(parsed.body.value) ? parsed.body.value : []).map(mapOneDriveItem);
  return { count: items.length, items };
}

async function onedriveSearch({ accessToken, args, fetchImpl }) {
  const query = String(args?.query || args?.q || '').trim();
  if (!query) return { error: 'missing_fields', message: 'query es obligatorio.' };
  const limit = clampLimit(args?.limit, 20, 50);
  const url = `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${limit}`;
  const response = await fetchImpl(url, { headers: jsonHeaders(accessToken) });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'onedrive_search_failed', status: parsed.status };
  const items = (Array.isArray(parsed.body.value) ? parsed.body.value : []).map(mapOneDriveItem);
  return { count: items.length, items };
}

async function onedriveReadText({ accessToken, args, fetchImpl }) {
  const itemId = String(args?.itemId || args?.id || '').trim();
  if (!itemId) return { error: 'missing_fields', message: 'itemId es obligatorio.' };
  const metaResponse = await fetchImpl(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(itemId)}`, {
    headers: jsonHeaders(accessToken),
  });
  const meta = await readJson(metaResponse);
  if (!meta.ok) return { error: 'onedrive_read_failed', status: meta.status };
  if (!isProbablyText(meta.body.file?.mimeType, meta.body.name)) {
    return { error: 'not_text', message: 'Solo se leen archivos de texto pequeños.' };
  }
  const contentResponse = await fetchImpl(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(itemId)}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!contentResponse.ok) return { error: 'onedrive_read_failed', status: contentResponse.status };
  const body = await readTextBody(contentResponse);
  if (body.error) return body;
  return { id: meta.body.id, name: meta.body.name || null, ...body };
}

async function onedriveUpload({ accessToken, args, fetchImpl, approved }) {
  if (!approved) {
    return { error: 'approval_required', message: 'Subir a OneDrive requiere confirmación.' };
  }
  const name = String(args?.name || args?.filename || '').trim();
  if (!name) return { error: 'missing_fields', message: 'name es obligatorio.' };
  const folderId = String(args?.folderId || '').trim();
  if (args?.folder === true || args?.kind === 'folder') {
    const parent = folderId
      ? `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId)}/children`
      : 'https://graph.microsoft.com/v1.0/me/drive/root/children';
    const response = await fetchImpl(parent, {
      method: 'POST',
      headers: jsonHeaders(accessToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: name.slice(0, 200), folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
    });
    const parsed = await readJson(response);
    if (!parsed.ok) return { error: 'onedrive_folder_failed', status: parsed.status };
    return { id: parsed.body.id || null, name: parsed.body.name || name, folder: true };
  }
  const content = String(args?.content || args?.text || '');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > UPLOAD_MAX_BYTES) return { error: 'file_too_large', message: 'El archivo supera el límite de subida.' };
  const target = folderId
    ? `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:/content`
    : `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(name)}:/content`;
  const response = await fetchImpl(target, {
    method: 'PUT',
    headers: jsonHeaders(accessToken, { 'Content-Type': 'text/plain; charset=utf-8' }),
    body: content,
  });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'onedrive_upload_failed', status: parsed.status };
  return mapOneDriveItem(parsed.body);
}

async function gdriveList({ accessToken, args, fetchImpl }) {
  const limit = clampLimit(args?.limit, 20, 50);
  const folderId = String(args?.folderId || '').trim();
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('pageSize', String(limit));
  url.searchParams.set('fields', 'files(id,name,mimeType,size,webViewLink,modifiedTime)');
  const query = ["trashed=false"];
  if (folderId) query.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
  url.searchParams.set('q', query.join(' and '));
  const response = await fetchImpl(url, { headers: jsonHeaders(accessToken) });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'gdrive_list_failed', status: parsed.status };
  const items = (Array.isArray(parsed.body.files) ? parsed.body.files : []).map(mapDriveFile);
  return { count: items.length, items };
}

async function gdriveSearch({ accessToken, args, fetchImpl }) {
  const query = String(args?.query || args?.q || '').trim();
  if (!query) return { error: 'missing_fields', message: 'query es obligatorio.' };
  const limit = clampLimit(args?.limit, 20, 50);
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('pageSize', String(limit));
  url.searchParams.set('fields', 'files(id,name,mimeType,size,webViewLink,modifiedTime)');
  url.searchParams.set('q', `trashed=false and fullText contains '${query.replace(/'/g, "\\'")}'`);
  const response = await fetchImpl(url, { headers: jsonHeaders(accessToken) });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'gdrive_search_failed', status: parsed.status };
  const items = (Array.isArray(parsed.body.files) ? parsed.body.files : []).map(mapDriveFile);
  return { count: items.length, items };
}

async function gdriveReadText({ accessToken, args, fetchImpl }) {
  const fileId = String(args?.fileId || args?.id || '').trim();
  if (!fileId) return { error: 'missing_fields', message: 'fileId es obligatorio.' };
  const metaResponse = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`, {
    headers: jsonHeaders(accessToken),
  });
  const meta = await readJson(metaResponse);
  if (!meta.ok) return { error: 'gdrive_read_failed', status: meta.status };
  if (!isProbablyText(meta.body.mimeType, meta.body.name)) {
    return { error: 'not_text', message: 'Solo se leen archivos de texto pequeños.' };
  }
  const contentResponse = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!contentResponse.ok) return { error: 'gdrive_read_failed', status: contentResponse.status };
  const body = await readTextBody(contentResponse);
  if (body.error) return body;
  return { id: meta.body.id, name: meta.body.name || null, ...body };
}

async function gdriveUpload({ accessToken, args, fetchImpl, approved }) {
  if (!approved) {
    return { error: 'approval_required', message: 'Subir a Google Drive requiere confirmación.' };
  }
  const name = String(args?.name || args?.filename || '').trim();
  if (!name) return { error: 'missing_fields', message: 'name es obligatorio.' };
  const content = String(args?.content || args?.text || '');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > UPLOAD_MAX_BYTES) return { error: 'file_too_large', message: 'El archivo supera el límite de subida.' };
  const mimeType = String(args?.mimeType || 'text/plain').slice(0, 120);
  const folderId = String(args?.folderId || '').trim();
  const metadata = { name: name.slice(0, 200), mimeType };
  if (folderId) metadata.parents = [folderId];
  const boundary = 'sira_gdrive_boundary';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const response = await fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: jsonHeaders(accessToken, { 'Content-Type': `multipart/related; boundary=${boundary}` }),
    body,
  });
  const parsed = await readJson(response);
  if (!parsed.ok) return { error: 'gdrive_upload_failed', status: parsed.status };
  return mapDriveFile(parsed.body);
}

const EXECUTORS = Object.freeze({
  github_list_repos: githubListRepos,
  github_create_issue: githubCreateIssue,
  linkedin_read_profile: linkedinReadProfile,
  linkedin_publish_post: linkedinPublishPost,
  x_list_mentions: xListMentions,
  x_publish_post: xPublishPost,
  onedrive_list: onedriveList,
  onedrive_search: onedriveSearch,
  onedrive_read_text: onedriveReadText,
  onedrive_upload: onedriveUpload,
  gdrive_list: gdriveList,
  gdrive_search: gdriveSearch,
  gdrive_read_text: gdriveReadText,
  gdrive_upload: gdriveUpload,
});

module.exports = {
  EXECUTORS,
  githubListRepos,
  githubCreateIssue,
  linkedinReadProfile,
  linkedinPublishPost,
  xListMentions,
  xPublishPost,
  onedriveList,
  onedriveSearch,
  onedriveReadText,
  onedriveUpload,
  gdriveList,
  gdriveSearch,
  gdriveReadText,
  gdriveUpload,
};
