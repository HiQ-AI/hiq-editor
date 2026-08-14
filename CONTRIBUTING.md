# Contributing to hiq-editor

Thanks for your interest in improving hiq-editor. This project is the open
local stdio MCP client for the HiQ LCA dataset editor — it forwards business
operations to the editor server's HTTP API and adds local file capabilities.
Contributions of bug fixes, improved tool descriptions, and documentation are
welcome.

## Prerequisites

- **Node.js ≥ 20** (CI builds on Node 22).
- **npm** (the repo uses `package-lock.json`).
- An **SSO token** is needed only to exercise the live server (manual MCP / CLI
  runs) — not to build or typecheck. It is supplied via `HIQ_EDITOR_TOKEN`.

## Setup

```bash
git clone https://github.com/HiQ-AI/hiq-editor.git
cd hiq-editor
npm install
npm run build        # tsc → dist/  (this is the check a PR must pass)
```

## Architecture

This client is deliberately thin. The proprietary parts — database schema, SQL,
write/business logic, SSO internals — live in the closed editor server. This
package only knows the server's HTTP API contract:

```
hiq-editor (this, open)  ──HTTPS + Bearer SSO token──>  editor server (closed)
  • stdio MCP server (server.ts)                              • POST /tools/:name
  • CLI (cli.ts)                                              • GET  /tools
  • 16 business tools → forward to the server
  • local tools: parse_upr_template, export_process
```

| Entry | File | Transport |
|---|---|---|
| MCP server | `src/server.ts` | stdio |
| CLI | `src/cli.ts` | subprocess / shell |

- `src/serverClient.ts` — the HTTP client (`callTool`, `listTools`).
- `src/tools/forwarders.ts` — the 16 business tools (thin forwarders).
- `src/tools/local.ts` — the local-only tools (read/parse/write local files).
- `src/files.ts` — local filesystem helpers.

## Adding or changing a tool

1. A **forwarder** tool's name + description + zod schema must stay in lockstep
   with the server's tool registry — that's the contract the server validates
   against. The handler is always `(args) => callTool('<name>', args)`.
2. A **local** tool does its work on the local filesystem (use `src/files.ts`).
3. `npm run build` must pass (no `tsc` errors).

Tool `description` strings are the agent's only guide to a tool, so a wrong or
vague description is a runtime bug, not a doc nit. Keep snake_case names — the
`hiq-editor` skill and the `mcp__editor__*` namespace depend on them.

## Pull requests

- Branch from `main`, keep the change focused, and explain the "why".
- Run `npm run build` before pushing.
- Note any change to a tool's input/output shape — downstream skills and hosts
  depend on these contracts.

## Secrets

Never commit an SSO token or `.env`. The token is a per-user credential that
grants full editor access as that user; it lives only in an environment
variable (`HIQ_EDITOR_TOKEN`), never on disk in the repo. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE).
