/** Filesystem validation for commands that consume local artifacts. */

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { EditorClientError } from "./types.js";

/** Require an absolute path so a command never depends on the caller's cwd. */
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
