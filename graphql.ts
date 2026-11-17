// graphql.ts — a small, hand-rolled GraphQL engine for exactly the documents
// the suite sends: aliases, variables (including nested input objects),
// inline fragments, enums, lists, introspection, batching and the five
// mutations. No dependency; the parser is a tiny tokenizer + recursive
// descent over the query text.
//
// Unknown fields return HTTP 200 with an `errors` entry naming the field
// (the suite asserts on the message), and the rest of the document still
// resolves. Cursors are standard base64 of the issue/pull number.

import { currentBaseTip, diffFileMaps, mergeConflicts, b64url, type Forge, type Issue, type Label, type Pull, type Repo, type ScenarioUser } from './store.ts';
import { parseCommit } from './objects.ts';

// -------------------------------------------------------------------------------------------
// Values and the document parser
// -------------------------------------------------------------------------------------------

export type GqlValue =
  | { t: 'str'; v: string }
  | { t: 'int'; v: number }
  | { t: 'float'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'enum'; v: string }
  | { t: 'var'; name: string }
  | { t: 'list'; items: GqlValue[] }
  | { t: 'obj'; fields: Record<string, GqlValue> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  children: FieldNode[];
  /** Inline fragment type condition, when this node is `... on T { ... }`. */
  inlineType: string | null;
  /** Named fragment reference, when this node is `...Name`. */
  spread: string | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Record<string, GqlValue>;
  fields: FieldNode[];
}

