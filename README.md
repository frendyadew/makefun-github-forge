# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/frendyadew/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/frendyadew/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, written from scratch for make.fun's
**Build a GitHub-compatible git forge** bounty ($500 in USDC): git smart HTTP (protocol v2
upload-pack, v0 receive-pack), the REST v3 resources, the GraphQL v4 documents `gh` and
`github-mcp-server` send, and an MCP endpoint over streamable HTTP. No runtime dependencies, no
internet, no git binary in the trial: the standard library and the source in this repository only.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every REST answer is `application/json` and carries a non-empty `X-GitHub-Request-Id`; a request
without `Authorization: Bearer <token>` is 401; another owner's repository is 404, never 403.

## Layout

- `main.ts`: the lifecycle the harness drives the server with — bind an ephemeral port, `POST
  $MAKEFUN_ENV_URL/register` with `{"port":N}`, poll `GET $MAKEFUN_ENV_URL/done`, exit 0 when it
  says `true`. Kept as it came.
- `app.ts`: the router — it dispatches every request above to the modules below.
- `store.ts`: the data model — repositories, refs, git objects, trees, issues, pull requests,
  comments and labels, with the ancestry and reachability walks the git protocol needs.
- `git.ts`: the git smart HTTP server — v2 and v0 capability advertisements, `ls-refs`, upload-pack
  with `have`/`depth`/`shallow`/`deepen` and a pack writer, receive-pack with per-ref status lines.
- `rest.ts`: the REST v3 surface.
- `graphql.ts`: the GraphQL v4 surface — documents, mutations, introspection and pagination.
- `mcp.ts`: the MCP endpoint — the six tools the suite calls, over the same store as REST.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

## Licence

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=07sf4ft9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
