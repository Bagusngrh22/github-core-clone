// git.ts — git smart HTTP: info/refs advertisements (v0 + protocol v2),
// ls-refs, fetch (v2 sections and v0) and receive-pack with report-status.
//
// The wire shape is the one the suite's own client speaks (kit program/env/src
// git-client.ts): pkt-line framing, side-band-64k pack delivery, shallow
// boundaries, per-ref ok/ng report lines. Packs sent are plain (no deltas);
// the client verifies hashes and checksums, never the delta count.

import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineFlush,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './objects.ts';
import { peelToCommit, type Forge, type Repo } from './store.ts';

const AGENT = 'forge/1.0';

export interface GitRequest {
  owner: string;
  repo: string;
  service: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function reply(status: number, contentType: string, body: Buffer): GitReply {
  return { status, contentType, body };
}

function jsonReply(status: number, body: unknown): GitReply {
  return reply(status, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

function notFound(): GitReply {
  return jsonReply(404, { message: 'Not Found' });
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The peeled commit of a tag ref, or null when the ref is not an annotated tag. */
function peeledOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function v0UploadAdvertisement(repo: Repo): Buffer {
  const caps = `symref=HEAD:${defaultBranchRef(repo)} multi_ack_detailed thin-pack side-band-64k ofs-delta shallow agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktLineFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.refs.get(defaultBranchRef(repo));
    const lines: string[] = [];
    if (head !== undefined) lines.push(`${head} HEAD\0${caps}`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}`);
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}`);
    }
    // The capabilities ride on the first line only.
    parts.push(encodePktLines(lines.map((line, index) => (index === 0 && head === undefined ? `${line}\0${caps}\n` : `${line}\n`))));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const caps = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktLineFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.refs.get(defaultBranchRef(repo));
    const lines: string[] = [];
    if (head !== undefined) lines.push(`${head} HEAD\0${caps}`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}`);
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}`);
    }
    parts.push(encodePktLines(lines.map((line, index) => (index === 0 && head === undefined ? `${line}\0${caps}\n` : `${line}\n`))));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLines([
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow thin-pack ofs-delta\n',
      'object-format=sha1\n',
      'flush',
    ]),
  ]);
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to put in the pack, in a stable order. */
  objects: GitObject[];
  /** New shallow boundary commits (depth == requested depth). */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
}

/**
 * Plan a fetch: which commits to send, which objects they need, and the new
 * shallow boundary. `wants` are commit/tag oids; `haves` and `boundaries`
 * are commits the client already holds (as objects, not ancestry).
 */
function planFetch(
  forge: Forge,
  repo: Repo,
  wants: readonly string[],
  haves: ReadonlySet<string>,
  boundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const effectiveDepth = depth ?? Number.POSITIVE_INFINITY;
  const wantSet = new Set<string>();
  const held = new Set<string>(haves);
  for (const boundary of boundaries) held.add(boundary);

  // Resolve wants: tags contribute their object and peel to a commit want.
  const tagObjects: GitObject[] = [];
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push(object);
      const target = peelToCommit(repo, want);
      if (target !== want) queue.push({ oid: target, depth: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
      wantSet.add(want);
    }
  }

  const visitedDepth = new Map<string, number>();
  const included = new Set<string>();
  const boundaryAtDepth = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth: at } = queue.shift() as { oid: string; depth: number };
    const seen = visitedDepth.get(oid);
    if (seen !== undefined && seen <= at) continue;
    visitedDepth.set(oid, at);
    const isHeld = held.has(oid);
    const isWant = wantSet.has(oid);
    if (isHeld && !isWant) continue; // already held: neither sent nor traversed
    if (at > effectiveDepth) continue;
    if (!isHeld) included.add(oid);
    if (at === effectiveDepth) boundaryAtDepth.add(oid);
    if (at >= effectiveDepth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: at + 1 });
  }

  // Objects: included commits + their tree closures, minus what the client holds.
  const candidates = new Map<string, GitObject>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    const seenTrees = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seenTrees.has(oid)) continue;
      seenTrees.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tree') {
        candidates.set(oid, object);
        for (const entry of parseTree(object.data)) {
          const child = repo.objects.get(entry.oid);
          if (child === undefined) continue;
          if (child.type === 'tree') stack.push(entry.oid);
          else candidates.set(entry.oid, child);
        }
      }
    }
  };
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    candidates.set(oid, object);
    if (object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
  }
  for (const tag of tagObjects) candidates.set(hashObject(tag.type, tag.data), tag);

  // Subtract everything the client already holds as objects: each held commit
  // itself plus its tree closure (not its ancestry: a held commit's parents
  // are not held unless listed).
  const heldObjects = new Set<string>();
  for (const oid of held) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    heldObjects.add(oid);
    if (object.type === 'commit') {
      const closure = new Map<string, GitObject>();
      const stack = [parseCommit(object.data).tree];
      const seenTrees = new Set<string>();
      while (stack.length > 0) {
        const treeOid = stack.pop() as string;
        if (seenTrees.has(treeOid)) continue;
        seenTrees.add(treeOid);
        const tree = repo.objects.get(treeOid);
        if (tree === undefined) continue;
        if (tree.type === 'tree') {
          closure.set(treeOid, tree);
          for (const entry of parseTree(tree.data)) {
            const child = repo.objects.get(entry.oid);
            if (child === undefined) continue;
            if (child.type === 'tree') stack.push(entry.oid);
            else closure.set(entry.oid, child);
          }
        }
      }
      for (const heldOid of closure.keys()) heldObjects.add(heldOid);
    }
  }
  const objects: GitObject[] = [];
  for (const [oid, object] of [...candidates.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!heldObjects.has(oid)) objects.push(object);
  }

  const shallow = depth === undefined ? [] : [...boundaryAtDepth].sort();
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const boundary of boundaries) {
      const at = visitedDepth.get(boundary);
      if (at !== undefined && at < effectiveDepth) unshallow.push(boundary);
    }
  }
  return { objects, shallow, unshallow: unshallow.sort() };
}

/** Split pack bytes into sideband pkt-lines (band 1), chunked under the limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const maxData = 65515;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) packets.push(encodePktLine(Buffer.from([1])));
  return packets;
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

function handleInfoRefs(forge: Forge, req: GitRequest): GitReply {
  const repo = forge.getOwnRepo(req.owner, req.repo);
  if (repo === undefined) return notFound();
  if (req.service === 'git-upload-pack') {
    if (req.headers['git-protocol'] === 'version=2') {
      return reply(200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    }
    return reply(200, 'application/x-git-upload-pack-advertisement', v0UploadAdvertisement(repo));
  }
  if (req.service === 'git-receive-pack') {
    return reply(200, 'application/x-git-receive-pack-advertisement', v0ReceiveAdvertisement(repo));
  }
  return jsonReply(400, { message: 'Bad Request' });
}

function lsRefsV2(forge: Forge, repo: Repo, lines: string[]): GitReply {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') { /* reported below when applicable */ }
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const headTip = repo.refs.get(defaultBranchRef(repo));
  if (keep('HEAD')) {
    if (headTip === undefined) out.push(`unborn HEAD${symrefs ? ` symref-target:${defaultBranchRef(repo)}` : ''}\n`);
    else out.push(`${headTip} HEAD${symrefs ? ` symref-target:${defaultBranchRef(repo)}` : ''}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  out.push('flush');
  return reply(200, 'application/x-git-upload-pack-result', encodePktLines(out));
}

