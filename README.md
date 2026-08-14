# @hiq-ai/hiq-editor-mcp

Open local stdio [MCP](https://modelcontextprotocol.io) **gateway** for the
**HiQ LCA dataset editor**. It runs on the host machine (Cortex Desktop / Claude
Code spawns it over stdio), connects to the editor server's MCP endpoint
(Streamable HTTP) as an MCP client, **dynamically re-exposes the server's tools**
over stdio, and adds **local file capabilities** — parsing UPR `.xlsx` templates
and exporting process detail to disk — that a remote server cannot do.

Apache-2.0. The proprietary parts (database schema, SQL, write/business logic,
SSO internals) live in a separate closed server; this gateway only knows the
server's MCP endpoint URL and forwards the caller's SSO token to it.

## Architecture

```
┌──────────────────────────────────────┐  HTTPS   ┌────────────────────────────┐
│  @hiq-ai/hiq-editor-mcp  (this, open) │  + SSO   │  editor server  (closed)   │
│  • stdio MCP server (gateway)         │ ───────> │  • /mcp/editor             │
│  • re-exposes remote tools 1:1        │  token   │    (Streamable HTTP MCP)   │
│  • LOCAL: parse_upr_template,         │ <─────── │  • SQL reads + writes + SSO│
│           export_process              │  result  │                            │
└──────────────────────────────────────┘          └────────────────────────────┘
```

The gateway connects to the server's single `/mcp/editor` Streamable-HTTP
endpoint as an MCP client (Bearer SSO token). On `tools/list` it returns the
remote server's tools verbatim (names, descriptions, and JSON schemas straight
from the server — no duplication) plus the 2 local tools. On `tools/call` it
runs the 2 local tools locally and passes every other call through to the remote
endpoint, relaying the result content. This eliminates schema duplication and
reuses the server's existing MCP endpoint.

## Connecting — two ways

The editor server exposes one Streamable-HTTP MCP endpoint
(`https://x.hiqlcd.com/mcp/editor`). You can reach it **directly** or **through
this gateway** — pick based on whether you need local file tools.

### A. Remote HTTP MCP — direct, no install

Any host that supports remote (Streamable HTTP) MCP can connect to the endpoint
directly with a HiQ-issued **API key**. Zero install, but you get only the
server's business tools — **not** the local file tools (`parse_upr_template` /
`export_process`), which need a process on your machine.

```bash
# e.g. Claude Code
claude mcp add --transport http editor https://x.hiqlcd.com/mcp/editor \
  --header "X-API-Key: <your HiQ API key>"
```

Request an API key from HiQ. (Cortex Desktop users don't need one — it uses the
gateway below with the signed-in session.)

### B. Local stdio gateway — this package

Spawn it over stdio from your MCP host (Cortex Desktop, Claude Code, …). It adds
the local file tools and handles authentication for you (it forwards the SSO
token the host supplies) — so the host config only needs the token:

```jsonc
{
  "mcpServers": {
    "editor": {
      "command": "npx",
      "args": ["-y", "@hiq-ai/hiq-editor-mcp"],
      "env": {
        "HIQ_EDITOR_TOKEN": "<your SSO token>"
      }
    }
  }
}
```

`HIQ_EDITOR_SERVER_URL` overrides the endpoint (defaults to
`https://x.hiqlcd.com/mcp/editor`).

## Authentication

The only credential is the **SSO token**, supplied by the host through the
`HIQ_EDITOR_TOKEN` environment variable (there is no `login` tool). The client
forwards it verbatim as `Authorization: Bearer <token>`; the server resolves the
user and tenant from it. The token is never written to disk or logs.

## Tool surface

### Business tools (re-exposed from the editor server)

These come straight from the server's MCP endpoint — the gateway returns them
verbatim, so the live list is whatever the server publishes. At time of writing:

Reads:

| Tool | What it does |
|---|---|
| `list_datasources` | List available datasources for the current user. |
| `list_my_processes` | List processes in my workspace (paginated). |
| `list_all_processes` | List all processes in the datasource (admin view). |
| `get_process_detail_tool` | Full process detail (basic info, units, data items, exchanges). |
| `get_process_status_tool` | Workflow status (approvals, calc tasks, releases). |
| `search_flows_tool` | Search flows (ELEMENTARY_FLOW / PRODUCT_FLOW / WASTE_FLOW). |
| `search_backgrounds_tool` | Search the background dataset catalog. |
| `list_calculations` | View calculation tasks and status. |
| `list_versions` | View database versions and release status. |

