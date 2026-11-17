[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Bagusngrh22/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Bagusngrh22/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone

A GitHub-compatible git forge, built from scratch in TypeScript for the
[make.fun](https://make.fun/bounty/github-core-clone-01) bounty **“Build a
GitHub-compatible git forge”** ($500 in USDC).

One process, no dependencies, no database: the whole forge lives in memory
and speaks the protocols real GitHub clients speak.

## What it implements

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch`, shallow/deepen,
  `unshallow`) and v0, plus `receive-pack` with per-ref `report-status`
  (`ok`/`ng non-fast-forward`). Real `git clone`, `fetch`, `push` and
  `pull` work against it, including depth-1 clones, annotated tags and
  fast-forward enforcement.
- **REST v3** — repositories (create/list/get/patch/delete, pagination with
  `Link` headers), branches, commits, git refs, contents (create/update/
  delete files with sha guards), issues (labels, comments, state), and pull
  requests (create, files, squash merge with conflict detection).
- **GraphQL** — `viewer`, `repository`, `node`, `__type` introspection,
  cursor pagination, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` mutations.
- **MCP** — `server/discover`, `initialize`, `tools/list` and `tools/call`
  with six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

Authentication is a bearer token (`MAKEFUN_SHOP_TOKEN`) on every REST,
GraphQL and MCP request. All timestamps and ids are deterministic, so a
live run and its replay produce byte-identical results.

## How to run

Requires **Node 22.18+** (type stripping) or newer.

```sh
# the make.fun harness starts the bot itself; to run it standalone:
MAKEFUN_SHOP_TOKEN=<your token> MAKEFUN_ENV_URL=<harness url> \
  node --experimental-strip-types main.ts
```

Or with npm:

```sh
npm start
```

The server binds an ephemeral port, registers it with the harness, and
exits when the harness reports the trial is done.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Lifecycle: bind, register with the harness, wait for `/done`. |
| `app.ts` | HTTP server, routing, auth, the REST v3 surface. |
| `git.ts` | Git smart HTTP: advertisements, ls-refs, fetch, receive-pack. |
| `objects.ts` | Git objects, pkt-line codec, packfile read/write, deltas. |
| `store.ts` | In-memory forge state, the scenario identity, diff/merge logic. |
| `graphql.ts` | Hand-rolled GraphQL parser, executor, introspection, mutations. |
| `mcp.ts` | MCP JSON-RPC handler and the six tools. |

## License

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=w43ybwk1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