function fetchV2(forge: Forge, repo: Repo, lines: string[]): GitReply {
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const plan = planFetch(forge, repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent `have`
  // lines to negotiate over: a fresh fetch (no haves, `done` straight away)
  // is answered with the packfile directly, as real git expects.
  if (haves.size > 0) {
    parts.push(encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), pktLineFlush());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const section: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of plan.shallow) section.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) section.push(`unshallow ${oid}\n`);
    section.push('flush');
    parts.push(encodePktLines(section));
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return reply(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function fetchV0(forge: Forge, repo: Repo, lines: string[]): GitReply {
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const plan = planFetch(forge, repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return reply(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleUploadPack(forge: Forge, req: GitRequest): GitReply {
  const repo = forge.getOwnRepo(req.owner, req.repo);
  if (repo === undefined) return notFound();
  let packets;
  try {
    packets = decodePktLines(req.body);
  } catch {
    return jsonReply(400, { message: 'Bad Request' });
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    else if (packet.kind === 'flush') break;
  }
  if (req.headers['git-protocol'] === 'version=2') {
    const command = lines[0] ?? '';
    if (command === 'command=ls-refs') {
      // Lines after the delim are the arguments.
      const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
      const args: string[] = [];
      if (delimAt >= 0) {
        for (const packet of packets.slice(delimAt + 1)) {
          if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
          else if (packet.kind === 'flush') break;
        }
      }
      return lsRefsV2(forge, repo, args);
    }
    if (command === 'command=fetch') {
      const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
      const args: string[] = [];
      if (delimAt >= 0) {
        for (const packet of packets.slice(delimAt + 1)) {
          if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
          else if (packet.kind === 'flush') break;
        }
      }
      return fetchV2(forge, repo, args);
    }
    return jsonReply(400, { message: 'Bad Request' });
  }
  // v0: wants, then flush, then haves + done.
  return fetchV0(forge, repo, lines);
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

function handleReceivePack(forge: Forge, req: GitRequest): GitReply {
  const repo = forge.getOwnRepo(req.owner, req.repo);
  if (repo === undefined) return notFound();
  // Parse pkt-lines until the first flush; the rest is the pack.
  const body = req.body;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let offset = 0;
  let packStart = body.length;
  try {
    for (;;) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line');
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line header');
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (length < 4 || length > 65520 || offset + length > body.length) throw new Error('bad pkt-line length');
      const payload = body.subarray(offset + 4, offset + length).toString('utf8');
      const line = payload.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const head = nul >= 0 ? line.slice(0, nul) : line;
      const parts = head.split(' ');
      if (parts.length !== 3) throw new Error('bad receive-pack command');
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) throw new Error('bad receive-pack command');
      commands.push({ oldOid, newOid, ref });
      offset += length;
    }
  } catch {
    return jsonReply(400, { message: 'Bad Request' });
  }
  if (commands.length === 0) return jsonReply(400, { message: 'Bad Request' });

  const reportLines: string[] = [];
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of objects) {
        if (hashObject(object.type, object.data) !== oid) throw new Error(`object ${oid} failed its hash check`);
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  // Decide each ref, then apply the accepted ones.
  const decisions: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      decisions.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) decisions.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) decisions.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      else decisions.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      decisions.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) decisions.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      else decisions.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      decisions.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const tip = peelToCommit(repo, command.newOid);
    if (!forge.isAncestor(repo, current, tip)) {
      decisions.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    decisions.push({ ref: command.ref, ok: true, reason: '' });
  }
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index] as { oldOid: string; newOid: string; ref: string };
    const decision = decisions[index] as { ref: string; ok: boolean; reason: string };
    if (!decision.ok) continue;
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }

  if (unpackOk) reportLines.push('unpack ok\n');
  else reportLines.push(`unpack ${unpackDetail}\n`);
  for (const decision of decisions) {
    reportLines.push(decision.ok ? `ok ${decision.ref}\n` : `ng ${decision.ref} ${decision.reason}\n`);
  }
  // The report stream is pkt-lined inside band 1 and must end with its own
  // flush packet there: real git reads the report until that flush, and an
  // end of the outer stream alone reads as "the remote end hung up".
  const report = Buffer.concat([encodePktLines(reportLines), pktLineFlush()]);
  const band1 = encodePktLine(Buffer.concat([Buffer.from([1]), report]));
  return reply(200, 'application/x-git-receive-pack-result', Buffer.concat([band1, pktLineFlush()]));
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

/**
 * Route one git smart-HTTP request. `segments` are the path parts after the
 * leading slash: [owner, "<repo>.git", ...rest].
 */
export function handleGit(forge: Forge, segments: string[], query: URLSearchParams, headers: Record<string, string | undefined>, body: Buffer): GitReply {
  const owner = segments[0] ?? '';
  const repoDotGit = segments[1] ?? '';
  if (!repoDotGit.endsWith('.git')) return notFound();
  const repo = repoDotGit.slice(0, -4);
  const rest = segments.slice(2);
  const req: GitRequest = { owner, repo, service: '', query, headers, body };
  if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    req.service = query.get('service') ?? '';
    return handleInfoRefs(forge, req);
  }
  if (rest.length === 1 && rest[0] === 'git-upload-pack') {
    return handleUploadPack(forge, req);
  }
  if (rest.length === 1 && rest[0] === 'git-receive-pack') {
    return handleReceivePack(forge, req);
  }
  return notFound();
}
