/**
 * Local filesystem helpers for the local-only tools (import_upr_from_file,
 * export_process). This client always runs over stdio on a host with a real
 * filesystem, so paths are read/written directly — no base64 transport like
 * jimu-lca's Worker needs.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { EditorClientError } from "./types.js";

/** Require an absolute path — a minimal gate so a tool never writes to cwd by accident. */
export function requireAbsolute(label: string, p: string): string {
  if (!p || !isAbsolute(p)) {
    throw new EditorClientError(
      "validation",
      `${label} must be an absolute path (got: ${p || "empty"}).`,
    );
  }
  return p;
}

/** Read a local file as bytes. */
export async function readBytes(filePath: string): Promise<Buffer> {
  requireAbsolute("file_path", filePath);
  try {
    return await readFile(filePath);
  } catch (err) {
    throw new EditorClientError(
      "validation",
      `could not read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Write text to a local file. */
export async function writeText(outPath: string, text: string): Promise<void> {
  requireAbsolute("out_path", outPath);
  try {
    await writeFile(outPath, text, "utf8");
  } catch (err) {
    throw new EditorClientError(
      "validation",
      `could not write file ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
