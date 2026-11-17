// store.ts — the forge's in-memory state and the deterministic scenario identity.
//
// The suite's scenario is fixed by one public seed (wire.ts SCENARIO_SEED): the
// viewer login the bearer token names is the scenario's first generated user.
// The generator below re-derives it from that seed with the same pure functions
// the kit publishes, so the forge knows who its token owner is without ever
// seeing the scenario file itself. Nothing here reads a clock or Math.random:
// every timestamp and id comes from monotonic counters, so two runs fed the same
// requests behave identically (the replay rule).

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './objects.ts';

// ---------------------------------------------------------------------------
// The seeded scenario identity (pure derivation from the public seed)
// ---------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** The scenario's users, in order: [viewer, teammate, stranger, ...]. */
export function scenarioUsers(count: number): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

// ---------------------------------------------------------------------------
// Deterministic time and ids
// ---------------------------------------------------------------------------

/** Fixed epoch (2025-01-01T00:00:00Z); every timestamp is this plus a counter. */
export const EPOCH_SEC = 1_735_689_600;

export function isoAt(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The data model
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdSeq: number;
  updatedSeq: number;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  /** Shared issue + pull request counter (GitHub numbers them together). */
  nextNumber: number;
  nextCommentId: number;
  /** Monotonic per-repo commit counter (timestamps + ordering). */
  commitSeq: number;
}

export class Forge {
  readonly viewer: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  /** Creation order, for GET /user/repos pagination. */
  readonly repoOrder: Repo[] = [];
  private nextRepoId = 1;
  private nextObjectId = 1;
  private seq = 0;

  constructor() {
    const users = scenarioUsers(12);
    this.viewer = users[0] as ScenarioUser;
    this.stranger = users[2] as ScenarioUser;
  }

