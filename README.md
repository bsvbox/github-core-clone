# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bsvbox/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bsvbox/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: smart HTTP clone and push, REST v3 repositories/issues/pull requests/contents, GraphQL, and MCP tools, all served from its own in-memory store. No UI, no outside service, no git binary. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only.

The env origin is in `MAKEFUN_ENV_URL`. The forge binds an ephemeral port, registers it with `POST $MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done` until the suite finishes and exits 0. With `MAKEFUN_ENV_URL` unset it serves on `PORT` (default 3000) for local testing, authenticated with `MAKEFUN_SHOP_TOKEN` (default `local-test-token`).

## Layout

- `main.ts`: the lifecycle (bind, register, wait for done, exit).
- `app.ts`: the HTTP server and router.
- `forge/util.ts`: SHA-1, pkt-line, base64 and small helpers.
- `forge/scenario.ts`: the viewer identity, derived from the contest's fixed scenario seed.
- `forge/gitcore.ts`: git objects, trees, commits, packs, reachability, diffs and merges.
- `forge/store.ts`: the in-memory store: repositories, refs, issues, pull requests, labels, comments.
- `forge/gitproto.ts`: git smart HTTP (info/refs, upload-pack v0/v2, receive-pack).
- `forge/rest.ts`: GitHub REST v3.
- `forge/graphql.ts`: GitHub GraphQL v4 (hand-rolled executor for the shapes `gh` and `github-mcp-server` send).
- `forge/mcp.ts`: Model Context Protocol over streamable HTTP (server/discover, initialize, tools/list, tools/call).

---

<sub>Entered on [make.fun](https://make.fun/?ref=4eqvbahr&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
