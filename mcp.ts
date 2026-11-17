// mcp.ts — Model Context Protocol over POST /mcp (JSON-RPC 2.0, plain JSON).
//
// The suite speaks the 2026-07-28 protocol revision: `server/discover` first
// (with a legacy `initialize` fallback), then `tools/list` and `tools/call`.
// Exactly six tools, defined once in TOOLS so every `tools/list` answer is
// byte-identical. Tool results always carry both `content` (text JSON) and
// `structuredContent`. Unknown tools and bad arguments are JSON-RPC errors,
// never HTTP 500s. A non-JSON body is HTTP 400 with a -32700 parse error.

import { currentBaseTip, mergeConflicts, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { parseCommit } from './objects.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the branch containing the changes.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface JsonRpcError {
  code: number;
  message: string;
}

type JsonRpcId = string | number | null;

function success(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: JsonRpcId, error: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: forge.viewer.id },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
    created_at: new Date((1_735_689_600 + repo.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + repo.updatedSeq) * 1000).toISOString(),
    html_url: `https://github.example.com/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.userLogin },
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description })),
    created_at: new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + issue.updatedSeq) * 1000).toISOString(),
    closed_at: issue.closedAt,
    html_url: `https://github.example.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: pull.userLogin },
    created_at: new Date((1_735_689_600 + pull.createdSeq) * 1000).toISOString(),
    merged_at: pull.mergedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.example.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = args['name'];
      if (typeof repoName !== 'string' || repoName.length === 0) return { ok: false, error: 'create_repo requires a non-empty name' };
      const repo = forge.createRepo(
        repoName,
        args['private'] === true,
        typeof args['description'] === 'string' ? (args['description'] as string) : '',
      );
      if (repo === null) return { ok: false, error: `repository ${repoName} already exists` };
      return { ok: true, data: repoJson(forge, repo) };
    }
    case 'get_repo': {
      const owner = args['owner'];
      const repoName = args['repo'];
      if (typeof owner !== 'string' || typeof repoName !== 'string') return { ok: false, error: 'get_repo requires owner and repo' };
      const repo = forge.getOwnRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      return { ok: true, data: repoJson(forge, repo) };
    }
    case 'create_issue': {
      const owner = args['owner'];
      const repoName = args['repo'];
      const title = args['title'];
      if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof title !== 'string' || title.length === 0) {
        return { ok: false, error: 'create_issue requires owner, repo and a non-empty title' };
      }
      const repo = forge.getOwnRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      const number = repo.nextNumber++;
      const seq = forge.nextSeq();
      const issue: Issue = {
        id: forge.nextId(),
        number,
        title,
        body: typeof args['body'] === 'string' ? (args['body'] as string) : '',
        state: 'open',
        labels: [],
        userLogin: forge.viewer.login,
        createdSeq: seq,
        updatedSeq: seq,
        closedAt: null,
        comments: [],
      };
      repo.issues.push(issue);
      repo.updatedSeq = seq;
      return { ok: true, data: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const owner = args['owner'];
      const repoName = args['repo'];
      if (typeof owner !== 'string' || typeof repoName !== 'string') return { ok: false, error: 'list_issues requires owner and repo' };
      const repo = forge.getOwnRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      const state = typeof args['state'] === 'string' ? args['state'].toLowerCase() : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { ok: true, data: { issues: issues.map((issue) => issueJson(repo, issue)), total_count: issues.length } };
    }
    case 'create_pull_request': {
      const owner = args['owner'];
      const repoName = args['repo'];
      const title = args['title'];
      const head = args['head'];
      const base = args['base'];
      if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
        return { ok: false, error: 'create_pull_request requires owner, repo, title, head and base' };
      }
      const repo = forge.getOwnRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return { ok: false, error: 'head or base branch not found' };
      const number = repo.nextNumber++;
      const seq = forge.nextSeq();
      const pull: Pull = {
        id: forge.nextId(),
        number,
        title,
        body: typeof args['body'] === 'string' ? (args['body'] as string) : '',
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        mergedAt: null,
        closedAt: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        userLogin: forge.viewer.login,
        createdSeq: seq,
      };
      repo.pulls.push(pull);
      repo.updatedSeq = seq;
      return { ok: true, data: pullJson(repo, pull) };
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