Writes:

| Tool | What it does |
|---|---|
| `create_process_tool` | Create a new unit process dataset (UPR). |
| `add_exchange_tool` | Add a data item (exchange) to a process. |
| `update_exchange_tool` | Update a data item's value / unit / formula. |
| `match_background_tool` | Match a data item to a background database process. |
| `submit_review_tool` | Submit a process for expert review. |
| `calculate_process_tool` | Run trial calculation (试算) for one process. |
| `run_batch_calculation_tool` | Create a version-level batch calculation task. |

### Local tools (run on the host filesystem)

| Tool | What it does |
|---|---|
| `parse_upr_template` | Read a local UPR `.xlsx`, extract 基本信息 fields + data-item rows to drive `create_process_tool` + `add_exchange_tool`. |
| `export_process` | Fetch a process's detail and write it to a local file. |

Both local tools require **absolute** file paths.

## CLI

The `hiq-editor` binary (shipped by this package — select it with `npx -p`)
turns every gateway tool into a real subcommand. Subcommands and their flags
are generated at runtime from the server's tool catalog (input JSON Schema →
options), so there is no client-side schema copy to drift: required props are
required flags, enums become choices, object/array props take JSON values.
Names are the native tool names minus the `_tool` suffix, kebab-cased.

```bash
export HIQ_EDITOR_TOKEN=<your SSO token>

npx -p @hiq-ai/hiq-editor-mcp hiq-editor list          # tool catalog (--json for schemas)
npx -p @hiq-ai/hiq-editor-mcp hiq-editor describe add-exchange
npx -p @hiq-ai/hiq-editor-mcp hiq-editor add-exchange --help   # per-command flags

npx -p @hiq-ai/hiq-editor-mcp hiq-editor search-flows --keyword 铝锭 --flow-type PRODUCT_FLOW
npx -p @hiq-ai/hiq-editor-mcp hiq-editor get-process-detail --process-id 12345
npx -p @hiq-ai/hiq-editor-mcp hiq-editor add-exchange --process-id 12345 \
  --category RAW_MATERIAL --value 0.8 --material-name 木浆 \
  --background '{"up_element_id":"…","up_element_uuid":"…","up_element_name":"…","data_source":"HiQLCD","data_version":"1.4.0"}'
npx -p @hiq-ai/hiq-editor-mcp hiq-editor parse-upr-template --file-path /abs/path/UPR.xlsx
```

The raw escape hatch remains: `call <native_tool_name> --args '<json>'`
(`--args` defaults to `{}`).

### `import` — whole-UPR batch import

`hiq-editor import <plan.json>` runs the complete authoring sequence — create
process → reference product → exchanges → optional trial calc (`--calc`) — as
one command with checkpoint/resume: after every successful write it updates
`<plan>.state.json`, so a failed run re-runs with the same command and resumes
where it stopped (the state file is removed on full success).

Plan fields map 1:1 onto the tool args (`process` = `create_process_tool` args,
each entry of `exchanges` = `add_exchange_tool` args minus `process_id`):

```jsonc
{
  "process":           { "name": "...", "datasource": "...", "middle_flow_id": "...", /* … */ },
  "reference_product": { "value": 1, "declared_unit_id": "..." },   // flow_id defaults to process.middle_flow_id
  "exchanges": [
    { "category": "RAW_MATERIAL", "value": 0.8, "material_name": "木浆",
      "background": { "up_element_id": "...", "up_element_uuid": "...", "up_element_name": "...",
                      "data_source": "HiQLCD", "data_version": "1.4.0" } },
    { "category": "AIR_EMISSION", "value": 0.1, "flow_id": "..." }
  ],
  "calculate": false
}
```

Resolving a 背景数据唯一ID into the `background` tuple (and picking a version) is
the caller's decision — run `call search_backgrounds_tool` first and put the
resolved tuple in the plan; empty or partial tuples are rejected up front.
`--dry-run` validates the plan and prints the step list without writing;
`--process-id <id>` attaches to an existing process instead of creating one.

## Development

```bash
npm install
npm run build     # tsc → dist/
npm run dev       # stdio MCP server via tsx
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
