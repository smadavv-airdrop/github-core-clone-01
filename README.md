[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/smadavv-airdrop/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/smadavv-airdrop/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a standalone GitHub-compatible git forge

A single-process, dependency-free git forge for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01).
It serves, from one in-memory store and with no git binary and no network:

- **git smart HTTP** — upload-pack protocol v2 (capability advertisement, `ls-refs`, `fetch`) and
  receive-pack v0 (`report-status`, `side-band-64k`, `delete-refs`), with fast-forward enforcement.
- **REST v3** under `/api/v3` — repositories, contents, labels, issues and pull requests.
- **GraphQL v4** at `/api/graphql` — introspection of `Issue`, `PullRequest`, `Repository`,
  `SearchType`, plus `repository.issues` ordering/state filters and `createPullRequest`.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) over the same store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The grader runs `node /bot/main.ts` on Node 22, which strips TypeScript types natively. Nothing to
install: only `node:http`, `node:zlib` and `node:crypto` are used.

## Layout

| file | what it holds |
|---|---|
| `main.ts` | harness lifecycle (bind, register, poll `/done`, exit) |
| `app.ts` | HTTP router: git smart HTTP, REST v3, GraphQL and MCP dispatch |
| `store.ts` | in-memory model + git object encode/decode (blob/tree/commit, sha1) |
| `git.ts` | pkt-line, upload-pack v2, receive-pack v0, packfile encode/decode, delta resolution |
| `graphql.ts` | the GraphQL executor for the suite's documents |
| `mcp.ts` | the MCP JSON-RPC surface and tools |

## License

MIT — see `LICENSE`.
