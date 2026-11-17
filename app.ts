// app.ts — the HTTP server: routing, auth, request ids and the full REST v3
// surface, plus the GraphQL, MCP and git smart-HTTP mounts.
//
// Wire rules the suite relies on: every reply is JSON (never HTML), every
// reply carries a non-empty X-GitHub-Request-Id, unknown routes are 404 JSON
// {"message":"Not Found"}, malformed JSON is 400 JSON with a string message,
// and GET /user/repos paginates with absolute same-origin Link rel="next"
// URLs. Repositories only ever belong to the viewer: any other owner is a
// 404, never a 403.

import http from 'node:http';
import { handleGit } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  currentBaseTip,
  diffFileMaps,
  Forge,
  mergeConflicts,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { parseCommit } from './objects.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface RequestContext {
  forge: Forge;
  shopToken: string;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function isoAt(seq: number): string {
  return new Date((1_735_689_600 + seq) * 1000).toISOString();
}

function decodeSegments(pathname: string): string[] {
  return pathname.split('/').filter((part) => part.length > 0).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

// -------------------------------------------------------------------------------------------
// JSON views
// -------------------------------------------------------------------------------------------

function userJson(forge: Forge): Record<string, unknown> {
  const viewer = forge.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: Buffer.from(`User:${viewer.id}`).toString('base64url'),
    avatar_url: `https://avatars.example.invalid/${viewer.login}`,
    gravatar_id: '',
    url: `https://api.github.example.com/users/${viewer.login}`,
    html_url: `https://github.example.com/${viewer.login}`,
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  };
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: forge.viewer.id, avatar_url: `https://avatars.example.invalid/${repo.owner}`, type: 'User' },
    private: repo.isPrivate,
    html_url: `https://github.example.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.example.com/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.example.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.example.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.example.com:${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: isoAt(repo.createdSeq),
    updated_at: isoAt(repo.updatedSeq),
    pushed_at: isoAt(repo.updatedSeq),
    size: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    license: null,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, url: '' };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: forge.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.userLogin, id: forge.viewer.id, type: 'User' },
    labels: issue.labels.map(labelJson),
    created_at: isoAt(issue.createdSeq),
    updated_at: isoAt(issue.updatedSeq),
    closed_at: issue.closedAt,
    html_url: `https://github.example.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.example.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function commentJson(forge: Forge, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: forge.commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: { login: comment.userLogin, id: forge.viewer.id, type: 'User' },
    created_at: isoAt(comment.createdSeq),
    updated_at: isoAt(comment.createdSeq),
    html_url: `https://github.example.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `https://api.github.example.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: forge.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !mergeConflicts(forge, repo, currentBaseTip(repo, pull), pull.headSha) : false,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.userLogin, id: forge.viewer.id, type: 'User' },
    created_at: isoAt(pull.createdSeq),
    updated_at: isoAt(pull.createdSeq),
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    html_url: `https://github.example.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.example.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = { name: forge.viewer.name, email: forge.viewer.email, date: isoAt(0) };
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64url'),
    commit: {
      author,
      committer: author,
      message: commit.message,
      tree: { sha: commit.tree },
      url: '',
    },
    author: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    committer: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
    url: '',
    html_url: '',
  };
}

// -------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams, body: unknown) => void;

function send(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRaw(res: http.ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
  });
  res.end(body);
}

function notFound(res: http.ServerResponse): void {
  send(res, 404, { message: 'Not Found' });
}

function badRequest(res: http.ServerResponse, message: string): void {
  send(res, 400, { message });
}

function unprocessable(res: http.ServerResponse, message: string): void {
  send(res, 422, { message });
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; total: number; pageNumber: number; perPage: number } {
  const { page, perPage } = parsePagination(query);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNumber: page, perPage };
}

function linkHeader(req: http.IncomingMessage, query: URLSearchParams, total: number, pageNumber: number, perPage: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return '';
  const host = req.headers.host ?? 'localhost';
  const pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
  const build = (page: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(page));
    params.set('per_page', String(perPage));
    return `http://${host}${pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  if (pageNumber < totalPages) links.push(`<${build(pageNumber + 1)}>; rel="next"`);
  links.push(`<${build(totalPages)}>; rel="last"`);
  if (pageNumber > 1) links.push(`<${build(1)}>; rel="first"`);
  if (pageNumber > 1) links.push(`<${build(pageNumber - 1)}>; rel="prev"`);
  return links.join(', ');
}

