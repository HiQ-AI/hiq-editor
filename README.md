# @hiq-ai/hiq-editor

Agent-oriented CLI for the HiQ LCA Dataset Editor. The CLI calls the Editor's
native Spring Boot API through the existing APISIX route; it does not use MCP as
its transport. An optional stdio MCP adapter exposes the same stable domain
commands to third-party MCP hosts.

## Architecture

```text
agent / script / ctx.editor
          |
          | subprocess + JSON
          v
      hiq-editor CLI
      - validates inputs
      - aggregates native calls
      - performs readback
      - emits one JSON result
          |
          | SSO credential + userId
          v
x.hiqlcd.com/api/dataset/*  (APISIX)
          |
          v
Editor native application API
```

The CLI is an anti-corruption layer, not a generated REST proxy. Its command
surface is deliberately smaller and more stable than the Editor's endpoint
surface. DBOS or another control plane owns cross-command workflow state;
`hiq-editor` owns one operation's validation, native API sequence, and readback.

## Install

```bash
curl -fsSL https://download.hiq.earth/cli/hiq-editor/install.sh | sh
```

```powershell
irm https://download.hiq.earth/cli/hiq-editor/install.ps1 | iex
```

With Node.js installed:

```bash
npx @hiq-ai/hiq-editor doctor
```

## Authentication

Credentials are issued and validated by the existing HiQ SSO. Set exactly one:

- `HIQ_EDITOR_TOKEN`: personal SSO token or a Cortex task delegation JWT.
- `HIQ_EDITOR_API_KEY`: organization automation credential issued by HiQ SSO.
- `hiq-editor login`: interactive device login for a standalone installation.

The CLI first calls `/api/sso/user/info/current` with that credential to resolve
the authenticated `userId`, then sends the same credential plus `userId` to the
native Editor API. It does not mint, persist, or validate a second identity.

Optional endpoint configuration:

- `HIQ_EDITOR_API_URL` defaults to `https://x.hiqlcd.com/api/dataset`.
- `HIQ_EDITOR_SSO_USER_INFO_URL` defaults to
  `https://x.hiqlcd.com/api/sso/user/info/current`.

## Commands

```bash
hiq-editor doctor
hiq-editor list
hiq-editor describe upr-import

hiq-editor datasources-list --json
hiq-editor processes-list --datasource GBA --scope mine --json
hiq-editor process-show --process-id <id> --json
hiq-editor flows-search --keyword carbon --flow-type ELEMENTARY_FLOW --json
hiq-editor product-categories-search --keyword 4912 --json

hiq-editor upr-preflight \
  --file-path /absolute/path/UPR.xlsx \
  --datasource GBA \
  --product-category-code 4912 \
  --json

hiq-editor upr-import \
  --file-path /absolute/path/UPR.xlsx \
  --datasource GBA \
  --product-category-code 4912 \
  --json

hiq-editor process-trial-calculate --process-id <id> --json
hiq-editor process-submit-review --process-id <id> --json
```

The stable domain surface is:

| Command | Aggregated behavior |
|---|---|
| `datasources-list` | Resolve SSO identity and list tenant datasources. |
| `processes-list` | Resolve datasource and query personal or tenant workspace. |
| `process-show` | Combine base info, management info, cores, and all item cards. |
| `flows-search` | Normalize native flow results into stable id/type/unit fields. |
| `product-categories-search` | Search CPC rows and read each category back to verify its code. |
| `upr-preflight` | Read-only workbook/datasource/identity preflight; reports resources that `upr-import` will create and never writes any Editor resource. |
| `upr-import` | Parse workbook, derive canonical process name, ensure tenant data-item identities and the reference product flow, import through the native API, require its committed `processId`, and read that process back. |
| `process-trial-calculate` | Validate current process, run check + calculation, and poll readback until calculated. |
| `process-submit-review` | Require calculated state, submit review, and confirm workflow state. |

`call <command> --stdin` is available for trusted subprocess hosts that already
have a typed wrapper. It only accepts the nine commands above; there is no
arbitrary URL, SQL, or tool-name escape hatch.

Before importing, `upr-import` resolves every process-row data-item name with the
tenant-scoped exact-match API. Missing items are created through the Editor's native
data-item endpoint and then read back; duplicate names, unconfirmed creation, or an
import readback with a blank `elementId` stop the command. This keeps catalog writes
behind the fixed command instead of exposing them as an agent-controlled primitive.

`upr-import` fails closed unless the native import response contains
`data.processId`. It never infers a new dataset from names, timestamps, or a
workspace diff, so concurrent same-name imports cannot be confused.

## Machine contract

Global `--json` writes one envelope to stdout:

```json
{"ok":true,"command":"process_show","text":"...","data":{"process":{"id":"..."}}}
```

Errors are written to stderr:

```json
{"ok":false,"kind":"validation","code":null,"message":"..."}
```

Exit codes: `0` success, `2` configuration/authentication, `3` validation,
`4` upstream contract failure, `5` transport failure, `1` unknown failure.

## MCP adapter

`hiq-editor-mcp` is an optional local adapter. It exposes the same eight command
schemas and calls the same local implementations. It does not connect to the
remote `/mcp/editor` endpoint and cannot expose arbitrary server tools.

```json
{
  "mcpServers": {
    "editor": {
      "command": "npx",
      "args": ["-y", "-p", "@hiq-ai/hiq-editor", "hiq-editor-mcp"],
      "env": { "HIQ_EDITOR_API_KEY": "<HiQ-issued key>" }
    }
  }
}
```

## Development

```bash
npm install
npm test
npm run build
npm run build:bin
```

The version lives in `package.json`; `prebuild` stamps it into
`src/version.ts` for single-file binaries.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