export interface Document {
  operations: Operation[];
  fragments: Record<string, FieldNode[]>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!=@[]|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        const c = source[i] as string;
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += map[esc] ?? esc;
            i += 2;
          }
          continue;
        }
        value += c;
        i += 1;
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments: Record<string, FieldNode[]> = {};
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variableDefaults: {}, fields: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const variableDefaults: Record<string, GqlValue> = {};
        const maybeParen = this.peek();
        if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
          this.next();
          while (true) {
            const ahead = this.peek();
            if (ahead !== undefined && ahead.kind === 'punct' && ahead.value === ')') {
              this.next();
              break;
            }
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseTypeName();
            const after = this.peek();
            if (after !== undefined && after.kind === 'punct' && after.value === '=') {
              this.next();
              variableDefaults[varName] = this.parseValue();
            }
          }
        }
        operations.push({ kind, name, variableDefaults, fields: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragmentName = this.expectName();
        this.expectName('on');
        this.expectName();
        fragments[fragmentName] = this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseTypeName(): void {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    const bang = this.peek();
    if (bang !== undefined && bang.kind === 'punct' && bang.value === '!') this.next();
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return fields;
      }
      fields.push(this.parseField());
    }
  }

  private parseField(): FieldNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const after = this.peek();
      if (after !== undefined && after.kind === 'name' && after.value === 'on') {
        this.next();
        const typeName = this.expectName();
        return { alias: null, name: '...inline', args: {}, children: this.parseSelectionSet(), inlineType: typeName, spread: null };
      }
      if (after !== undefined && after.kind === 'name') {
        const name = this.next().value;
        return { alias: null, name: '...spread', args: {}, children: [], inlineType: null, spread: name };
      }
      throw new Error('malformed fragment in GraphQL document');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    const paren = this.peek();
    if (paren !== undefined && paren.kind === 'punct' && paren.value === '(') {
      this.next();
      for (;;) {
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'punct' && ahead.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    // Directives: @include(if:) / @skip(if:) — only `if: true/false` is honoured.
    let include = true;
    for (;;) {
      const at = this.peek();
      if (at === undefined || at.kind !== 'punct' || at.value !== '@') break;
      this.next();
      const directive = this.expectName();
      const dirArgs: Record<string, GqlValue> = {};
      const maybeParen = this.peek();
      if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
        this.next();
        for (;;) {
          const ahead = this.peek();
          if (ahead !== undefined && ahead.kind === 'punct' && ahead.value === ')') {
            this.next();
            break;
          }
          const argName = this.expectName();
          this.expectPunct(':');
          dirArgs[argName] = this.parseValue();
        }
      }
      void dirArgs;
      if (directive === 'skip' || directive === 'include') {
        const raw = dirArgs['if'];
        const value = raw !== undefined && raw.t === 'bool' ? raw.v : true;
        if (directive === 'skip') include = include && !value;
        else include = include && value;
      }
    }
    const brace = this.peek();
    const children = brace !== undefined && brace.kind === 'punct' && brace.value === '{' ? this.parseSelectionSet() : [];
    if (!include) return { alias, name: '__skipped__', args: {}, children: [], inlineType: null, spread: null };
    return { alias, name, args, children, inlineType: null, spread: null };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return { t: 'str', v: token.value };
    if (token.kind === 'int') return { t: 'int', v: Number(token.value) };
    if (token.kind === 'float') return { t: 'float', v: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { t: 'bool', v: true };
      if (token.value === 'false') return { t: 'bool', v: false };
      if (token.value === 'null') return { t: 'null' };
      return { t: 'enum', v: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { t: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      for (;;) {
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'punct' && ahead.value === ']') {
          this.next();
          return { t: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      for (;;) {
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'punct' && ahead.value === '}') {
          this.next();
          return { t: 'obj', fields };
        }
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
    }
    throw new Error(`unexpected value token ${token.value} in GraphQL document`);
  }
}

/** Resolve a parsed value against the request variables (with defaults). */
export function resolveValue(value: GqlValue, variables: Record<string, unknown>, defaults: Record<string, GqlValue>): unknown {
  switch (value.t) {
    case 'str':
    case 'int':
    case 'float':
    case 'bool':
      return value.v;
    case 'null':
      return null;
    case 'enum':
      return value.v;
    case 'var': {
      if (Object.prototype.hasOwnProperty.call(variables, value.name)) return variables[value.name];
      const fallback = defaults[value.name];
      return fallback === undefined ? null : resolveValue(fallback, variables, defaults);
    }
    case 'list':
      return value.items.map((item) => resolveValue(item, variables, defaults));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = resolveValue(inner, variables, defaults);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// Runtime values and cursors
// -------------------------------------------------------------------------------------------

export interface GqlContext {
  forge: Forge;
}

type AnyObject = Record<string, unknown> & { __typename: string };

function userNode(forge: Forge, user: ScenarioUser): AnyObject {
  return { __typename: 'User', user, id: b64url(`User:${user.id}`) };
}

function repoNode(forge: Forge, repo: Repo): AnyObject {
  return { __typename: 'Repository', repo, id: forge.repoGlobalId(repo) };
}

function issueNode(forge: Forge, repo: Repo, issue: Issue): AnyObject {
  return { __typename: 'Issue', repo, issue, id: forge.issueGlobalId(repo, issue) };
}

function pullNode(forge: Forge, repo: Repo, pull: Pull): AnyObject {
  return { __typename: 'PullRequest', repo, pull, id: forge.pullGlobalId(repo, pull) };
}

function cursorFor(number: number): string {
  return Buffer.from(String(number)).toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

interface Page<T> {
  items: T[];
  hasNextPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function paginate<T>(ordered: T[], key: (item: T) => number, args: Record<string, unknown>): Page<T> {
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : undefined;
  let start = 0;
  if (typeof args['after'] === 'string') {
    const afterNumber = numberFromCursor(args['after']);
    if (afterNumber !== null) {
      const index = ordered.findIndex((item) => key(item) === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const window = first === undefined ? ordered.slice(start) : ordered.slice(start, start + first);
  const hasNextPage = start + window.length < ordered.length;
  return {
    items: window,
    hasNextPage,
    startCursor: window.length === 0 ? null : cursorFor(key(window[0] as T)),
    endCursor: window.length === 0 ? null : cursorFor(key(window[window.length - 1] as T)),
  };
}

function stateFilter(args: Record<string, unknown>): ((state: 'open' | 'closed') => boolean) | null {
  const states = args['states'];
  if (!Array.isArray(states) || states.length === 0) return null;
  const wanted = new Set(states.map((state) => String(state).toLowerCase()));
  return (state) => wanted.has(state);
}

// -------------------------------------------------------------------------------------------
// The field registry
// -------------------------------------------------------------------------------------------

type Resolver = (parent: AnyObject, args: Record<string, unknown>, ctx: GqlContext) => unknown;

const FIELDS: Record<string, string[]> = {
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'type', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'private', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'files', 'repository', 'url'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'message', 'abbreviatedOid', 'committedDate', 'author'],
  Label: ['id', 'name', 'color', 'description'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changeType', 'status', 'changes'],
  Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  TypeField: ['name', 'description', 'type'],
  TypeRef: ['name', 'kind', 'ofType'],
  EnumValue: ['name', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'LABEL', 'MILESTONE', 'TOPIC', 'PACKAGE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueCreatedAt(forge: Forge, issue: Issue): string {
  return new Date((1_735_689_600 + issue.createdSeq) * 1000).toISOString();
}

function orderIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  const sorted = [...issues];
  const orderBy = args['orderBy'];
  let direction = 'DESC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>)['direction'];
    if (typeof dir === 'string') direction = dir.toUpperCase();
  }
  sorted.sort((a, b) => {
    const byCreated = a.createdSeq - b.createdSeq;
    const byNumber = a.number - b.number;
    const cmp = byCreated !== 0 ? byCreated : byNumber;
    return direction === 'ASC' ? cmp : -cmp;
  });
  return sorted;
}

function orderPulls(pulls: Pull[], args: Record<string, unknown>): Pull[] {
  const sorted = [...pulls];
  const orderBy = args['orderBy'];
  let direction = 'DESC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>)['direction'];
    if (typeof dir === 'string') direction = dir.toUpperCase();
  }
  sorted.sort((a, b) => {
    const cmp = a.createdSeq - b.createdSeq !== 0 ? a.createdSeq - b.createdSeq : a.number - b.number;
    return direction === 'ASC' ? cmp : -cmp;
  });
  return sorted;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  User: {
    id: (parent) => parent['id'],
    login: (parent) => (parent['user'] as ScenarioUser).login,
    name: (parent) => (parent['user'] as ScenarioUser).name,
    email: (parent) => (parent['user'] as ScenarioUser).email,
    avatarUrl: (parent) => `https://avatars.example.invalid/${(parent['user'] as ScenarioUser).login}`,
    url: (parent) => `https://github.example.com/${(parent['user'] as ScenarioUser).login}`,
    type: () => 'User',
    createdAt: () => '2025-01-01T00:00:00.000Z',
  },
  Repository: {
    id: (parent) => parent['id'],
    databaseId: (parent) => (parent['repo'] as Repo).id,
    name: (parent) => (parent['repo'] as Repo).name,
    nameWithOwner: (parent) => `${(parent['repo'] as Repo).owner}/${(parent['repo'] as Repo).name}`,
    owner: (parent, _args, ctx) => userNode(ctx.forge, ctx.forge.viewer),
    description: (parent) => (parent['repo'] as Repo).description,
    isPrivate: (parent) => (parent['repo'] as Repo).isPrivate,
    private: (parent) => (parent['repo'] as Repo).isPrivate,
    defaultBranchRef: (parent) => {
      const repo = parent['repo'] as Repo;
      return { __typename: 'Ref', name: repo.defaultBranch, repo };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (parent) => new Date((1_735_689_600 + (parent['repo'] as Repo).createdSeq) * 1000).toISOString(),
    updatedAt: (parent) => new Date((1_735_689_600 + (parent['repo'] as Repo).updatedSeq) * 1000).toISOString(),
    url: (parent) => `https://github.example.com/${(parent['repo'] as Repo).owner}/${(parent['repo'] as Repo).name}`,
    issue: (parent, args, ctx) => {
      const repo = parent['repo'] as Repo;
      const issue = repo.issues.find((candidate) => candidate.number === (args['number'] as number));
      return issue === undefined ? null : issueNode(ctx.forge, repo, issue);
    },
    issues: (parent, args, ctx) => {
      const repo = parent['repo'] as Repo;
      const filter = stateFilter(args);
      const ordered = orderIssues(repo.issues.filter((issue) => filter === null || filter(issue.state)), args);
      const page = paginate(ordered, (issue) => issue.number, args);
      return { __typename: 'IssueConnection', repo, page, forge: ctx.forge };
    },
    pullRequest: (parent, args, ctx) => {
      const repo = parent['repo'] as Repo;
      const pull = repo.pulls.find((candidate) => candidate.number === (args['number'] as number));
      return pull === undefined ? null : pullNode(ctx.forge, repo, pull);
    },
    pullRequests: (parent, args, ctx) => {
      const repo = parent['repo'] as Repo;
      const filter = stateFilter(args);
      const ordered = orderPulls(repo.pulls.filter((pull) => filter === null || filter(pull.state)), args);
      const page = paginate(ordered, (pull) => pull.number, args);
      return { __typename: 'PullRequestConnection', repo, page, forge: ctx.forge };
    },
    labels: (parent, args) => {
      const repo = parent['repo'] as Repo;
      const labels = [...repo.labels.values()];
      const page = paginate(labels, (label) => label.id, args);
      return { __typename: 'LabelConnection', repo, page };
    },
  },
  Issue: {
    id: (parent) => parent['id'],
    number: (parent) => (parent['issue'] as Issue).number,
    title: (parent) => (parent['issue'] as Issue).title,
    body: (parent) => (parent['issue'] as Issue).body,
    state: (parent) => issueState(parent['issue'] as Issue),
    createdAt: (parent, _args, ctx) => issueCreatedAt(ctx.forge, parent['issue'] as Issue),
    updatedAt: (parent) => new Date((1_735_689_600 + (parent['issue'] as Issue).updatedSeq) * 1000).toISOString(),
    closedAt: (parent) => (parent['issue'] as Issue).closedAt,
    author: (parent, _args, ctx) => userNode(ctx.forge, ctx.forge.viewer),
    labels: (parent, args) => {
      const issue = parent['issue'] as Issue;
      const page = paginate(issue.labels, (label) => label.id, args);
      return { __typename: 'LabelConnection', page };
    },
    comments: (parent, args, ctx) => {
      const issue = parent['issue'] as Issue;
      const page = paginate(issue.comments, (comment) => comment.id, args);
      return { __typename: 'IssueCommentConnection', repo: parent['repo'] as Repo, issue, page, forge: ctx.forge };
    },
    repository: (parent, _args, ctx) => repoNode(ctx.forge, parent['repo'] as Repo),
    url: (parent) => `https://github.example.com/${(parent['repo'] as Repo).owner}/${(parent['repo'] as Repo).name}/issues/${(parent['issue'] as Issue).number}`,
  },
  IssueComment: {
    id: (parent) => parent['id'],
    body: (parent) => (parent['comment'] as { body: string }).body,
    author: (parent, _args, ctx) => userNode(ctx.forge, ctx.forge.viewer),
    createdAt: (parent) => new Date((1_735_689_600 + (parent['comment'] as { createdSeq: number }).createdSeq) * 1000).toISOString(),
    updatedAt: (parent) => new Date((1_735_689_600 + (parent['comment'] as { createdSeq: number }).createdSeq) * 1000).toISOString(),
    url: (parent) => `https://github.example.com/${(parent['repo'] as Repo).owner}/${(parent['repo'] as Repo).name}/issues/${(parent['issue'] as Issue).number}#issuecomment-${(parent['comment'] as { id: number }).id}`,
    issue: (parent, _args, ctx) => issueNode(ctx.forge, parent['repo'] as Repo, parent['issue'] as Issue),
  },
  PullRequest: {
    id: (parent) => parent['id'],
    number: (parent) => (parent['pull'] as Pull).number,
    title: (parent) => (parent['pull'] as Pull).title,
    body: (parent) => (parent['pull'] as Pull).body,
    state: (parent) => pullState(parent['pull'] as Pull),
    merged: (parent) => (parent['pull'] as Pull).merged,
    mergeable: (parent, _args, ctx) => {
      const pull = parent['pull'] as Pull;
      const repo = parent['repo'] as Repo;
      if (pull.state !== 'open') return 'UNKNOWN';
      return mergeConflicts(ctx.forge, repo, currentBaseTip(repo, pull), pull.headSha) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (parent) => (parent['pull'] as Pull).headRef,
    baseRefName: (parent) => (parent['pull'] as Pull).baseRef,
    headRefOid: (parent) => (parent['pull'] as Pull).headSha,
    baseRefOid: (parent) => (parent['pull'] as Pull).baseSha,
    author: (parent, _args, ctx) => userNode(ctx.forge, ctx.forge.viewer),
    createdAt: (parent) => new Date((1_735_689_600 + (parent['pull'] as Pull).createdSeq) * 1000).toISOString(),
    updatedAt: (parent) => new Date((1_735_689_600 + (parent['pull'] as Pull).createdSeq) * 1000).toISOString(),
    closedAt: (parent) => (parent['pull'] as Pull).closedAt,
    mergedAt: (parent) => (parent['pull'] as Pull).mergedAt,
    files: (parent, args, ctx) => {
      const pull = parent['pull'] as Pull;
      const repo = parent['repo'] as Repo;
      const base = ctx.forge.mergeBase(repo, currentBaseTip(repo, pull), pull.headSha) ?? pull.baseSha;
      const baseCommit = repo.objects.get(base);
      const headCommit = repo.objects.get(pull.headSha);
      const baseMap = baseCommit === undefined ? new Map() : ctx.forge.treeFileMap(repo, parseCommit(baseCommit.data).tree);
      const headMap = headCommit === undefined ? new Map() : ctx.forge.treeFileMap(repo, parseCommit(headCommit.data).tree);
      const changes = diffFileMaps(repo, baseMap, headMap);
      const files = changes.map((change, index) => ({
        __typename: 'PullRequestChangedFile',
        n: index + 1,
        path: change.path,
        filename: change.path,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        status: change.status,
        changes: change.additions + change.deletions,
      }));
      const page = paginate(files, (file) => file.n, args);
      return { __typename: 'PullRequestChangedFileConnection', page };
    },
    repository: (parent, _args, ctx) => repoNode(ctx.forge, parent['repo'] as Repo),
    url: (parent) => `https://github.example.com/${(parent['repo'] as Repo).owner}/${(parent['repo'] as Repo).name}/pull/${(parent['pull'] as Pull).number}`,
  },
  Ref: {
    name: (parent) => (parent as unknown as { name: string }).name,
    target: (parent) => {
      const repo = (parent as unknown as { repo: Repo }).repo;
      const name = (parent as unknown as { name: string }).name;
      const tip = repo.refs.get(`refs/heads/${name}`);
      if (tip === undefined) return null;
      const object = repo.objects.get(tip);
      if (object === undefined || object.type !== 'commit') return null;
      const commit = parseCommit(object.data);
      return { __typename: 'Commit', oid: tip, message: commit.message, repo };
    },
  },
  Commit: {
    oid: (parent) => (parent as unknown as { oid: string }).oid,
    message: (parent) => (parent as unknown as { message: string }).message,
    abbreviatedOid: (parent) => (parent as unknown as { oid: string }).oid.slice(0, 7),
    committedDate: () => '2025-01-01T00:00:00.000Z',
    author: (parent, _args, ctx) => userNode(ctx.forge, ctx.forge.viewer),
  },
  Label: {
    id: (parent) => (parent as unknown as Label).id,
    name: (parent) => (parent as unknown as Label).name,
    color: (parent) => (parent as unknown as Label).color,
    description: (parent) => (parent as unknown as Label).description,
  },
  IssueConnection: {
    nodes: (parent, _args, ctx) => (parent['page'] as Page<Issue>).items.map((issue) => issueNode(ctx.forge, parent['repo'] as Repo, issue)),
    edges: (parent, _args, ctx) => (parent['page'] as Page<Issue>).items.map((issue) => ({ __typename: 'IssueEdge', node: issueNode(ctx.forge, parent['repo'] as Repo, issue), cursor: cursorFor(issue.number) })),
    pageInfo: (parent) => ({ __typename: 'PageInfo', hasNextPage: (parent['page'] as Page<Issue>).hasNextPage, hasPreviousPage: false, startCursor: (parent['page'] as Page<Issue>).startCursor, endCursor: (parent['page'] as Page<Issue>).endCursor }),
    totalCount: (parent) => (parent['repo'] as Repo).issues.length,
  },
  PullRequestConnection: {
    nodes: (parent, _args, ctx) => (parent['page'] as Page<Pull>).items.map((pull) => pullNode(ctx.forge, parent['repo'] as Repo, pull)),
    edges: (parent, _args, ctx) => (parent['page'] as Page<Pull>).items.map((pull) => ({ __typename: 'PullRequestEdge', node: pullNode(ctx.forge, parent['repo'] as Repo, pull), cursor: cursorFor(pull.number) })),
    pageInfo: (parent) => ({ __typename: 'PageInfo', hasNextPage: (parent['page'] as Page<Pull>).hasNextPage, hasPreviousPage: false, startCursor: (parent['page'] as Page<Pull>).startCursor, endCursor: (parent['page'] as Page<Pull>).endCursor }),
    totalCount: (parent) => (parent['repo'] as Repo).pulls.length,
  },
  IssueCommentConnection: {
    nodes: (parent, _args, ctx) => {
      const repo = parent['repo'] as Repo;
      const issue = parent['issue'] as Issue;
      return (parent['page'] as Page<{ id: number; body: string; createdSeq: number }>).items.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment, id: ctx.forge.commentGlobalId(repo, issue, comment as never) }));
    },
    edges: (parent, _args, ctx) => {
      const repo = parent['repo'] as Repo;
      const issue = parent['issue'] as Issue;
      return (parent['page'] as Page<{ id: number; body: string; createdSeq: number }>).items.map((comment) => ({ __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', repo, issue, comment, id: ctx.forge.commentGlobalId(repo, issue, comment as never) }, cursor: cursorFor(comment.id) }));
    },
    pageInfo: (parent) => ({ __typename: 'PageInfo', hasNextPage: (parent['page'] as Page<unknown>).hasNextPage, hasPreviousPage: false, startCursor: (parent['page'] as Page<unknown>).startCursor, endCursor: (parent['page'] as Page<unknown>).endCursor }),
    totalCount: (parent) => (parent['issue'] as Issue).comments.length,
  },
  LabelConnection: {
    nodes: (parent) => (parent['page'] as Page<Label>).items.map((label) => ({ __typename: 'Label', ...label })),
    edges: (parent) => (parent['page'] as Page<Label>).items.map((label) => ({ __typename: 'LabelEdge', node: { __typename: 'Label', ...label }, cursor: cursorFor(label.id) })),
    pageInfo: (parent) => ({ __typename: 'PageInfo', hasNextPage: (parent['page'] as Page<Label>).hasNextPage, hasPreviousPage: false, startCursor: (parent['page'] as Page<Label>).startCursor, endCursor: (parent['page'] as Page<Label>).endCursor }),
    totalCount: (parent) => (parent['page'] as Page<Label>).items.length,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => (parent['page'] as Page<AnyObject>).items,
    edges: (parent) => (parent['page'] as Page<AnyObject>).items.map((file, index) => ({ __typename: 'PullRequestChangedFileEdge', node: file, cursor: cursorFor(index + 1) })),
    pageInfo: (parent) => ({ __typename: 'PageInfo', hasNextPage: (parent['page'] as Page<AnyObject>).hasNextPage, hasPreviousPage: false, startCursor: (parent['page'] as Page<AnyObject>).startCursor, endCursor: (parent['page'] as Page<AnyObject>).endCursor }),
    totalCount: (parent) => (parent['page'] as Page<AnyObject>).items.length,
  },
  IssueEdge: {
    node: (parent) => (parent as unknown as { node: unknown }).node,
    cursor: (parent) => (parent as unknown as { cursor: string }).cursor,
  },
  PullRequestEdge: {
    node: (parent) => (parent as unknown as { node: unknown }).node,
    cursor: (parent) => (parent as unknown as { cursor: string }).cursor,
  },
  IssueCommentEdge: {
    node: (parent) => (parent as unknown as { node: unknown }).node,
    cursor: (parent) => (parent as unknown as { cursor: string }).cursor,
  },
  LabelEdge: {
    node: (parent) => (parent as unknown as { node: unknown }).node,
    cursor: (parent) => (parent as unknown as { cursor: string }).cursor,
  },
  PullRequestChangedFileEdge: {
    node: (parent) => (parent as unknown as { node: unknown }).node,
    cursor: (parent) => (parent as unknown as { cursor: string }).cursor,
  },
  PageInfo: {
    hasNextPage: (parent) => (parent as unknown as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (parent) => (parent as unknown as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (parent) => (parent as unknown as { startCursor: string | null }).startCursor,
    endCursor: (parent) => (parent as unknown as { endCursor: string | null }).endCursor,
  },
  PullRequestChangedFile: {
    path: (parent) => (parent as unknown as { path: string }).path,
    filename: (parent) => (parent as unknown as { filename: string }).filename,
    additions: (parent) => (parent as unknown as { additions: number }).additions,
    deletions: (parent) => (parent as unknown as { deletions: number }).deletions,
    changeType: (parent) => (parent as unknown as { changeType: string }).changeType,
    status: (parent) => (parent as unknown as { status: string }).status,
    changes: (parent) => (parent as unknown as { changes: number }).changes,
  },
  Type: {
    name: (parent) => (parent as unknown as { name: string }).name,
    kind: (parent) => (parent as unknown as { kind: string }).kind,
    description: () => '',
    fields: (parent) => {
      const name = (parent as unknown as { name: string }).name;
      const fields = FIELDS[name] ?? [];
      return fields.map((field) => ({ __typename: 'TypeField', name: field, type: { __typename: 'TypeRef', name: 'String', kind: 'SCALAR', ofType: null } }));
    },
    enumValues: (parent) => {
      const name = (parent as unknown as { name: string }).name;
      return (ENUM_VALUES[name] ?? []).map((value) => ({ __typename: 'EnumValue', name: value }));
    },
  },
  TypeField: {
    name: (parent) => (parent as unknown as { name: string }).name,
    description: () => '',
    type: (parent) => (parent as unknown as { type: unknown }).type,
  },
  TypeRef: {
    name: (parent) => (parent as unknown as { name: string }).name,
    kind: (parent) => (parent as unknown as { kind: string }).kind,
    ofType: (parent) => (parent as unknown as { ofType: unknown }).ofType,
  },
  EnumValue: {
    name: (parent) => (parent as unknown as { name: string }).name,
    description: () => '',
  },
  CreateIssuePayload: {
    issue: (parent) => (parent as unknown as { issue: unknown }).issue,
    clientMutationId: (parent) => (parent as unknown as { clientMutationId: string | null }).clientMutationId,
  },
  CloseIssuePayload: {
    issue: (parent) => (parent as unknown as { issue: unknown }).issue,
    clientMutationId: (parent) => (parent as unknown as { clientMutationId: string | null }).clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => (parent as unknown as { pullRequest: unknown }).pullRequest,
    clientMutationId: (parent) => (parent as unknown as { clientMutationId: string | null }).clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => (parent as unknown as { pullRequest: unknown }).pullRequest,
    clientMutationId: (parent) => (parent as unknown as { clientMutationId: string | null }).clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (parent) => (parent as unknown as { commentEdge: unknown }).commentEdge,
    subject: (parent) => (parent as unknown as { subject: unknown }).subject,
    clientMutationId: (parent) => (parent as unknown as { clientMutationId: string | null }).clientMutationId,
  },
  CommentEdge: {
    node: (parent) => (parent as unknown as { node: unknown }).node,
    cursor: (parent) => (parent as unknown as { cursor: string }).cursor,
  },
};

// -------------------------------------------------------------------------------------------
// Mutations
// -------------------------------------------------------------------------------------------

function clientMutationIdOf(input: Record<string, unknown>): string | null {
  const value = input['clientMutationId'];
  return typeof value === 'string' ? value : null;
}

function doCreateIssue(ctx: GqlContext, input: Record<string, unknown>): { payload: AnyObject; error: string | null } {
  const repositoryId = input['repositoryId'];
  const title = input['title'];
  if (typeof repositoryId !== 'string' || typeof title !== 'string' || title.length === 0) {
    return { payload: { __typename: 'CreateIssuePayload', issue: null, clientMutationId: clientMutationIdOf(input) }, error: 'createIssue requires repositoryId and title' };
  }
  const resolved = ctx.forge.resolveGlobalId(repositoryId);
  if (resolved === null || resolved.kind !== 'Repository') {
    return { payload: { __typename: 'CreateIssuePayload', issue: null, clientMutationId: clientMutationIdOf(input) }, error: 'repository not found' };
  }
  const repo = resolved.repo;
  const number = repo.nextNumber++;
  const seq = ctx.forge.nextSeq();
  const issue: Issue = {
    id: ctx.forge.nextId(),
    number,
    title,
    body: typeof input['body'] === 'string' ? (input['body'] as string) : '',
    state: 'open',
    labels: [],
    userLogin: ctx.forge.viewer.login,
    createdSeq: seq,
    updatedSeq: seq,
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  repo.updatedSeq = seq;
  return { payload: { __typename: 'CreateIssuePayload', issue: issueNode(ctx.forge, repo, issue), clientMutationId: clientMutationIdOf(input) }, error: null };
}

function doCloseIssue(ctx: GqlContext, input: Record<string, unknown>): { payload: AnyObject; error: string | null } {
  const issueId = input['issueId'];
  if (typeof issueId !== 'string') {
    return { payload: { __typename: 'CloseIssuePayload', issue: null, clientMutationId: clientMutationIdOf(input) }, error: 'closeIssue requires issueId' };
  }
  const resolved = ctx.forge.resolveGlobalId(issueId);
  if (resolved === null || resolved.kind !== 'Issue' || resolved.issue === undefined) {
    return { payload: { __typename: 'CloseIssuePayload', issue: null, clientMutationId: clientMutationIdOf(input) }, error: 'issue not found' };
  }
  const issue = resolved.issue;
  const seq = ctx.forge.nextSeq();
  issue.state = 'closed';
  issue.updatedSeq = seq;
  issue.closedAt = new Date((1_735_689_600 + seq) * 1000).toISOString();
  return { payload: { __typename: 'CloseIssuePayload', issue: issueNode(ctx.forge, resolved.repo, issue), clientMutationId: clientMutationIdOf(input) }, error: null };
}

function doCreatePullRequest(ctx: GqlContext, input: Record<string, unknown>): { payload: AnyObject; error: string | null } {
  const repositoryId = input['repositoryId'];
  const title = input['title'];
  const headRefName = input['headRefName'];
  const baseRefName = input['baseRefName'];
  if (typeof repositoryId !== 'string' || typeof title !== 'string' || typeof headRefName !== 'string' || typeof baseRefName !== 'string') {
    return { payload: { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationIdOf(input) }, error: 'createPullRequest requires repositoryId, title, headRefName and baseRefName' };
  }
  const resolved = ctx.forge.resolveGlobalId(repositoryId);
  if (resolved === null || resolved.kind !== 'Repository') {
    return { payload: { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationIdOf(input) }, error: 'repository not found' };
  }
  const repo = resolved.repo;
  const headSha = repo.refs.get(`refs/heads/${headRefName}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
  if (headSha === undefined || baseSha === undefined) {
    return { payload: { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationIdOf(input) }, error: 'head or base branch not found' };
  }
  const number = repo.nextNumber++;
  const seq = ctx.forge.nextSeq();
  const pull: Pull = {
    id: ctx.forge.nextId(),
    number,
    title,
    body: typeof input['body'] === 'string' ? (input['body'] as string) : '',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    headRef: headRefName,
    baseRef: baseRefName,
    headSha,
    baseSha,
    userLogin: ctx.forge.viewer.login,
    createdSeq: seq,
  };
  repo.pulls.push(pull);
  repo.updatedSeq = seq;
  return { payload: { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(ctx.forge, repo, pull), clientMutationId: clientMutationIdOf(input) }, error: null };
}

function doMergePullRequest(ctx: GqlContext, input: Record<string, unknown>): { payload: AnyObject; error: string | null } {
  const pullRequestId = input['pullRequestId'];
  if (typeof pullRequestId !== 'string') {
    return { payload: { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: clientMutationIdOf(input) }, error: 'mergePullRequest requires pullRequestId' };
  }
  const resolved = ctx.forge.resolveGlobalId(pullRequestId);
  if (resolved === null || resolved.kind !== 'PullRequest' || resolved.pull === undefined) {
    return { payload: { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: clientMutationIdOf(input) }, error: 'pull request not found' };
  }
  const pull = resolved.pull;
  const repo = resolved.repo;
  if (pull.state !== 'open') {
    return { payload: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx.forge, repo, pull), clientMutationId: clientMutationIdOf(input) }, error: 'pull request is not open' };
  }
  const baseTip = currentBaseTip(repo, pull);
  if (mergeConflicts(ctx.forge, repo, baseTip, pull.headSha)) {
    return { payload: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx.forge, repo, pull), clientMutationId: clientMutationIdOf(input) }, error: 'merge conflict' };
  }
  const headCommit = repo.objects.get(pull.headSha);
  if (headCommit === undefined || headCommit.type !== 'commit') {
    return { payload: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx.forge, repo, pull), clientMutationId: clientMutationIdOf(input) }, error: 'head commit not found' };
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
  pull.mergedAt = new Date((1_735_689_600 + seq) * 1000).toISOString();
  pull.closedAt = pull.mergedAt;
  repo.updatedSeq = seq;
  return { payload: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx.forge, repo, pull), clientMutationId: clientMutationIdOf(input) }, error: null };
}

function doAddComment(ctx: GqlContext, input: Record<string, unknown>): { payload: AnyObject; error: string | null } {
  const subjectId = input['subjectId'];
  const body = input['body'];
  if (typeof subjectId !== 'string' || typeof body !== 'string') {
    return { payload: { __typename: 'AddCommentPayload', commentEdge: null, subject: null, clientMutationId: clientMutationIdOf(input) }, error: 'addComment requires subjectId and body' };
  }
  const resolved = ctx.forge.resolveGlobalId(subjectId);
  if (resolved === null || resolved.kind !== 'Issue' || resolved.issue === undefined) {
    return { payload: { __typename: 'AddCommentPayload', commentEdge: null, subject: null, clientMutationId: clientMutationIdOf(input) }, error: 'subject not found' };
  }
  const issue = resolved.issue;
  const repo = resolved.repo;
  const seq = ctx.forge.nextSeq();
  const comment = { id: repo.nextCommentId++, body, userLogin: ctx.forge.viewer.login, createdSeq: seq };
  issue.comments.push(comment);
  issue.updatedSeq = seq;
  repo.updatedSeq = seq;
  const node = { __typename: 'IssueComment', repo, issue, comment, id: ctx.forge.commentGlobalId(repo, issue, comment) };
  return {
    payload: {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'CommentEdge', node, cursor: cursorFor(comment.id) },
      subject: issueNode(ctx.forge, repo, issue),
      clientMutationId: clientMutationIdOf(input),
    },
    error: null,
  };
}

// -------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------

interface ExecutionResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

function resolveField(
  parent: AnyObject,
  parentType: string,
  field: FieldNode,
  variables: Record<string, unknown>,
  defaults: Record<string, GqlValue>,
  ctx: GqlContext,
  errors: Array<{ message: string }>,
): unknown {
  if (field.name === '__skipped__') return undefined;
  if (field.name === '__typename') return parentType;
  const table = RESOLVERS[parentType];
  const resolver = table?.[field.name];
  if (resolver === undefined) {
    errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return null;
  }
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, variables, defaults);
  return resolver(parent, args, ctx);
}

function executeSelection(
  parent: AnyObject,
  parentType: string,
  fields: FieldNode[],
  doc: Document,
  variables: Record<string, unknown>,
  defaults: Record<string, GqlValue>,
  ctx: GqlContext,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === '__skipped__') continue;
    if (field.name === '...inline') {
      if (field.inlineType === parentType) {
        Object.assign(out, executeSelection(parent, parentType, field.children, doc, variables, defaults, ctx, errors));
      }
      continue;
    }
    if (field.name === '...spread') {
      const fragment = field.spread === null ? undefined : doc.fragments[field.spread];
      if (fragment !== undefined) {
        Object.assign(out, executeSelection(parent, parentType, fragment, doc, variables, defaults, ctx, errors));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const value = resolveField(parent, parentType, field, variables, defaults, ctx, errors);
    if (value === undefined) continue;
    if (field.children.length === 0 || value === null) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in item) {
          return executeSelection(item as AnyObject, (item as AnyObject).__typename, field.children, doc, variables, defaults, ctx, errors);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in value) {
      out[key] = executeSelection(value as AnyObject, (value as AnyObject).__typename, field.children, doc, variables, defaults, ctx, errors);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function resolveRootField(
  field: FieldNode,
  operation: Operation,
  variables: Record<string, unknown>,
  ctx: GqlContext,
  errors: Array<{ message: string }>,
): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, variables, operation.variableDefaults);
  const forge = ctx.forge;
  switch (field.name) {
    case 'viewer':
      return userNode(forge, forge.viewer);
    case 'repository': {
      const owner = args['owner'];
      const name = args['name'];
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = forge.getOwnRepo(owner, name);
      return repo === undefined ? null : repoNode(forge, repo);
    }
    case 'node': {
      const id = args['id'];
      if (typeof id !== 'string') return null;
      const resolved = forge.resolveGlobalId(id);
      if (resolved === null) return null;
      if (resolved.kind === 'Repository') return repoNode(forge, resolved.repo);
      if (resolved.kind === 'Issue' && resolved.issue !== undefined) return issueNode(forge, resolved.repo, resolved.issue);
      if (resolved.kind === 'PullRequest' && resolved.pull !== undefined) return pullNode(forge, resolved.repo, resolved.pull);
      if (resolved.kind === 'IssueComment' && resolved.issue !== undefined && resolved.comment !== undefined) {
        return { __typename: 'IssueComment', repo: resolved.repo, issue: resolved.issue, comment: resolved.comment, id: forge.commentGlobalId(resolved.repo, resolved.issue, resolved.comment) };
      }
      return null;
    }
    case '__type': {
      const name = args['name'];
      if (typeof name !== 'string') return null;
      if (FIELDS[name] !== undefined) return { __typename: 'Type', name, kind: 'OBJECT' };
      if (ENUM_VALUES[name] !== undefined) return { __typename: 'Type', name, kind: 'ENUM' };
      return null;
    }
    case 'createIssue': {
      const input = args['input'];
      if (input === null || typeof input !== 'object') {
        errors.push({ message: 'createIssue requires an input object.' });
        return null;
      }
      const { payload, error } = doCreateIssue(ctx, input as Record<string, unknown>);
      if (error !== null) errors.push({ message: error });
      return payload;
    }
    case 'closeIssue': {
      const input = args['input'];
      if (input === null || typeof input !== 'object') {
        errors.push({ message: 'closeIssue requires an input object.' });
        return null;
      }
      const { payload, error } = doCloseIssue(ctx, input as Record<string, unknown>);
      if (error !== null) errors.push({ message: error });
      return payload;
    }
    case 'createPullRequest': {
      const input = args['input'];
      if (input === null || typeof input !== 'object') {
        errors.push({ message: 'createPullRequest requires an input object.' });
        return null;
      }
      const { payload, error } = doCreatePullRequest(ctx, input as Record<string, unknown>);
      if (error !== null) errors.push({ message: error });
      return payload;
    }
    case 'mergePullRequest': {
      const input = args['input'];
      if (input === null || typeof input !== 'object') {
        errors.push({ message: 'mergePullRequest requires an input object.' });
        return null;
      }
      const { payload, error } = doMergePullRequest(ctx, input as Record<string, unknown>);
      if (error !== null) errors.push({ message: error });
      return payload;
    }
    case 'addComment': {
      const input = args['input'];
      if (input === null || typeof input !== 'object') {
        errors.push({ message: 'addComment requires an input object.' });
        return null;
      }
      const { payload, error } = doAddComment(ctx, input as Record<string, unknown>);
      if (error !== null) errors.push({ message: error });
      return payload;
    }
    default:
      errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
      return null;
  }
}

export function executeGraphQL(forge: Forge, body: unknown): unknown {
  const ctx: GqlContext = { forge };
  if (Array.isArray(body)) {
    return body.map((item) => executeOne(ctx, item));
  }
  return executeOne(ctx, body);
}

function executeOne(ctx: GqlContext, body: unknown): ExecutionResult {
  if (body === null || typeof body !== 'object') {
    return { errors: [{ message: 'GraphQL request body must be an object.' }] };
  }
  const request = body as Record<string, unknown>;
  const query = request['query'];
  if (typeof query !== 'string') {
    return { errors: [{ message: 'GraphQL request must include a query string.' }] };
  }
  const variables = (request['variables'] !== null && typeof request['variables'] === 'object' ? (request['variables'] as Record<string, unknown>) : {});
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  const operationName = typeof request['operationName'] === 'string' ? request['operationName'] : null;
  const operation = operationName === null
    ? doc.operations[0]
    : doc.operations.find((candidate) => candidate.name === operationName);
  if (operation === undefined) {
    return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  }
  const errors: Array<{ message: string }> = [];
  const data: Record<string, unknown> = {};
  for (const field of operation.fields) {
    if (field.name === '__skipped__') continue;
    if (field.name === '...inline' || field.name === '...spread') continue;
    const key = field.alias ?? field.name;
    const value = resolveRootField(field, operation, variables, ctx, errors);
    if (value === null || field.children.length === 0) {
      data[key] = value;
      continue;
    }
    if (typeof value === 'object' && '__typename' in value) {
      data[key] = executeSelection(value as AnyObject, (value as AnyObject).__typename, field.children, doc, variables, operation.variableDefaults, ctx, errors);
      continue;
    }
    data[key] = value;
  }
  const result: ExecutionResult = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}