function sendPage<T>(req: http.IncomingMessage, res: http.ServerResponse, items: T[], query: URLSearchParams, map: (item: T) => unknown): void {
  const { page, total, pageNumber, perPage } = paginate(items, query);
  const link = linkHeader(req, query, total, pageNumber, perPage);
  send(res, 200, page.map(map), link === '' ? {} : { link });
}

function parseLabelArg(value: unknown, repo: Repo): { labels: Label[]; unknownName: string | null } {
  const names: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') names.push(entry);
      else if (entry !== null && typeof entry === 'object') {
        const name = (entry as Record<string, unknown>)['name'];
        if (typeof name === 'string') names.push(name);
      }
    }
  }
  const labels: Label[] = [];
  for (const name of names) {
    const label = repo.labels.get(name);
    if (label === undefined) return { labels, unknownName: name };
    labels.push(label);
  }
  return { labels, unknownName: null };
}

// -------------------------------------------------------------------------------------------
// REST handlers
// -------------------------------------------------------------------------------------------

function handleRoot(_req: http.IncomingMessage, res: http.ServerResponse): void {
  send(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' });
}

function handleMeta(_req: http.IncomingMessage, res: http.ServerResponse): void {
  send(res, 200, { installed_version: '1.0.0' });
}

function handleGetUser(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext): void {
  send(res, 200, userJson(ctx.forge));
}

function handleListUserRepos(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, _params: Record<string, string>, query: URLSearchParams): void {
  sendPage(req, res, ctx.forge.repoOrder, query, (repo) => repoJson(ctx.forge, repo));
}

function handleCreateUserRepo(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, _params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const data = bodyObject(body);
  const name = data['name'];
  if (typeof name !== 'string' || name.length === 0) {
    unprocessable(res, 'name is required');
    return;
  }
  const repo = ctx.forge.createRepo(name, data['private'] === true, typeof data['description'] === 'string' ? (data['description'] as string) : '');
  if (repo === null) {
    unprocessable(res, `Repository ${name} already exists`);
    return;
  }
  send(res, 201, repoJson(ctx.forge, repo));
}

function handleGetRepo(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  send(res, 200, repoJson(ctx.forge, repo));
}

function handlePatchRepo(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const data = bodyObject(body);
  if (typeof data['description'] === 'string') repo.description = data['description'];
  if (typeof data['default_branch'] === 'string' && repo.refs.has(`refs/heads/${data['default_branch']}`)) repo.defaultBranch = data['default_branch'];
  if (typeof data['name'] === 'string' && data['name'] !== repo.name) {
    if (ctx.forge.getRepo(repo.owner, data['name']) !== undefined) {
      unprocessable(res, `Repository ${data['name']} already exists`);
      return;
    }
    ctx.forge.repos.delete(ctx.forge.repoKey(repo.owner, repo.name));
    repo.name = data['name'];
    ctx.forge.repos.set(ctx.forge.repoKey(repo.owner, repo.name), repo);
  }
  repo.updatedSeq = ctx.forge.nextSeq();
  send(res, 200, repoJson(ctx.forge, repo));
}

function handleDeleteRepo(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  ctx.forge.deleteRepo(repo);
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function handleListBranches(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort();
  sendPage(req, res, branches, query, (branch) => ({
    name: branch,
    commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: '' },
    protected: false,
  }));
}

function handleGetBranch(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  const branch = params['branch'] as string;
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    notFound(res);
    return;
  }
  send(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
}

function handleListCommits(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const shaParam = query.get('sha');
  let tip: string | undefined;
  if (shaParam !== null) {
    if (repo.refs.has(`refs/heads/${shaParam}`)) tip = repo.refs.get(`refs/heads/${shaParam}`);
    else if (repo.refs.has(shaParam)) tip = repo.refs.get(shaParam);
    else if (repo.objects.has(shaParam)) tip = shaParam;
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  if (tip === undefined) {
    send(res, 200, []);
    return;
  }
  const history = ctx.forge.commitHistory(repo, tip);
  sendPage(req, res, history, query, (sha) => commitJson(ctx.forge, repo, sha));
}

function handleCreateRef(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const data = bodyObject(body);
  const ref = data['ref'];
  const sha = data['sha'];
  if (typeof ref !== 'string' || typeof sha !== 'string' || !ref.startsWith('refs/')) {
    unprocessable(res, 'ref and sha are required');
    return;
  }
  if (repo.refs.has(ref)) {
    unprocessable(res, 'Reference already exists');
    return;
  }
  const object = repo.objects.get(sha);
  if (object === undefined) {
    unprocessable(res, 'Object does not exist');
    return;
  }
  repo.refs.set(ref, sha);
  repo.updatedSeq = ctx.forge.nextSeq();
  send(res, 201, { ref, node_id: '', url: '', object: { sha, type: object.type, url: '' } });
}

function handleGetRef(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  const ref = `refs/${params['ref'] as string}`;
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    notFound(res);
    return;
  }
  const object = repo.objects.get(sha);
  send(res, 200, { ref, node_id: '', url: '', object: { sha, type: object?.type ?? 'commit', url: '' } });
}

function handleListIssues(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const state = query.get('state') ?? 'open';
  const direction = (query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const items: Array<{ seq: number; json: unknown }> = [];
  for (const issue of repo.issues) {
    if (state !== 'all' && issue.state !== state) continue;
    items.push({ seq: issue.createdSeq, json: issueJson(ctx.forge, repo, issue) });
  }
  for (const pull of repo.pulls) {
    if (state !== 'all' && pull.state !== state) continue;
    const json = issueJson(ctx.forge, repo, {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      labels: [],
      userLogin: pull.userLogin,
      createdSeq: pull.createdSeq,
      updatedSeq: pull.createdSeq,
      closedAt: pull.closedAt,
      comments: [],
    });
    (json as Record<string, unknown>)['pull_request'] = { url: '' };
    items.push({ seq: pull.createdSeq, json });
  }
  items.sort((a, b) => direction * (a.seq - b.seq));
  sendPage(req, res, items, query, (item) => item.json);
}

function handleCreateIssue(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const data = bodyObject(body);
  const title = data['title'];
  if (typeof title !== 'string' || title.length === 0) {
    unprocessable(res, 'title is required');
    return;
  }
  const parsed = parseLabelArg(data['labels'], repo);
  if (parsed.unknownName !== null) {
    unprocessable(res, `Label "${parsed.unknownName}" does not exist`);
    return;
  }
  const number = repo.nextNumber++;
  const seq = ctx.forge.nextSeq();
  const issue: Issue = {
    id: ctx.forge.nextId(),
    number,
    title,
    body: typeof data['body'] === 'string' ? (data['body'] as string) : '',
    state: 'open',
    labels: parsed.labels,
    userLogin: ctx.forge.viewer.login,
    createdSeq: seq,
    updatedSeq: seq,
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  repo.updatedSeq = seq;
  send(res, 201, issueJson(ctx.forge, repo, issue));
}

function handleGetIssue(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const number = Number(params['number']);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue !== undefined) {
    send(res, 200, issueJson(ctx.forge, repo, issue));
    return;
  }
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull !== undefined) {
    const json = issueJson(ctx.forge, repo, {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      labels: [],
      userLogin: pull.userLogin,
      createdSeq: pull.createdSeq,
      updatedSeq: pull.createdSeq,
      closedAt: pull.closedAt,
      comments: [],
    });
    (json as Record<string, unknown>)['pull_request'] = { url: '' };
    send(res, 200, json);
    return;
  }
  notFound(res);
}

function handlePatchIssue(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const number = Number(params['number']);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) {
    notFound(res);
    return;
  }
  const data = bodyObject(body);
  if (typeof data['title'] === 'string') issue.title = data['title'];
  if (typeof data['body'] === 'string') issue.body = data['body'];
  if (typeof data['state'] === 'string') {
    const state = data['state'].toLowerCase();
    if (state === 'open' || state === 'closed') {
      issue.state = state;
      const seq = ctx.forge.nextSeq();
      issue.closedAt = state === 'closed' ? isoAt(seq) : null;
      issue.updatedSeq = seq;
    }
  }
  if (data['labels'] !== undefined) {
    const parsed = parseLabelArg(data['labels'], repo);
    if (parsed.unknownName !== null) {
      unprocessable(res, `Label "${parsed.unknownName}" does not exist`);
      return;
    }
    issue.labels = parsed.labels;
  }
  issue.updatedSeq = ctx.forge.nextSeq();
  send(res, 200, issueJson(ctx.forge, repo, issue));
}

