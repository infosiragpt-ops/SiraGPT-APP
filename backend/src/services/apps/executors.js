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

const EXECUTORS = Object.freeze({
  github_list_repos: githubListRepos,
  github_create_issue: githubCreateIssue,
  linkedin_read_profile: linkedinReadProfile,
  linkedin_publish_post: linkedinPublishPost,
  x_list_mentions: xListMentions,
  x_publish_post: xPublishPost,
});

module.exports = {
  EXECUTORS,
  githubListRepos,
  githubCreateIssue,
  linkedinReadProfile,
  linkedinPublishPost,
  xListMentions,
  xPublishPost,
};
