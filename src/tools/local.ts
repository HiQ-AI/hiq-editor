/**
 * Local-only tools — the reason this gateway exists alongside the remote MCP
 * endpoint. These run on the local filesystem instead of forwarding:
 *
 *   import_upr_from_file — read a filled UPR .xlsx template and import the whole
 *                          workbook server-side in one transactional call.
 *   export_process       — fetch a process's detail from the server and write it
 *                          to a local file.
 *
 * Each tool is declared with an explicit JSON Schema inputSchema (NOT zod): the
 * low-level MCP Server returns raw inputSchema in tools/list, and the remote
 * tools are already JSON-schema, so the local tools match that shape.
 */

import { readBytes, writeText, requireAbsolute } from "../files.js";

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface LocalToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<Array<{ type: "text"; text: string }>>;
}

/** Flatten a remote callTool result's content to a text string. */
function contentToText(result: unknown): string {
  const raw =
    result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  const content = Array.isArray(raw) ? raw : [];
  return content
    .map((c) =>
      c && typeof c === "object" && "text" in c
        ? String((c as { text: unknown }).text)
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export const importUprFromFile: LocalToolDef = {
  name: "import_upr_from_file",
  description:
    "LOCAL. Import a whole UPR workbook (the official .xlsx template, filled in) from a " +
    "local file in ONE call — creates the dataset (omit process_id) or appends 工序 sheets " +
    "to an existing one. The server parses all sheets, sets the reference product itself, " +
    "and rejects the whole file on any parse error (nothing half-written). This is the " +
    "primary path whenever a filled template exists; use create_process_tool + " +
    "add_exchange_tool only for non-template data or incremental edits. " +
    "file_path must be absolute.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the filled UPR .xlsx." },
      datasource: { type: "string", description: "Datasource name (e.g. 'GBA')." },
      process_id: {
        type: "string",
        description: "Append to this existing process instead of creating a new dataset.",
      },
      need_desensitize: {
        type: "boolean",
        description: "Run the desensitization scan after import (default false).",
      },
    },
    required: ["file_path", "datasource"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const filePath = requireAbsolute("file_path", String(args.file_path ?? ""));
    const bytes = await readBytes(filePath);
    const { callRemoteTool } = await import("../serverClient.js");
    const result = await callRemoteTool("import_upr_xlsx_tool", {
      datasource: String(args.datasource ?? ""),
      file_base64: bytes.toString("base64"),
      file_name: filePath.split("/").pop() ?? "upr.xlsx",
      ...(args.process_id ? { process_id: String(args.process_id) } : {}),
      ...(args.need_desensitize === true ? { need_desensitize: true } : {}),
    });
    if ((result as { isError?: boolean }).isError) {
      throw new Error(contentToText(result));
    }
    return [{ type: "text", text: contentToText(result) }];
  },
};

export const exportProcess: LocalToolDef = {
  name: "export_process",
  description:
    "LOCAL. Fetch a process's full detail from the server (get_process_detail_tool) " +
    "and write it to a local file. Use to archive or hand off a dataset. out_path must " +
    "be absolute.",
  inputSchema: {
    type: "object",
    properties: {
      process_id: { type: "string", description: "Process ID to export." },
      out_path: {
        type: "string",
        description: "Absolute path of the local file to write.",
      },
    },
    required: ["process_id", "out_path"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const processId = String(args.process_id ?? "");
    const outPath = requireAbsolute("out_path", String(args.out_path ?? ""));
    const { callRemoteTool } = await import("../serverClient.js");
    const result = await callRemoteTool("get_process_detail_tool", {
      process_id: processId,
    });
    const detail = contentToText(result);
    await writeText(outPath, detail);
    return [
      {
        type: "text",
        text: `Wrote process ${processId} detail (${detail.length} chars) to ${outPath}`,
      },
    ];
  },
};

export const localTools: LocalToolDef[] = [importUprFromFile, exportProcess];