function handleListComments(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const number = Number(params['number']);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) {
    notFound(res);
    return;
  }
  sendPage(req, res, issue.comments, query, (comment) => commentJson(ctx.forge, repo, issue, comment));
}

function handleCreateComment(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const number = Number(params['number']);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) {
    notFound(res);
    return;
  }
  const data = bodyObject(body);
  if (typeof data['body'] !== 'string' || data['body'].length === 0) {
    unprocessable(res, 'body is required');
    return;
  }
  const seq = ctx.forge.nextSeq();
  const comment = { id: repo.nextCommentId++, body: data['body'], userLogin: ctx.forge.viewer.login, createdSeq: seq };
  issue.comments.push(comment);
  issue.updatedSeq = seq;
  repo.updatedSeq = seq;
  send(res, 201, commentJson(ctx.forge, repo, issue, comment));
}

function handleAddLabels(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const number = Number(params['number']);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) {
    notFound(res);
    return;
  }
  const data = bodyObject(body);
  const value = Array.isArray(body) ? body : data['labels'];
  const parsed = parseLabelArg(value, repo);
  if (parsed.unknownName !== null) {
    unprocessable(res, `Label "${parsed.unknownName}" does not exist`);
    return;
  }
  for (const label of parsed.labels) {
    if (!issue.labels.some((existing) => existing.name === label.name)) issue.labels.push(label);
  }
  issue.updatedSeq = ctx.forge.nextSeq();
  send(res, 200, issue.labels.map(labelJson));
}