// The merge tool is handled separately in handleMcp so it can share the
// store's squash-merge logic with the REST and GraphQL surfaces.

function mergePullRequestTool(forge: Forge, repo: Repo, pull: Pull): ToolOutcome {
  const headCommit = repo.objects.get(pull.headSha);
  if (headCommit === undefined || headCommit.type !== 'commit') return { ok: false, error: 'head commit not found' };
  const baseTip = currentBaseTip(repo, pull);
  if (mergeConflicts(forge, repo, baseTip, pull.headSha)) return { ok: false, error: 'merge conflict' };
  const tree = parseCommit(headCommit.data).tree;
  const seq = forge.nextSeq();
  const sha = forge.createCommit(repo, {
    tree,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = new Date((1_735_689_600 + seq) * 1000).toISOString();
  pull.closedAt = pull.mergedAt;
  repo.updatedSeq = seq;
  return { ok: true, data: pullJson(repo, pull) };
}

/** Handle one MCP request. Returns [status, body-object]. */
export function handleMcp(forge: Forge, body: unknown): [number, Record<string, unknown>] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body must be a JSON object' } }];
  }
  const request = body as Record<string, unknown>;
  const method = request['method'];
  const id: JsonRpcId = typeof request['id'] === 'string' || typeof request['id'] === 'number' ? (request['id'] as JsonRpcId) : null;
  if (typeof method !== 'string') {
    return [200, failure(id, { code: -32600, message: 'Invalid Request: method is required' })];
  }

  if (method === 'server/discover') {
    return [
      200,
      success(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    ];
  }
  if (method === 'initialize') {
    const params = (request['params'] !== null && typeof request['params'] === 'object' ? (request['params'] as Record<string, unknown>) : {});
    const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2026-07-28';
    return [
      200,
      success(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    ];
  }
  if (method === 'notifications/initialized') {
    return [202, {}];
  }
  if (method === 'tools/list') {
    return [200, success(id, { tools: TOOLS })];
  }
  if (method === 'tools/call') {
    const params = (request['params'] !== null && typeof request['params'] === 'object' ? (request['params'] as Record<string, unknown>) : {});
    const name = params['name'];
    if (typeof name !== 'string') {
      return [200, failure(id, { code: -32602, message: 'Invalid params: name is required' })];
    }
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return [200, failure(id, { code: -32601, message: `Method not found: ${name}` })];
    }
    const args = (params['arguments'] !== null && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {});
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined) {
        return [200, failure(id, { code: -32602, message: `Invalid params: missing required argument ${required}` })];
      }
    }
    if (name === 'merge_pull_request') {
      const owner = args['owner'];
      const repoName = args['repo'];
      const pullNumber = args['pull_number'];
      if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof pullNumber !== 'number') {
        return [200, failure(id, { code: -32602, message: 'Invalid params: owner, repo and pull_number are required' })];
      }
      const repo = forge.getOwnRepo(owner, repoName);
      if (repo === undefined) return [200, success(id, toolError(`repository ${owner}/${repoName} not found`))];
      const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
      if (pull === undefined) return [200, success(id, toolError(`pull request #${pullNumber} not found`))];
      if (pull.state !== 'open') return [200, success(id, toolError(`pull request #${pullNumber} is not open`))];
      const outcome = mergePullRequestTool(forge, repo, pull);
      return outcome.ok ? [200, success(id, toolResult(outcome.data))] : [200, success(id, toolError(outcome.error))];
    }
    const outcome = callTool(forge, name, args);
    return outcome.ok ? [200, success(id, toolResult(outcome.data))] : [200, success(id, toolError(outcome.error))];
  }
  if (method.startsWith('notifications/')) {
    return [202, {}];
  }
  return [200, failure(id, { code: -32601, message: `Method not found: ${method}` })];
}