  /** The next monotonic sequence number (creation order + timestamps). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextId(): number {
    this.nextObjectId += 1;
    return this.nextObjectId;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Only the viewer's repositories exist; any other owner is a 404. */
  getOwnRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.getRepo(owner, name);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.getRepo(this.viewer.login, name) !== undefined) return null;
    const seq = this.nextSeq();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewer.login,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: seq,
      updatedSeq: seq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      commitSeq: 0,
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    const at = this.repoOrder.indexOf(repo);
    if (at >= 0) this.repoOrder.splice(at, 1);
  }

  // ---------------------------------------------------------------------------
  // Global (Relay) ids: opaque, stable, decodable.
  // ---------------------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return b64url(`Repository:${repo.id}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64url(`Issue:${repo.id}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return b64url(`PullRequest:${repo.id}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return b64url(`IssueComment:${repo.id}:${issue.number}:${comment.id}`);
  }

  /** Resolve a global id to a repository, issue, pull request or comment. */
  resolveGlobalId(id: string): { kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment'; repo: Repo; issue?: Issue; pull?: Pull; comment?: IssueComment } | null {
    const text = unb64url(id);
    if (text === null) return null;
    const parts = text.split(':');
    const kind = parts[0];
    const repoId = Number(parts[1]);
    if (!Number.isSafeInteger(repoId)) return null;
    const repo = this.repoOrder.find((candidate) => candidate.id === repoId);
    if (repo === undefined) return null;
    if (kind === 'Repository') return { kind, repo };
    if (kind === 'Issue') {
      const issue = repo.issues.find((candidate) => candidate.number === Number(parts[2]));
      return issue === undefined ? null : { kind, repo, issue };
    }
    if (kind === 'PullRequest') {
      const pull = repo.pulls.find((candidate) => candidate.number === Number(parts[2]));
      return pull === undefined ? null : { kind, repo, pull };
    }
    if (kind === 'IssueComment') {
      const issue = repo.issues.find((candidate) => candidate.number === Number(parts[2]));
      const comment = issue?.comments.find((candidate) => candidate.id === Number(parts[3]));
      return issue === undefined || comment === undefined ? null : { kind, repo, issue, comment };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Git object helpers, per repository
  // ---------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The identity line for a commit this forge authors. */
  identityLine(timestampSec: number): string {
    return `${this.viewer.name} <${this.viewer.email}> ${timestampSec} +0000`;
  }

  /** Create and store a commit object; returns its oid. */
  createCommit(repo: Repo, fields: { tree: string; parents: readonly string[]; message: string }): string {
    repo.commitSeq += 1;
    const timestampSec = EPOCH_SEC + repo.commitSeq;
    const who = this.identityLine(timestampSec);
    const data = buildCommit({ tree: fields.tree, parents: fields.parents, message: fields.message, author: who, committer: who });
    return this.putObject(repo, 'commit', data);
  }

  /** A commit's file map: path -> {oid, mode}, by walking its tree. */
  treeFileMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the tree for a file map; returns the root tree oid. */
  mapToTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The file map at a ref's tip (empty when the ref does not exist). */
  refFileMap(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> {
    const tip = repo.refs.get(ref);
    if (tip === undefined) return new Map();
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return this.treeFileMap(repo, parseCommit(commit.data).tree);
  }

  /** True when `ancestor` is reachable from `descendant` (or they are equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The merge-base of two commits (nearest common ancestor by commit order), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    // Walk b's ancestry newest-first (by commit sequence) and take the first hit.
    const order = new Map<string, number>();
    const collect = (start: string): void => {
      const queue = [start];
      while (queue.length > 0) {
        const oid = queue.pop() as string;
        if (order.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        order.set(oid, repoCommitSeq(repo, oid));
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    };
    collect(b);
    let best: string | null = null;
    let bestSeq = -1;
    for (const oid of ancestorsA) {
      const seq = order.get(oid);
      if (seq !== undefined && seq > bestSeq) {
        bestSeq = seq;
        best = oid;
      }
    }
    return best;
  }

  /** All ancestors of a commit, including itself, in newest-first order. */
  commitHistory(repo: Repo, tip: string): string[] {
    const order = new Map<string, number>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (order.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      order.set(oid, repoCommitSeq(repo, oid));
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return [...order.entries()].sort((x, y) => y[1] - x[1]).map(([oid]) => oid);
  }
}

/** A commit's sequence number, from its timestamp (forge commits) or 0 (foreign). */
function repoCommitSeq(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return 0;
  const commit = parseCommit(object.data);
  const match = / (\d+) \+0000$/.exec(commit.author);
  if (match === null) return 0;
  const ts = Number(match[1]);
  return ts - EPOCH_SEC;
}

// ---------------------------------------------------------------------------
// Diff and merge helpers (pure over file maps)
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

/** The changed paths between two file maps, with line counts. */
export function diffFileMaps(
  repo: Repo,
  base: Map<string, { oid: string; mode: string }>,
  head: Map<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    if (oldEntry === undefined && newEntry !== undefined) {
      const data = repo.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: countLines(data), deletions: 0 });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const data = repo.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: countLines(data) });
    } else if (oldEntry !== undefined && newEntry !== undefined) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = lineDiff(oldData, newData);
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions, deletions });
    }
  }
  return changes;
}

/** The current tip of a pull request's base branch (the recorded base sha is only where the branch was when the PR was opened). */
export function currentBaseTip(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

/** True when a squash merge of `headTip` into `baseTip` would conflict. */
export function mergeConflicts(forge: Forge, repo: Repo, baseTip: string, headTip: string): boolean {
  const base = forge.mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(headTip);
  const baseTipCommit = repo.objects.get(baseTip);
  if (baseCommit === undefined || headCommit === undefined || baseTipCommit === undefined) return false;
  const baseMap = forge.treeFileMap(repo, parseCommit(baseCommit.data).tree);
  const headMap = forge.treeFileMap(repo, parseCommit(headCommit.data).tree);
  const tipMap = forge.treeFileMap(repo, parseCommit(baseTipCommit.data).tree);
  const paths = new Set([...baseMap.keys(), ...headMap.keys(), ...tipMap.keys()]);
  for (const path of paths) {
    const inBase = baseMap.get(path)?.oid ?? null;
    const inHead = headMap.get(path)?.oid ?? null;
    const inTip = tipMap.get(path)?.oid ?? null;
    const headChanged = inHead !== inBase;
    const tipChanged = inTip !== inBase;
    if (headChanged && tipChanged && inHead !== inTip) return true;
  }
  return false;
}

/** Peel a tag object to its commit (or return the oid itself when it is not a tag). */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}