function handleListLabels(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  sendPage(req, res, [...repo.labels.values()], query, labelJson);
}

function handleCreateLabel(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const data = bodyObject(body);
  const name = data['name'];
  if (typeof name !== 'string' || name.length === 0) {
    unprocessable(res, 'name is required');
    return;
  }
  if (repo.labels.has(name)) {
    unprocessable(res, `Label "${name}" already exists`);
    return;
  }
  const label: Label = {
    id: ctx.forge.nextId(),
    name,
    color: typeof data['color'] === 'string' ? (data['color'] as string) : '000000',
    description: typeof data['description'] === 'string' ? (data['description'] as string) : '',
  };
  repo.labels.set(name, label);
  send(res, 201, labelJson(label));
}

function handleListPulls(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const state = query.get('state') ?? 'open';
  const direction = (query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const pulls = repo.pulls
    .filter((pull) => state === 'all' || (pull.merged ? 'closed' : pull.state) === state)
    .sort((a, b) => direction * (a.createdSeq - b.createdSeq));
  sendPage(req, res, pulls, query, (pull) => pullJson(ctx.forge, repo, pull));
}

function handleCreatePull(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const data = bodyObject(body);
  const title = data['title'];
  const head = data['head'];
  const base = data['base'];
  if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
    unprocessable(res, 'title, head and base are required');
    return;
  }
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) {
    unprocessable(res, 'head or base branch not found');
    return;
  }
  const number = repo.nextNumber++;
  const seq = ctx.forge.nextSeq();
  const pull: Pull = {
    id: ctx.forge.nextId(),
    number,
    title,
    body: typeof data['body'] === 'string' ? (data['body'] as string) : '',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    userLogin: ctx.forge.viewer.login,
    createdSeq: seq,
  };
  repo.pulls.push(pull);
  repo.updatedSeq = seq;
  send(res, 201, pullJson(ctx.forge, repo, pull));
}

function handleGetPull(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const number = Number(params['number']);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) {
    notFound(res);
    return;
  }
  send(res, 200, pullJson(ctx.forge, repo, pull));
}

function handleListPullFiles(req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const number = Number(params['number']);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) {
    notFound(res);
    return;
  }
  const base = ctx.forge.mergeBase(repo, currentBaseTip(repo, pull), pull.headSha) ?? pull.baseSha;
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(pull.headSha);
  const baseMap = baseCommit === undefined ? new Map() : ctx.forge.treeFileMap(repo, parseCommit(baseCommit.data).tree);
  const headMap = headCommit === undefined ? new Map() : ctx.forge.treeFileMap(repo, parseCommit(headCommit.data).tree);
  const changes = diffFileMaps(repo, baseMap, headMap);
  sendPage(req, res, changes, query, (change) => ({
    sha: change.newOid ?? change.oldOid ?? '',
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: '',
  }));
}

