#!/usr/bin/env node
/**
 * Stdio MCP gateway entry. What `npx -p @hiq-ai/hiq-editor hiq-editor-mcp` runs.
 *
 * This is a gateway, not a forwarder: it connects to the editor server's
 * Streamable-HTTP MCP endpoint (HIQ_EDITOR_SERVER_URL, e.g.
 * https://x.hiqlcd.com/mcp/editor) as an MCP client and dynamically re-exposes
 * the server's tools over stdio, plus 2 local filesystem tools
 * (parse_upr_template, export_process). The host (Cortex Desktop / Claude Code)
 * spawns this and supplies HIQ_EDITOR_SERVER_URL + HIQ_EDITOR_TOKEN in the env.
 *
 * Uses the LOW-LEVEL Server with two request handlers so remote tool schemas
 * pass through verbatim — no schema conversion, no duplication.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { localToolDefs } from "./tools/index.js";
import { listRemoteTools, callRemoteTool } from "./serverClient.js";
import { config } from "./config.js";
import { EditorClientError } from "./types.js";

const VERSION = "0.1.0";

const localByName = new Map(localToolDefs.map((t) => [t.name, t]));

function errorText(err: unknown): string {
  return err instanceof EditorClientError
    ? `[${err.kind}${err.code ? `:${err.code}` : ""}] ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
}

async function main(): Promise<void> {
  process.stderr.write(
    `hiq-editor-mcp ${VERSION} gateway starting (endpoint=${config.serverUrl}, local_tools=${localToolDefs.length}, token=${config.token ? "set" : "MISSING"})\n`,
  );

  const server = new Server(
    { name: "hiq-editor", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const localToolEntries = localToolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    // If the remote is unreachable, still serve the local tools — surface the
    // remote error to stderr instead of crashing.
    let remoteTools: Awaited<ReturnType<typeof listRemoteTools>> = [];
    try {
      remoteTools = await listRemoteTools();
    } catch (err) {
      process.stderr.write(`listRemoteTools failed: ${errorText(err)}\n`);
    }

    return { tools: [...remoteTools, ...localToolEntries] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const local = localByName.get(name);
      if (local) {
        const content = await local.handler(args as Record<string, unknown>);
        return { content };
      }
      const result = await callRemoteTool(name, args as Record<string, unknown>);
      return result;
    } catch (err) {
      const msg = errorText(err);
      process.stderr.write(`tool ${name} failed: ${msg}\n`);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown — the host sends SIGTERM on cleanup.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await server.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[fatal] ${msg}\n`);
  process.exit(err instanceof EditorClientError && err.kind === "config" ? 2 : 1);
});
