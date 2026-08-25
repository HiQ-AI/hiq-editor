#!/usr/bin/env node
/** Optional stdio MCP adapter over the same stable CLI domain commands. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { commandCatalog, executeCommand } from "./commands.js";
import { config } from "./config.js";
import { EditorClientError } from "./types.js";
import { VERSION } from "./version.js";

function errorText(error: unknown): string {
  return error instanceof EditorClientError
    ? `[${error.kind}${error.code ? `:${error.code}` : ""}] ${error.message}`
    : error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  process.stderr.write(
    `hiq-editor-mcp ${VERSION} starting (native_api=${config.apiUrl}, commands=${commandCatalog().length}, credential=${config.credential?.kind ?? "MISSING"})\n`,
  );
  const server = new Server({ name: "hiq-editor", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: commandCatalog().map((command) => ({
      name: command.name,
      description: command.description,
      inputSchema: command.inputSchema,
      annotations: {
        readOnlyHint: command.readOnly,
        destructiveHint: !command.readOnly,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const result = await executeCommand(name, args);
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.data,
      };
    } catch (error) {
      const message = errorText(error);
      process.stderr.write(`command ${name} failed: ${message}\n`);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await server.close();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  process.stderr.write(`[fatal] ${errorText(error)}\n`);
  process.exit(error instanceof EditorClientError && error.kind === "config" ? 2 : 1);
});
