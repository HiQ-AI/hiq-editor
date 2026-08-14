/** Package version, single-sourced from package.json (dist/ is one level below the package root). */
import { readFileSync } from "node:fs";

export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;
