/**
 * Local-only tools — the reason this gateway exists alongside the remote MCP
 * endpoint. These run on the local filesystem instead of forwarding:
 *
 *   parse_upr_template — read a local UPR .xlsx and surface its 基本信息 fields +
 *                        data-item rows so the agent can drive create_process_tool
 *                        + add_exchange_tool.
 *   export_process     — fetch a process's detail from the server and write it to
 *                        a local file.
 *
 * Each tool is declared with an explicit JSON Schema inputSchema (NOT zod): the
 * low-level MCP Server returns raw inputSchema in tools/list, and the remote
 * tools are already JSON-schema, so the two local tools match that shape.
 */

import type * as XLSXNS from "xlsx";

// Heavy deps are lazy-loaded inside handlers so `hiq-editor version`/`--help`
// and non-file commands don't pay their startup cost (xlsx alone is ~1MB).
async function loadXlsx(): Promise<typeof XLSXNS> {
  return import("xlsx");
}
import { readBytes, writeText, requireAbsolute } from "../files.js";

/** A JSON-Schema object describing a tool's arguments. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** MCP content block returned by a tool. */
export interface ContentBlock {
  type: "text";
  text: string;
}

/** One local tool's definition: name + description + JSON-schema + handler. */
export interface LocalToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<ContentBlock[]>;
}

const BASIC_INFO_SHEET = "基本信息";
/** Sheet names that hold a header-row + data-item-rows table. */
const DATA_ITEM_SHEETS = ["P-工序"];

/** A 基本信息 row is [字段名, 值, 备注, 是否必填]. Keep filled ones. */
interface BasicInfoField {
  field: string;
  value: string;
  required: boolean;
  note?: string;
}


function sheetRows(XLSX: typeof XLSXNS, wb: XLSXNS.WorkBook, name: string): unknown[][] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
}

function cell(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function parseBasicInfo(XLSX: typeof XLSXNS, wb: XLSXNS.WorkBook): BasicInfoField[] {
  const rows = sheetRows(XLSX, wb, BASIC_INFO_SHEET);
  const out: BasicInfoField[] = [];
  // Row 0 is the header (字段名/值/备注/是否必填). Data starts at row 1.
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const field = cell(r[0]);
    const value = cell(r[1]);
    if (!field) continue;
    const note = cell(r[2]);
    const required = cell(r[3]) === "是";
    out.push({ field, value, required, ...(note ? { note } : {}) });
  }
  return out;
}

/** Map a data-item sheet into { headers, rows } where rows are header→value objects. */
function parseDataItems(XLSX: typeof XLSXNS, wb: XLSXNS.WorkBook, name: string): {
  sheet: string;
  headers: string[];
  rows: Record<string, string>[];
} {
  const raw = sheetRows(XLSX, wb, name);
  if (raw.length === 0) return { sheet: name, headers: [], rows: [] };
  const headers = (raw[0] ?? []).map(cell);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i] ?? [];
    const obj: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((h, idx) => {
      const v = cell(r[idx]);
      if (h) obj[h] = v;
      if (v) hasValue = true;
    });
    if (hasValue) rows.push(obj);
  }
  return { sheet: name, headers, rows };
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

export const parseUprTemplate: LocalToolDef = {
  name: "parse_upr_template",
  description:
    "LOCAL. Read a local UPR (unit process) .xlsx template and extract its 基本信息 " +
    "fields and data-item rows so you can drive create_process_tool + add_exchange_tool. " +
    "Returns the basic-info key/values (with required flags) and, for each data-item " +
    "sheet, the column headers + non-empty rows verbatim — map the columns to tool args " +
    "yourself (背景数据唯一ID → search_backgrounds_tool, etc.). file_path must be absolute.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the local UPR .xlsx template.",
      },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const filePath = requireAbsolute("file_path", String(args.file_path ?? ""));
    const bytes = await readBytes(filePath);
    const XLSX = await loadXlsx();
    const wb = XLSX.read(bytes, { type: "buffer" });

    const basicInfo = parseBasicInfo(XLSX, wb);
    const dataItemSheets = DATA_ITEM_SHEETS.filter((s) => wb.SheetNames.includes(s)).map(
      (s) => parseDataItems(XLSX, wb, s),
    );

    const summary = {
      file: filePath,
      sheets: wb.SheetNames,
      basic_info: basicInfo,
      data_items: dataItemSheets,
    };
    return [{ type: "text", text: JSON.stringify(summary, null, 2) }];
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

export const localTools: LocalToolDef[] = [parseUprTemplate, exportProcess];