function handleMergePull(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, _body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const number = Number(params['number']);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) {
    notFound(res);
    return;
  }
  if (pull.state !== 'open') {
    send(res, 405, { message: 'Pull Request is already merged' });
    return;
  }
  // Conflicts are judged against the base branch as it is now, not where it
  // was when the PR was opened: another PR may have moved it since.
  const baseTip = currentBaseTip(repo, pull);
  if (mergeConflicts(ctx.forge, repo, baseTip, pull.headSha)) {
    send(res, 405, { message: 'Merge conflict' });
    return;
  }
  const headCommit = repo.objects.get(pull.headSha);
  if (headCommit === undefined || headCommit.type !== 'commit') {
    send(res, 405, { message: 'Head commit not found' });
    return;
  }
  const tree = parseCommit(headCommit.data).tree;
  const seq = ctx.forge.nextSeq();
  const sha = ctx.forge.createCommit(repo, {
    tree,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = isoAt(seq);
  pull.closedAt = pull.mergedAt;
  repo.updatedSeq = seq;
  send(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function handleGetContents(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, query: URLSearchParams): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const path = params['path'] ?? '';
  const refParam = query.get('ref');
  let tip: string | undefined;
  if (refParam !== null) {
    if (repo.refs.has(`refs/heads/${refParam}`)) tip = repo.refs.get(`refs/heads/${refParam}`);
    else if (repo.refs.has(refParam)) tip = repo.refs.get(refParam);
    else if (repo.objects.has(refParam)) tip = refParam;
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const files = new Map<string, { oid: string; mode: string }>();
  if (tip !== undefined) {
    const commit = repo.objects.get(tip);
    if (commit !== undefined && commit.type === 'commit') {
      for (const [path, entry] of ctx.forge.treeFileMap(repo, parseCommit(commit.data).tree)) files.set(path, entry);
    }
  }
  if (path === '') {
    const entries: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const filePath of [...files.keys()].sort()) {
      const top = filePath.split('/')[0] as string;
      if (seen.has(top)) continue;
      seen.add(top);
      const isDir = [...files.keys()].some((candidate) => candidate.startsWith(`${top}/`));
      const entry = files.get(top);
      entries.push({
        type: isDir ? 'dir' : 'file',
        name: top,
        path: top,
        sha: isDir ? '' : (entry?.oid ?? ''),
        size: isDir ? 0 : (repo.objects.get(entry?.oid ?? '')?.data.length ?? 0),
        url: '',
        html_url: '',
        download_url: isDir ? null : '',
      });
    }
    send(res, 200, entries);
    return;
  }
  const entry = files.get(path);
  if (entry !== undefined) {
    const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
    send(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() as string,
      path,
      content: data.toString('base64'),
      sha: entry.oid,
      url: '',
      html_url: '',
      download_url: '',
    });
    return;
  }
  const prefix = `${path}/`;
  const children = [...files.keys()].filter((candidate) => candidate.startsWith(prefix));
  if (children.length === 0) {
    notFound(res);
    return;
  }
  const seen = new Set<string>();
  const entries: Array<Record<string, unknown>> = [];
  for (const child of children.sort()) {
    const rest = child.slice(prefix.length);
    const top = rest.split('/')[0] as string;
    if (seen.has(top)) continue;
    seen.add(top);
    const isDir = rest.includes('/');
    const childEntry = files.get(child);
    entries.push({
      type: isDir ? 'dir' : 'file',
      name: top,
      path: `${path}/${top}`,
      sha: isDir ? '' : (childEntry?.oid ?? ''),
      size: isDir ? 0 : (repo.objects.get(childEntry?.oid ?? '')?.data.length ?? 0),
      url: '',
      html_url: '',
      download_url: isDir ? null : '',
    });
  }
  send(res, 200, entries);
}

function handlePutContents(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const path = params['path'] as string;
  const data = bodyObject(body);
  const content = data['content'];
  if (typeof content !== 'string') {
    unprocessable(res, 'content is required');
    return;
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(content, 'base64');
  } catch {
    unprocessable(res, 'content is not valid base64');
    return;
  }
  const refName = typeof data['branch'] === 'string' ? (data['branch'] as string) : repo.defaultBranch;
  const ref = `refs/heads/${refName}`;
  const tip = repo.refs.get(ref);
  const files = tip === undefined ? new Map() : ctx.forge.refFileMap(repo, ref);
  const existing = files.get(path);
  if (typeof data['sha'] === 'string') {
    if (existing === undefined || existing.oid !== data['sha']) {
      send(res, 409, { message: 'sha does not match the current blob' });
      return;
    }
  }
  const blobOid = ctx.forge.putObject(repo, 'blob', decoded);
  files.set(path, { oid: blobOid, mode: '100644' });
  const tree = ctx.forge.mapToTree(repo, files);
  const parents = tip === undefined ? [] : [tip];
  const message = typeof data['message'] === 'string' ? (data['message'] as string) : `Update ${path}`;
  const commitSha = ctx.forge.createCommit(repo, { tree, parents, message });
  repo.refs.set(ref, commitSha);
  repo.updatedSeq = ctx.forge.nextSeq();
  send(res, existing === undefined ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: decoded.length,
      name: path.split('/').pop() as string,
      path,
      content: decoded.toString('base64'),
      sha: blobOid,
      url: '',
      html_url: '',
      download_url: '',
    },
    commit: { sha: commitSha, message },
  });
}

function handleDeleteContents(_req: http.IncomingMessage, res: http.ServerResponse, ctx: RequestContext, params: Record<string, string>, _query: URLSearchParams, body: unknown): void {
  const repo = ctx.forge.getOwnRepo(params['owner'] as string, params['repo'] as string);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const path = params['path'] as string;
  const data = bodyObject(body);
  const refName = typeof data['branch'] === 'string' ? (data['branch'] as string) : repo.defaultBranch;
  const ref = `refs/heads/${refName}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) {
    notFound(res);
    return;
  }
  const files = ctx.forge.refFileMap(repo, ref);
  const existing = files.get(path);
  if (existing === undefined) {
    notFound(res);
    return;
  }
  if (typeof data['sha'] === 'string' && existing.oid !== data['sha']) {
    send(res, 409, { message: 'sha does not match the current blob' });
    return;
  }
  files.delete(path);
  const tree = ctx.forge.mapToTree(repo, files);
  const message = typeof data['message'] === 'string' ? (data['message'] as string) : `Delete ${path}`;
  const commitSha = ctx.forge.createCommit(repo, { tree, parents: [tip], message });
  repo.refs.set(ref, commitSha);
  repo.updatedSeq = ctx.forge.nextSeq();
  send(res, 200, { commit: { sha: commitSha, message } });
}

// -------------------------------------------------------------------------------------------
// routing
// -------------------------------------------------------------------------------------------

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        if (part === '*') {
          keys.push('rest');
          return '(.*)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}$`,
  );
  return { method, pattern: regex, keys, handler };
}

const ROUTES: Route[] = [
  route('GET', '/api/v3', handleRoot),
  route('GET', '/api/v3/', handleRoot),
  route('GET', '/api/v3/meta', handleMeta),
  route('GET', '/api/v3/user', handleGetUser),
  route('GET', '/api/v3/user/repos', handleListUserRepos),
  route('POST', '/api/v3/user/repos', handleCreateUserRepo),
  route('GET', '/api/v3/repos/:owner/:repo', handleGetRepo),
  route('PATCH', '/api/v3/repos/:owner/:repo', handlePatchRepo),
  route('DELETE', '/api/v3/repos/:owner/:repo', handleDeleteRepo),
  route('GET', '/api/v3/repos/:owner/:repo/branches', handleListBranches),
  route('GET', '/api/v3/repos/:owner/:repo/branches/*', (req, res, ctx, params, query, body) => {
    handleGetBranch(req, res, ctx, { ...params, branch: params['rest'] as string }, query, body);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/commits', handleListCommits),
  route('POST', '/api/v3/repos/:owner/:repo/git/refs', handleCreateRef),
  route('GET', '/api/v3/repos/:owner/:repo/git/refs/*', (req, res, ctx, params, query, body) => {
    handleGetRef(req, res, ctx, { ...params, ref: params['rest'] as string }, query, body);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/contents', (req, res, ctx, params, query, body) => {
    handleGetContents(req, res, ctx, { ...params, path: '' }, query, body);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/contents/*', (req, res, ctx, params, query, body) => {
    handleGetContents(req, res, ctx, { ...params, path: params['rest'] as string }, query, body);
  }),
  route('PUT', '/api/v3/repos/:owner/:repo/contents/*', (req, res, ctx, params, query, body) => {
    handlePutContents(req, res, ctx, { ...params, path: params['rest'] as string }, query, body);
  }),
  route('DELETE', '/api/v3/repos/:owner/:repo/contents/*', (req, res, ctx, params, query, body) => {
    handleDeleteContents(req, res, ctx, { ...params, path: params['rest'] as string }, query, body);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/issues', handleListIssues),
  route('POST', '/api/v3/repos/:owner/:repo/issues', handleCreateIssue),
  route('GET', '/api/v3/repos/:owner/:repo/issues/:number', handleGetIssue),
  route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', handlePatchIssue),
  route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', handleListComments),
  route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', handleCreateComment),
  route('POST', '/api/v3/repos/:owner/:repo/issues/:number/labels', handleAddLabels),
  route('GET', '/api/v3/repos/:owner/:repo/labels', handleListLabels),
  route('POST', '/api/v3/repos/:owner/:repo/labels', handleCreateLabel),
  route('GET', '/api/v3/repos/:owner/:repo/pulls', handleListPulls),
  route('POST', '/api/v3/repos/:owner/:repo/pulls', handleCreatePull),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', handleGetPull),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', handleListPullFiles),
  route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', handleMergePull),
];

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function needsAuth(pathname: string): boolean {
  return pathname.startsWith('/api/v3') || pathname === '/api/graphql' || pathname === '/mcp';
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): http.Server {
  const forge = new Forge();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer(forge, shopToken);
}

/** Create the forge HTTP server. The caller registers it with the harness. */
export function createServer(forge: Forge, shopToken: string): http.Server {
  const ctx: RequestContext = { forge, shopToken };
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
        const segments = decodeSegments(pathname);
        const query = url.searchParams;
        const method = req.method ?? 'GET';

        if (method === 'GET' && pathname === '/healthz') {
          send(res, 200, { ok: true });
          return;
        }

        if (needsAuth(pathname)) {
          const auth = req.headers.authorization ?? '';
          if (auth !== `Bearer ${shopToken}`) {
            send(res, 401, { message: 'Bad credentials' });
            return;
          }
        }

        const body = await readBody(req);

        // GraphQL
        if (pathname === '/api/graphql' && method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            badRequest(res, 'Problems parsing JSON');
            return;
          }
          const result = executeGraphQL(forge, parsed);
          send(res, 200, result);
          return;
        }

        // MCP
        if (pathname === '/mcp' && method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } });
            return;
          }
          const [status, payload] = handleMcp(forge, parsed);
          send(res, status, payload);
          return;
        }

        // Git smart HTTP: /:owner/:repo.git/...
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
          }
          const gitReply = handleGit(forge, segments, query, headers, body);
          sendRaw(res, gitReply.status, gitReply.contentType, gitReply.body);
          return;
        }

        // REST v3
        const jsonBody: unknown = (() => {
          if (method === 'GET' || method === 'DELETE' || body.length === 0) {
            if (method === 'DELETE' && body.length > 0) {
              try {
                return JSON.parse(body.toString('utf8'));
              } catch {
                return null;
              }
            }
            return {};
          }
          try {
            return JSON.parse(body.toString('utf8'));
          } catch {
            return Symbol.for('bad-json');
          }
        })();
        if (jsonBody === Symbol.for('bad-json')) {
          badRequest(res, 'Problems parsing JSON');
          return;
        }
        for (const routeDef of ROUTES) {
          if (routeDef.method !== method) continue;
          const match = routeDef.pattern.exec(pathname);
          if (match === null) continue;
          const params: Record<string, string> = {};
          routeDef.keys.forEach((key, index) => {
            params[key] = match[index + 1] as string;
          });
          routeDef.handler(req, res, ctx, params, query, jsonBody);
          return;
        }
        notFound(res);
      } catch (err) {
        // Never leak a stack or an HTML error page: always answer JSON.
        if (!res.headersSent) {
          send(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
